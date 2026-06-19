import { execSync, spawn, spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, mkdirSync, createWriteStream } from "node:fs";
import { resolve, join } from "node:path";
import { getTasksDir, getPlansDir, getConfig, resolveWorkspaceRoot } from "../config.js";
import { guardPath, guardWorkspacePath } from "../security/pathGuard.js";
import {
  guardAgentCommand,
  guardTestCommand,
  sanitizePromptArg,
} from "../security/commandGuard.js";
import type { TaskStatus } from "../tools/createTask.js";

interface TaskRunResult {
  task_id: string;
  status: TaskStatus;
  error: string | null;
}

/**
 * Execute a single task.
 *
 * Flow:
 * 1. Read status.json → set status to "running"
 * 2. Read plan.md
 * 3. Build and execute the configured agent command
 * 4. Collect outputs: git diff, test log, result.md
 * 5. Update status.json
 */
export async function runTask(taskId: string): Promise<TaskRunResult> {
  const config = getConfig();
  const tasksDir = getTasksDir(config);
  const plansDir = getPlansDir(config);
  const wsRoot = resolveWorkspaceRoot(config);

  const taskDir = resolve(tasksDir, taskId);
  guardPath(taskDir, wsRoot, config.tasksDir);

  // ── Load status ──
  const statusFile = join(taskDir, "status.json");
  if (!existsSync(statusFile)) {
    throw new Error(`Task not found: "${taskId}"`);
  }

  const statusData = JSON.parse(readFileSync(statusFile, "utf-8"));

  const planId: string = statusData.plan_id;
  const agentName: string = statusData.agent;
  const rawRepoPath: string = statusData.resolved_repo_path || statusData.repo_path || wsRoot;
  const testCommand: string = statusData.test_command || "";

  // Validate repo_path is still within workspace (defense against tampered status.json)
  let repoPath: string;
  try {
    repoPath = guardWorkspacePath(rawRepoPath, wsRoot);
  } catch (err) {
    const errMsg = `repo_path validation failed: ${err instanceof Error ? err.message : String(err)}`;
    writeFileSync(join(taskDir, "error.log"), errMsg, "utf-8");
    updateStatus(taskDir, "failed", errMsg);
    return { task_id: taskId, status: "failed", error: errMsg };
  }

  // ── Phase 1: Mark running ──
  updateStatus(taskDir, "running");

  try {
    // ── Phase 2: Read plan ──
    const planDir = resolve(plansDir, planId);
    const planFile = join(planDir, "plan.md");
    if (!existsSync(planFile)) {
      throw new Error(`Plan not found: "${planId}". Save the plan first.`);
    }
    const planContent = readFileSync(planFile, "utf-8");

    // ── Phase 3: Build agent command ──
    const agentCmd = guardAgentCommand(agentName, config);
    const prompt = buildExecutionPrompt(planContent, repoPath, testCommand);
    const sanitizedPrompt = sanitizePromptArg(prompt);

    // Resolve placeholders
    const resolvedArgs = agentCmd.args.map((arg) => {
      if (arg === "{repo}") return repoPath;
      if (arg === "{prompt}") return sanitizedPrompt;
      return arg;
    });

    // ── Phase 4: Execute with spawn (streaming stdout/stderr to log files) ──
    const stdoutLog = join(taskDir, "stdout.log");
    const stderrLog = join(taskDir, "stderr.log");
    const stdoutStream = createWriteStream(stdoutLog, { flags: "a" });
    const stderrStream = createWriteStream(stderrLog, { flags: "a" });

    let agentStdout = "";
    let agentStderr = "";
    let spawnError = "";
    let exitCode: number | null = null;

    const child = spawn(agentCmd.command, resolvedArgs, {
      cwd: repoPath,
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Record child PID for cancel support
    const childPid = child.pid;
    try {
      const statusNow = JSON.parse(readFileSync(statusFile, "utf-8"));
      statusNow.child_pid = childPid;
      writeFileSync(statusFile, JSON.stringify(statusNow, null, 2), "utf-8");
    } catch {}

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      agentStdout += text;
      stdoutStream.write(text);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      agentStderr += text;
      stderrStream.write(text);
    });

    await new Promise<void>((resolveExec) => {
      child.on("close", (code) => {
        exitCode = code;
        stdoutStream.end();
        stderrStream.end();
        resolveExec();
      });

      child.on("error", (err) => {
        spawnError = err.message;
        stdoutStream.end();
        stderrStream.end();
        resolveExec();
      });
    });

    // Check for cancel_requested (set by cancel_task during execution)
    let wasCanceled = false;
    try {
      const latestStatus = JSON.parse(readFileSync(statusFile, "utf-8"));
      if (latestStatus.cancel_requested) {
        wasCanceled = true;
        exitCode = null;
      }
    } catch {}

    if (spawnError && !wasCanceled) {
      throw new Error(`Agent spawn failed: ${spawnError}`);
    }

    // ── Phase 5: Collect outputs ──
    const gitDiff = captureGitDiff(repoPath);
    const testLog = captureTestLog(repoPath, testCommand);
    const resultMd = buildResultMarkdown(
      taskId,
      planId,
      agentName,
      wasCanceled ? null : exitCode,
      agentStdout,
      agentStderr,
      wasCanceled
    );

    writeFileSync(join(taskDir, "git.diff"), gitDiff, "utf-8");
    writeFileSync(join(taskDir, "test.log"), testLog, "utf-8");
    writeFileSync(join(taskDir, "result.md"), resultMd, "utf-8");

    // ── Phase 6: Update status ──
    if (wasCanceled) {
      updateStatus(taskDir, "canceled", "Canceled by user request during execution.");
      return { task_id: taskId, status: "canceled", error: "Canceled by user request." };
    }
    if (exitCode === 0) {
      updateStatus(taskDir, "done");
      return { task_id: taskId, status: "done", error: null };
    } else {
      const errMsg = [
        `Agent exited with code ${exitCode}`,
        agentStderr ? `Stderr: ${agentStderr.slice(0, 1000)}` : "Stderr: (empty)",
        spawnError ? `Spawn error: ${spawnError}` : "",
      ].filter(Boolean).join("\n");
      writeFileSync(join(taskDir, "error.log"), errMsg, "utf-8");
      updateStatus(taskDir, "failed", errMsg);
      return { task_id: taskId, status: "failed", error: errMsg };
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    try {
      writeFileSync(join(taskDir, "error.log"), errMsg, "utf-8");
    } catch {
      // can't even write log; give up gracefully
    }
    try {
      updateStatus(taskDir, "failed", errMsg);
    } catch {
      // can't update status
    }
    return { task_id: taskId, status: "failed", error: errMsg };
  }
}

// ── Helpers ───────────────────────────────────────────────────────

function buildExecutionPrompt(
  plan: string,
  repoPath: string,
  testCommand: string
): string {
  let prompt = `You are executing a pre-written plan in a local repository.

## Repository
${repoPath}

## Plan
${plan}

## Instructions
1. Read the plan carefully.
2. Implement the changes in this repository only.
3. Do NOT modify files outside this repository.
4. After implementing, describe what you changed.
5. Output a summary with:
   - What was done
   - Files modified
   - Any issues encountered
`;

  if (testCommand) {
    prompt += `\n6. Run: ${testCommand}\n   Include the test output in your summary.`;
  }

  return prompt;
}

function captureGitDiff(repoPath: string): string {
  try {
    const result = spawnSync("git", ["diff", "--no-color"], {
      cwd: repoPath,
      encoding: "utf-8",
      timeout: 30_000,
    });
    return result.stdout || "(no changes)";
  } catch {
    return "(git diff failed)";
  }
}

function captureTestLog(repoPath: string, testCommand: string): string {
  if (!testCommand) return "(no test command configured)";

  try {
    const config = getConfig();
    guardTestCommand(testCommand, config);

    const parts = testCommand.split(" ");
    const cmd = process.platform === "win32" && parts[0] === "npm" ? "npm.cmd" : parts[0];
    const args = parts.slice(1);

    const result = spawnTrustedTestCommand(cmd, args, {
      cwd: repoPath,
      encoding: "utf-8",
      timeout: 120_000,
      maxBuffer: 5 * 1024 * 1024,
    });

    return [
      `$ ${testCommand}`,
      `Exit code: ${result.status}`,
      result.error instanceof Error ? `Spawn error: ${result.error.message}` : "",
      "",
      result.stdout || "(no output)",
      result.stderr ? `\nSTDERR:\n${result.stderr}` : "",
    ].join("\n");
  } catch (err) {
    return `Test command failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function spawnTrustedTestCommand(
  command: string,
  args: string[],
  options: Parameters<typeof spawnSync>[2]
): ReturnType<typeof spawnSync> {
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(command)) {
    return spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", command, ...args], options);
  }

  return spawnSync(command, args, options);
}

function buildResultMarkdown(
  taskId: string,
  planId: string,
  agent: string,
  exitCode: number | null,
  stdout: string,
  stderr: string,
  canceled = false
): string {
  const isCanceled = canceled || exitCode === null;
  const status = isCanceled ? "canceled" : exitCode === 0 ? "done" : "failed";
  const exitLabel = isCanceled ? "canceled (user request)" : exitCode === null ? "unknown (signal)" : String(exitCode);
  const summary = isCanceled
    ? "Task was canceled by user request during execution. Partial output may be available above."
    : exitCode === 0
      ? "Agent executed successfully."
      : `Agent exited with code ${exitLabel}.${stderr ? " See stderr for details." : ""}`;
  const risks = isCanceled
    ? "- Task was canceled — results may be incomplete."
    : exitCode !== 0
      ? "- Agent execution failed — verify git.diff and error.log"
      : "- Review git.diff to confirm only expected files were modified";

  const filesMatch = stdout.match(/(?:Files (?:modified|changed)|Modifying)[:\s]*\n?((?:\s*[-*]\s*.+\n?)+)/i);
  const filesChanged = filesMatch ? filesMatch[1].trim() : "unknown";

  return [
    "# Safe-Bifrost Task Result",
    "",
    "## Status",
    status,
    "",
    "## Agent",
    agent,
    "",
    "## Plan",
    planId,
    "",
    "## Exit Code",
    exitLabel,
    "",
    "## Completed",
    new Date().toISOString(),
    "",
    "## Files changed",
    filesChanged,
    "",
    "## Test result",
    isCanceled ? "canceled" : exitCode === 0 ? "passed" : "failed",
    "",
    "## Summary",
    summary,
    "",
    "## Risks",
    risks,
    "",
    "---",
    "",
    "## Agent stdout",
    "",
    "```",
    stdout.slice(0, 50000) || "(no output)",
    "```",
    "",
    stderr && stderr.trim()
      ? ["## Agent stderr", "", "```", stderr.slice(0, 10000), "```"].join("\n")
      : "## Agent stderr\n\n(empty)",
  ].join("\n");
}

function updateStatus(
  taskDir: string,
  status: TaskStatus,
  error: string | null = null
): void {
  const statusFile = join(taskDir, "status.json");
  const data = JSON.parse(readFileSync(statusFile, "utf-8"));
  data.status = status;
  data.updated_at = new Date().toISOString();
  if (error) data.error = error;
  writeFileSync(statusFile, JSON.stringify(data, null, 2), "utf-8");
}
