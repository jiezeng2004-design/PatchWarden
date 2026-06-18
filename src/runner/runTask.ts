import { execSync, spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
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
export function runTask(taskId: string): TaskRunResult {
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
  const rawRepoPath: string = statusData.repo_path || wsRoot;
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

    // ── Phase 4: Execute ──
    const result = spawnSync(agentCmd.command, resolvedArgs, {
      cwd: repoPath,
      timeout: 600_000, // 10 minutes
      maxBuffer: 10 * 1024 * 1024,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdout = result.stdout || "";
    const stderr = result.stderr || "";
    const exitCode = result.status ?? 1;

    // ── Phase 5: Collect outputs ──
    const gitDiff = captureGitDiff(repoPath);
    const testLog = captureTestLog(repoPath, testCommand);
    const resultMd = buildResultMarkdown(
      taskId,
      planId,
      agentName,
      exitCode,
      stdout,
      stderr
    );

    writeFileSync(join(taskDir, "git.diff"), gitDiff, "utf-8");
    writeFileSync(join(taskDir, "test.log"), testLog, "utf-8");
    writeFileSync(join(taskDir, "result.md"), resultMd, "utf-8");

    // ── Phase 6: Update status ──
    if (exitCode === 0) {
      updateStatus(taskDir, "done");
      return { task_id: taskId, status: "done", error: null };
    } else {
      const errMsg = `Agent exited with code ${exitCode}\nStderr: ${stderr.slice(0, 1000)}`;
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
    const cmd = parts[0];
    const args = parts.slice(1);

    const result = spawnSync(cmd, args, {
      cwd: repoPath,
      encoding: "utf-8",
      timeout: 120_000,
      maxBuffer: 5 * 1024 * 1024,
    });

    return [
      `$ ${testCommand}`,
      `Exit code: ${result.status}`,
      "",
      result.stdout || "(no output)",
      result.stderr ? `\nSTDERR:\n${result.stderr}` : "",
    ].join("\n");
  } catch (err) {
    return `Test command failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function buildResultMarkdown(
  taskId: string,
  planId: string,
  agent: string,
  exitCode: number | null,
  stdout: string,
  stderr: string
): string {
  return [
    "# Execution Result",
    "",
    `- **Task**: ${taskId}`,
    `- **Plan**: ${planId}`,
    `- **Agent**: ${agent}`,
    `- **Exit Code**: ${exitCode}`,
    `- **Completed**: ${new Date().toISOString()}`,
    "",
    "## stdout",
    "",
    "```",
    stdout.slice(0, 50000),
    "```",
    "",
    stderr
      ? ["## stderr", "", "```", stderr.slice(0, 10000), "```"].join("\n")
      : "## stderr\n\n(empty)",
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
