import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  readFileSync,
  writeFileSync,
  type WriteStream,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { getTasksDir, getPlansDir, getConfig, resolveWorkspaceRoot } from "../config.js";
import { guardPath, guardWorkspacePath } from "../security/pathGuard.js";
import {
  guardAgentCommand,
  guardTestCommand,
  sanitizePromptArg,
} from "../security/commandGuard.js";
import { writeTaskProgress } from "../taskProgress.js";
import { writeTaskRuntime } from "../taskRuntime.js";
import type { TaskPhase, TaskStatus } from "../tools/createTask.js";
import {
  buildChangeArtifacts,
  captureRepoSnapshot,
  compareSnapshots,
  writeSnapshot,
  type ChangedFile,
  type ChangeArtifacts,
} from "./changeCapture.js";

const HEARTBEAT_INTERVAL_MS = 2000;
const GRACEFUL_KILL_MS = 2000;
const MAX_CAPTURE_CHARS = 100_000;

interface TaskRunResult {
  task_id: string;
  status: TaskStatus;
  error: string | null;
}

type TerminationReason = "canceled" | "killed" | "timeout" | null;

interface ManagedProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  spawnError: string | null;
  terminationReason: TerminationReason;
}

interface TestExecutionResult extends ManagedProcessResult {
  command: string;
  cwd: string;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  skipped?: boolean;
}

interface VerifyCommandRecord {
  command: string;
  cwd: string;
  exit_code: number | null;
  stdout_tail: string;
  stderr_tail: string;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  status: "passed" | "failed" | "canceled" | "timed_out";
}

interface VerifyReport {
  status: "passed" | "failed" | "skipped";
  requested_commands: string[];
  commands: VerifyCommandRecord[];
  failure_reason?: string;
}

export async function runTask(taskId: string): Promise<TaskRunResult> {
  const config = getConfig();
  const tasksDir = getTasksDir(config);
  const plansDir = getPlansDir(config);
  const wsRoot = resolveWorkspaceRoot(config);
  const taskDir = resolve(tasksDir, taskId);
  guardPath(taskDir, wsRoot, config.tasksDir);

  const statusFile = join(taskDir, "status.json");
  if (!existsSync(statusFile)) throw new Error(`Task not found: "${taskId}"`);

  const initialStatus = readStatus(statusFile);
  const planId = String(initialStatus.plan_id || "");
  const agentName = String(initialStatus.agent || "");
  const rawRepoPath = String(initialStatus.resolved_repo_path || initialStatus.repo_path || wsRoot);
  const testCommand = String(initialStatus.test_command || "");
  const changePolicy = String(initialStatus.change_policy || "repo_scoped_changes");
  let verifyCommands: string[];
  let timeoutSeconds: number;
  try {
    verifyCommands = normalizeVerifyCommands(initialStatus.verify_commands, testCommand, config);
    timeoutSeconds = normalizeTimeout(initialStatus.timeout_seconds, config);
  } catch (error) {
    return failBeforeExecution(taskId, taskDir, errorMessage(error));
  }
  const startedAtMs = Date.now();
  const deadlineMs = startedAtMs + timeoutSeconds * 1000;

  let repoPath: string;
  try {
    repoPath = guardWorkspacePath(rawRepoPath, wsRoot);
  } catch (error) {
    const message = `repo_path validation failed: ${errorMessage(error)}`;
    return failBeforeExecution(taskId, taskDir, message);
  }

  updateStatus(taskDir, {
    status: "running",
    phase: "preparing",
    started_at: new Date(startedAtMs).toISOString(),
    last_heartbeat_at: new Date().toISOString(),
    timeout_seconds: timeoutSeconds,
    current_command: null,
    error: null,
  });
  setTaskPhase(taskDir, "preparing", null, "Capturing pre-task repository state.");

  let beforeSnapshot;
  let beforeWorkspaceSnapshot;
  try {
    beforeSnapshot = captureRepoSnapshot(repoPath);
    beforeWorkspaceSnapshot = repoPath === wsRoot ? beforeSnapshot : captureRepoSnapshot(wsRoot);
    writeSnapshot(taskDir, "git-before.json", beforeSnapshot);
    writeSnapshot(taskDir, "workspace-before.json", beforeWorkspaceSnapshot);
  } catch (error) {
    const message = `Pre-task snapshot failed: ${errorMessage(error)}`;
    return failBeforeExecution(taskId, taskDir, message);
  }

  let agentResult: ManagedProcessResult | null = null;
  let testResult: TestExecutionResult = skippedTest(testCommand, repoPath, "Agent did not complete successfully.");
  const verifyResults: TestExecutionResult[] = [];
  let finalStatus: TaskStatus = "failed";
  let finalError: string | null = null;

  try {
    const planFile = resolve(plansDir, planId, "plan.md");
    if (!existsSync(planFile)) throw new Error(`Plan not found: "${planId}". Save the plan first.`);
    const planContent = readFileSync(planFile, "utf-8");
    const agentCmd = guardAgentCommand(agentName, config);
    const prompt = sanitizePromptArg(buildExecutionPrompt(planContent, repoPath, testCommand));
    const resolvedArgs = agentCmd.args.map((arg) => {
      if (arg === "{repo}") return repoPath;
      if (arg === "{prompt}") return prompt;
      return arg;
    });
    const agentCommandLabel = `${basename(agentCmd.command)} (configured agent command)`;

    setTaskPhase(taskDir, "executing_agent", agentCommandLabel);
    agentResult = await runManagedProcess({
      command: agentCmd.command,
      args: resolvedArgs,
      cwd: repoPath,
      taskDir,
      statusFile,
      phase: "executing_agent",
      currentCommand: agentCommandLabel,
      deadlineMs,
      stdoutPath: join(taskDir, "stdout.log"),
      stderrPath: join(taskDir, "stderr.log"),
    });

    if (agentResult.terminationReason === "canceled" || agentResult.terminationReason === "killed") {
      finalStatus = "canceled";
      finalError = agentResult.terminationReason === "killed"
        ? "Task was terminated by kill_task."
        : "Task was canceled by user request.";
    } else if (agentResult.terminationReason === "timeout") {
      finalError = `Task timed out after ${timeoutSeconds} seconds during agent execution.`;
    } else if (agentResult.spawnError) {
      finalError = `Agent spawn failed: ${agentResult.spawnError}`;
    } else if (agentResult.exitCode !== 0) {
      finalError = `Agent exited with code ${agentResult.exitCode}.`;
    } else if (verifyCommands.length > 0) {
      for (const command of verifyCommands) {
        setTaskPhase(taskDir, "running_tests", command);
        const verification = await runTrustedTestCommand(command, repoPath, taskDir, statusFile, deadlineMs);
        verifyResults.push(verification);
        if (verification.terminationReason || Date.now() >= deadlineMs) break;
      }
      testResult = verifyResults[0] || skippedTest(testCommand, repoPath, "No verification command ran.");
      const interrupted = verifyResults.find((result) => result.terminationReason);
      const failedVerification = verifyResults.find((result) => result.spawnError || result.exitCode !== 0);
      if (interrupted?.terminationReason === "canceled" || interrupted?.terminationReason === "killed") {
        finalStatus = "canceled";
        finalError = interrupted.terminationReason === "killed"
          ? "Task was terminated by kill_task during verification."
          : "Task was canceled during verification.";
      } else if (interrupted?.terminationReason === "timeout" || Date.now() >= deadlineMs) {
        finalError = `Task timed out after ${timeoutSeconds} seconds during verification.`;
      } else if (failedVerification) {
        finalStatus = "failed_verification";
        finalError = failedVerification.spawnError
          ? `Verification command \"${failedVerification.command}\" could not start: ${failedVerification.spawnError}`
          : `Verification command \"${failedVerification.command}\" exited with code ${failedVerification.exitCode}.`;
      } else if (verifyResults.length === verifyCommands.length) {
        finalStatus = "done";
      } else {
        finalError = "Verification did not complete all configured commands.";
      }
    } else {
      testResult = skippedTest(testCommand, repoPath, "No verification command configured.");
      finalStatus = "done";
    }
  } catch (error) {
    finalError = errorMessage(error);
  }

  setTaskPhase(taskDir, "collecting_artifacts", null, "Capturing post-task state and writing reports.");
  let changes: ChangeArtifacts;
  try {
    const afterSnapshot = captureRepoSnapshot(repoPath);
    writeSnapshot(taskDir, "git-after.json", afterSnapshot);
    changes = buildChangeArtifacts(repoPath, beforeSnapshot, afterSnapshot);
  } catch (error) {
    changes = {
      changed_files: [],
      diff: `(change capture failed: ${errorMessage(error)})\n`,
      diff_available: false,
      diff_truncated: false,
      diff_size_bytes: 0,
      additions: 0,
      deletions: 0,
      file_stats: [],
      workspace_dirty_before: beforeSnapshot.workspace_dirty,
      workspace_dirty_after: beforeSnapshot.workspace_dirty,
      patch_mode: "hash_only",
      unavailable_reason: `Change capture failed: ${errorMessage(error)}`,
    };
    finalError ||= `Change capture failed: ${errorMessage(error)}`;
    finalStatus = "failed";
  }

  let outOfScopeChanges: ChangedFile[] = [];
  try {
    const afterWorkspaceSnapshot = repoPath === wsRoot ? captureRepoSnapshot(repoPath) : captureRepoSnapshot(wsRoot);
    writeSnapshot(taskDir, "workspace-after.json", afterWorkspaceSnapshot);
    outOfScopeChanges = compareSnapshots(beforeWorkspaceSnapshot, afterWorkspaceSnapshot)
      .filter((file) =>
        !isPathInside(resolve(wsRoot, file.path), repoPath) ||
        Boolean(file.old_path && !isPathInside(resolve(wsRoot, file.old_path), repoPath))
      );
  } catch (error) {
    finalError ||= `Workspace scope capture failed: ${errorMessage(error)}`;
    if (finalStatus === "done") finalStatus = "failed";
  }

  if (outOfScopeChanges.length > 0) {
    finalStatus = "failed_scope_violation";
    finalError = `Detected ${outOfScopeChanges.length} change(s) outside resolved_repo_path.`;
    writeFileSync(join(taskDir, "rollback-plan.json"), JSON.stringify({
      task_id: taskId,
      status: "review_required",
      automatic_rollback_performed: false,
      warning: "Review ownership and concurrent edits before rollback. PatchWarden did not modify or restore these files.",
      out_of_scope_changes: outOfScopeChanges,
    }, null, 2), "utf-8");
    writeFileSync(join(taskDir, "rollback_scope_violation_plan.md"), [
      "# Scope Violation Rollback Plan",
      "",
      `Task: ${taskId}`,
      "",
      "PatchWarden did not automatically roll back any file. Review concurrent or user-owned edits before acting.",
      "",
      "## Out-of-scope files only",
      ...outOfScopeChanges.map((file) => `- ${file.change}: ${file.old_path ? `${file.old_path} -> ` : ""}${file.path}`),
      "",
    ].join("\n"), "utf-8");
  } else if (changePolicy === "no_changes" && changes.changed_files.length > 0) {
    finalStatus = "failed_policy_violation";
    finalError = `Task policy requires no repository changes, but detected ${changes.changed_files.length} change(s).`;
  }

  writeFileSync(join(taskDir, "git.diff"), changes.diff, "utf-8");
  writeFileSync(join(taskDir, "diff.patch"), changes.diff, "utf-8");
  writeFileSync(join(taskDir, "changed-files.json"), JSON.stringify(changes, null, 2), "utf-8");
  writeFileSync(join(taskDir, "file-stats.json"), JSON.stringify({
    task_id: taskId,
    additions: changes.additions,
    deletions: changes.deletions,
    files: changes.file_stats,
  }, null, 2), "utf-8");
  writeFileSync(join(taskDir, "test.log"), buildTestLog(testResult), "utf-8");
  const verifyJson = buildVerifyJson(verifyCommands, verifyResults, repoPath);
  if (outOfScopeChanges.length > 0) {
    verifyJson.status = "failed";
    verifyJson.failure_reason = "scope_violation";
  } else if (finalStatus === "failed_policy_violation") {
    verifyJson.status = "failed";
    verifyJson.failure_reason = "change_policy_violation";
  }
  writeFileSync(join(taskDir, "verify.json"), JSON.stringify(verifyJson, null, 2), "utf-8");
  writeFileSync(join(taskDir, "verify.log"), buildVerifyLog(verifyJson.commands), "utf-8");

  if (!["canceled", "done", "failed_verification", "failed_scope_violation", "failed_policy_violation"].includes(finalStatus)) finalStatus = "failed";
  const finalPhase: TaskPhase = finalStatus === "done" ? "completed" : finalStatus;
  const followup = buildFailureFollowup(finalStatus, finalError, verifyJson.commands);
  const resultMd = buildResultMarkdown({
    taskId,
    planId,
    agent: agentName,
    status: finalStatus,
    error: finalError,
    agentResult,
    testResult,
    verify: verifyJson,
    changes,
    outOfScopeChanges,
  });
  writeFileSync(join(taskDir, "result.md"), resultMd, "utf-8");
  writeFileSync(join(taskDir, "result.json"), JSON.stringify({
    task_id: taskId,
    status: finalStatus,
    agent: agentName,
    workspace_root: wsRoot,
    repo_path: initialStatus.repo_path,
    resolved_repo_path: repoPath,
    plan_source: initialStatus.plan_source || "saved",
    template: initialStatus.template || null,
    change_policy: changePolicy,
    summary: finalError || "Agent execution and configured verification completed successfully.",
    changed_files: changes.changed_files,
    out_of_scope_changes: outOfScopeChanges,
    verify_status: verifyJson.status,
    verify_commands: verifyJson.commands,
    commands_run: verifyJson.commands.map((command) => ({
      command: command.command,
      cwd: command.cwd,
      exit_code: command.exit_code,
    })),
    commands_observed: [],
    verify: verifyJson,
    artifacts: [
      "result.md", "result.json", "diff.patch", "git.diff", "test.log", "verify.log", "verify.json", "changed-files.json", "file-stats.json",
      ...(outOfScopeChanges.length > 0 ? ["rollback_scope_violation_plan.md", "rollback-plan.json"] : []),
    ],
    warnings: [
      ...beforeSnapshot.warnings,
      ...(changes.diff_truncated ? ["diff.patch was truncated; changed-files.json retains file evidence."] : []),
    ],
    errors: finalError ? [finalError] : [],
    known_issues: finalError ? [finalError] : [],
    failure_reason: followup.failure_reason,
    failed_command: followup.failed_command,
    suggested_next_action: followup.suggested_next_action,
    safe_followup_prompt: followup.safe_followup_prompt,
    next_steps: finalStatus === "done"
      ? ["Review get_task_summary and audit_task before accepting the work."]
      : ["Resolve the reported failure before accepting the work."],
  }, null, 2), "utf-8");
  if (finalError) writeFileSync(join(taskDir, "error.log"), finalError, "utf-8");

  const finishedAt = new Date().toISOString();
  updateStatus(taskDir, {
    status: finalStatus,
    phase: finalPhase,
    current_command: null,
    last_heartbeat_at: finishedAt,
    finished_at: finishedAt,
    error: finalError,
    changed_files: changes.changed_files.map(({ path, change }) => ({ path, change })),
    out_of_scope_changes: outOfScopeChanges,
    verify_status: verifyJson.status,
    verify_commands: verifyCommands,
    diff_available: changes.diff_available,
    diff_truncated: changes.diff_truncated,
    workspace_dirty_before: changes.workspace_dirty_before,
    workspace_dirty_after: changes.workspace_dirty_after,
    workspace_dirty: changes.workspace_dirty_after,
  });
  writeTaskRuntime(taskDir, {
    phase: finalPhase,
    current_command: null,
    last_heartbeat_at: finishedAt,
    runner_pid: process.pid,
    child_pid: undefined,
  });
  writeTaskProgress(taskDir, finalPhase, {
    heartbeatAt: finishedAt,
    note: finalError || `Task finished with status ${finalStatus}.`,
  });

  return { task_id: taskId, status: finalStatus, error: finalError };
}

function buildFailureFollowup(
  status: TaskStatus,
  error: string | null,
  commands: VerifyCommandRecord[]
): {
  failure_reason: string | null;
  failed_command: string | null;
  suggested_next_action: string;
  safe_followup_prompt: string | null;
} {
  const failed = commands.find((command) => command.status !== "passed");
  if (status === "done") {
    return {
      failure_reason: null,
      failed_command: null,
      suggested_next_action: "audit_task",
      safe_followup_prompt: null,
    };
  }
  if (status === "failed_verification") {
    return {
      failure_reason: error || "Independent verification failed.",
      failed_command: failed?.command || null,
      suggested_next_action: "create_followup_task",
      safe_followup_prompt: `Fix the failing verification${failed?.command ? ` (${failed.command})` : ""} inside the same repository. Do not change unrelated files, weaken checks, commit, push, or publish.`,
    };
  }
  if (status === "failed_scope_violation") {
    return {
      failure_reason: error || "Changes were detected outside resolved_repo_path.",
      failed_command: null,
      suggested_next_action: "review_scope_violation",
      safe_followup_prompt: "Review rollback_scope_violation_plan.md and prepare a backup-first recovery proposal. Do not automatically delete, reset, or restore files.",
    };
  }
  if (status === "failed_policy_violation") {
    return {
      failure_reason: error || "The task violated its no-changes policy.",
      failed_command: null,
      suggested_next_action: "review_unexpected_changes",
      safe_followup_prompt: "Inspect the unexpected repository changes and propose a backup-first recovery. Do not automatically revert or delete files.",
    };
  }
  if (status === "canceled") {
    return {
      failure_reason: error || "Task was canceled.",
      failed_command: failed?.command || null,
      suggested_next_action: "inspect_task_logs",
      safe_followup_prompt: null,
    };
  }
  return {
    failure_reason: error || "Task execution failed.",
    failed_command: failed?.command || null,
    suggested_next_action: "inspect_task_logs",
    safe_followup_prompt: "Inspect result.json, stderr.log, and verify.json, then create a narrowly scoped follow-up task inside the same repository.",
  };
}

async function runManagedProcess(options: {
  command: string;
  args: string[];
  cwd: string;
  taskDir: string;
  statusFile: string;
  phase: TaskPhase;
  currentCommand: string;
  deadlineMs: number;
  stdoutPath?: string;
  stderrPath?: string;
}): Promise<ManagedProcessResult> {
  if (Date.now() >= options.deadlineMs) {
    return { exitCode: null, stdout: "", stderr: "", spawnError: null, terminationReason: "timeout" };
  }

  let child: ChildProcess;
  try {
    child = spawn(options.command, options.args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
  } catch (error) {
    return { exitCode: null, stdout: "", stderr: "", spawnError: errorMessage(error), terminationReason: null };
  }

  const stdoutStream = openStream(options.stdoutPath);
  const stderrStream = openStream(options.stderrPath);
  let stdout = "";
  let stderr = "";
  let spawnError: string | null = null;
  let terminationReason: TerminationReason = null;
  let forceTimer: ReturnType<typeof setTimeout> | null = null;
  let terminationStarted = false;

  const heartbeat = () => {
    const now = new Date().toISOString();
    const activePhase: TaskPhase = terminationReason
      ? (terminationReason === "canceled" ? "canceling" : "terminating")
      : options.phase;
    writeTaskRuntime(options.taskDir, {
      phase: activePhase,
      last_heartbeat_at: now,
      current_command: options.currentCommand,
      runner_pid: process.pid,
      child_pid: child.pid,
    });
    writeTaskProgress(options.taskDir, activePhase, {
      heartbeatAt: now,
      currentCommand: options.currentCommand,
    });

    const control = readStatus(options.statusFile);
    if (control.force_kill_requested) requestTermination("killed", true);
    else if (control.cancel_requested) requestTermination("canceled", false);
    else if (Date.now() >= options.deadlineMs) requestTermination("timeout", true);
  };

  const requestTermination = (reason: Exclude<TerminationReason, null>, force: boolean) => {
    if (terminationStarted) return;
    terminationStarted = true;
    terminationReason = reason;
    const phase: TaskPhase = force ? "terminating" : "canceling";
    setTaskPhase(options.taskDir, phase, options.currentCommand, `${reason} requested; stopping child process.`);
    if (force) {
      forceKill(child);
    } else {
      gracefulKill(child);
      forceTimer = setTimeout(() => forceKill(child), GRACEFUL_KILL_MS);
    }
  };

  child.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf-8");
    stdout = appendBounded(stdout, text);
    stdoutStream?.write(text);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf-8");
    stderr = appendBounded(stderr, text);
    stderrStream?.write(text);
  });

  heartbeat();
  const heartbeatTimer = setInterval(heartbeat, HEARTBEAT_INTERVAL_MS);
  const exitCode = await new Promise<number | null>((resolveExit) => {
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      resolveExit(code);
    };
    child.once("close", (code) => finish(code));
    child.once("error", (error) => {
      spawnError = error.message;
      finish(null);
    });
  });

  clearInterval(heartbeatTimer);
  if (forceTimer) clearTimeout(forceTimer);
  stdoutStream?.end();
  stderrStream?.end();
  writeTaskRuntime(options.taskDir, {
    phase: options.phase,
    last_heartbeat_at: new Date().toISOString(),
    current_command: null,
    runner_pid: process.pid,
    child_pid: undefined,
  });

  return { exitCode, stdout, stderr, spawnError, terminationReason };
}

async function runTrustedTestCommand(
  testCommand: string,
  repoPath: string,
  taskDir: string,
  statusFile: string,
  deadlineMs: number
): Promise<TestExecutionResult> {
  const config = getConfig();
  const trusted = guardTestCommand(testCommand, config);
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const parts = trusted.split(/\s+/).filter(Boolean);
  let command = parts[0];
  let args = parts.slice(1);
  if (process.platform === "win32" && /^(npm|npm\.cmd|pnpm|pnpm\.cmd)$/i.test(command)) {
    const shim = /^pnpm/i.test(command) ? "pnpm.cmd" : "npm.cmd";
    command = process.env.ComSpec || "cmd.exe";
    args = ["/d", "/s", "/c", shim, ...args];
  }
  const result = await runManagedProcess({
    command,
    args,
    cwd: repoPath,
    taskDir,
    statusFile,
    phase: "running_tests",
    currentCommand: trusted,
    deadlineMs,
    stdoutPath: join(taskDir, "test.stdout.log"),
    stderrPath: join(taskDir, "test.stderr.log"),
  });
  const finishedAtMs = Date.now();
  return {
    ...result,
    command: trusted,
    cwd: repoPath,
    started_at: startedAt,
    finished_at: new Date(finishedAtMs).toISOString(),
    duration_ms: finishedAtMs - startedAtMs,
  };
}

function buildExecutionPrompt(plan: string, repoPath: string, testCommand: string): string {
  let prompt = `You are executing a pre-written plan in a local repository.

## Repository
${repoPath}

## Plan
${plan}

## Instructions
1. Read the plan carefully.
2. Implement the changes in this repository only.
3. Do NOT modify files outside this repository.
4. Do NOT commit or push changes.
5. After implementing, describe what you changed.
6. Output a summary with what was done, files modified, and issues encountered.
`;
  if (testCommand) {
    prompt += `\n7. You may run ${testCommand}; PatchWarden will independently run it again for verification.`;
  }
  return prompt;
}

function buildTestLog(result: TestExecutionResult): string {
  if (result.skipped) return `${result.command || "(no test command)"}\nExit code: not run\n${result.stderr}\n`;
  return [
    `$ ${result.command}`,
    `Exit code: ${result.exitCode}`,
    result.terminationReason ? `Termination: ${result.terminationReason}` : "",
    result.spawnError ? `Spawn error: ${result.spawnError}` : "",
    "",
    result.stdout || "(no output)",
    result.stderr ? `\nSTDERR:\n${result.stderr}` : "",
  ].filter((line) => line !== "").join("\n");
}

function buildResultMarkdown(input: {
  taskId: string;
  planId: string;
  agent: string;
  status: TaskStatus;
  error: string | null;
  agentResult: ManagedProcessResult | null;
  testResult: TestExecutionResult;
  verify: VerifyReport;
  changes: ChangeArtifacts;
  outOfScopeChanges: ChangedFile[];
}): string {
  const changed = input.changes.changed_files.length
    ? input.changes.changed_files.map((file) => `- ${file.change}: ${file.path}`).join("\n")
    : "(no task file changes detected)";
  const outOfScope = input.outOfScopeChanges.length
    ? input.outOfScopeChanges.map((file) => `- ${file.change}: ${file.old_path ? `${file.old_path} -> ` : ""}${file.path}`).join("\n")
    : "(none)";
  return [
    "# PatchWarden Task Result",
    "",
    "## Status",
    input.status,
    "",
    "## Agent",
    input.agent,
    "",
    "## Plan",
    input.planId,
    "",
    "## Completed",
    new Date().toISOString(),
    "",
    "## Files changed",
    changed,
    "",
    "## Verification",
    `- diff_available: ${input.changes.diff_available}`,
    `- diff_truncated: ${input.changes.diff_truncated}`,
    `- workspace_dirty_before: ${input.changes.workspace_dirty_before}`,
    `- workspace_dirty_after: ${input.changes.workspace_dirty_after}`,
    `- verify_status: ${input.verify.status}`,
    `- verify_commands: ${input.verify.commands.length}/${input.verify.requested_commands.length} executed`,
    `- out_of_scope_changes: ${input.outOfScopeChanges.length}`,
    "",
    "## Out-of-scope changes",
    outOfScope,
    "",
    "## Summary",
    input.error || "Agent execution and configured verification completed successfully.",
    "",
    "## Risks",
    input.status === "done"
      ? "- Review git.diff and changed-files.json before accepting the task."
      : "- Task did not complete successfully; outputs may be partial.",
    "",
    "---",
    "",
    "## Agent stdout",
    "",
    "```",
    input.agentResult?.stdout || "(no output)",
    "```",
    "",
    "## Agent stderr",
    "",
    "```",
    input.agentResult?.stderr || "(empty)",
    "```",
  ].join("\n");
}

function skippedTest(command: string, cwd: string, reason: string): TestExecutionResult {
  const now = new Date().toISOString();
  return {
    command,
    cwd,
    started_at: now,
    finished_at: now,
    duration_ms: 0,
    skipped: true,
    exitCode: null,
    stdout: "",
    stderr: reason,
    spawnError: null,
    terminationReason: null,
  };
}

function buildVerifyJson(requested: string[], results: TestExecutionResult[], cwd: string): VerifyReport {
  const commands = results.map((result): VerifyCommandRecord => ({
    command: result.command,
    cwd: result.cwd || cwd,
    exit_code: result.exitCode,
    stdout_tail: summarizeOutput(result.stdout),
    stderr_tail: summarizeOutput(result.spawnError || result.stderr),
    started_at: result.started_at,
    finished_at: result.finished_at,
    duration_ms: result.duration_ms,
    status: result.terminationReason === "timeout"
      ? "timed_out"
      : result.terminationReason
        ? "canceled"
        : result.exitCode === 0 && !result.spawnError
          ? "passed"
          : "failed",
  }));
  const status: VerifyReport["status"] = requested.length === 0
    ? "skipped"
    : commands.length === requested.length && commands.every((command) => command.status === "passed")
      ? "passed"
      : "failed";
  return { status, requested_commands: requested, commands };
}

function buildVerifyLog(commands: VerifyCommandRecord[]): string {
  if (commands.length === 0) return "Verification skipped: no verify_commands configured.\n";
  return commands.map((entry) => [
    `$ ${entry.command}`,
    `cwd: ${entry.cwd}`,
    `status: ${entry.status}`,
    `exit_code: ${entry.exit_code}`,
    `started_at: ${entry.started_at}`,
    `finished_at: ${entry.finished_at}`,
    `duration_ms: ${entry.duration_ms}`,
    "stdout:",
    entry.stdout_tail || "(empty)",
    "stderr:",
    entry.stderr_tail || "(empty)",
  ].join("\n")).join("\n\n");
}

function normalizeVerifyCommands(
  value: unknown,
  legacyTestCommand: string,
  config: ReturnType<typeof getConfig>
): string[] {
  if (value !== undefined && !Array.isArray(value)) {
    throw new Error("Invalid task verify_commands metadata; expected an array.");
  }
  return [...new Set([
    ...((value as unknown[] | undefined) || []).map((command) => guardTestCommand(String(command), config)),
    ...(legacyTestCommand ? [guardTestCommand(legacyTestCommand, config)] : []),
  ])];
}

function summarizeOutput(value: string): string {
  const trimmed = (value || "").trim();
  return trimmed.length <= 4000 ? trimmed : `${trimmed.slice(0, 4000)}\n...(truncated)`;
}

function isPathInside(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function normalizeTimeout(value: unknown, config: ReturnType<typeof getConfig>): number {
  const timeout = value == null ? config.defaultTaskTimeoutSeconds : Number(value);
  if (!Number.isInteger(timeout) || timeout <= 0 || timeout > config.maxTaskTimeoutSeconds) {
    throw new Error(`Invalid task timeout. Expected 1-${config.maxTaskTimeoutSeconds} seconds.`);
  }
  return timeout;
}

function failBeforeExecution(taskId: string, taskDir: string, message: string): TaskRunResult {
  writeFileSync(join(taskDir, "error.log"), message, "utf-8");
  const current = readStatus(join(taskDir, "status.json"));
  const now = new Date().toISOString();
  const verify: VerifyReport = {
    status: "failed",
    requested_commands: Array.isArray(current.verify_commands) ? current.verify_commands : [],
    commands: [],
  };
  writeFileSync(join(taskDir, "verify.json"), JSON.stringify(verify, null, 2), "utf-8");
  writeFileSync(join(taskDir, "verify.log"), `Verification did not run: ${message}\n`, "utf-8");
  writeFileSync(join(taskDir, "test.log"), `(not run)\nExit code: not run\n${message}\n`, "utf-8");
  writeFileSync(join(taskDir, "git.diff"), "(task failed before change capture)\n", "utf-8");
  writeFileSync(join(taskDir, "diff.patch"), "(task failed before change capture)\n", "utf-8");
  writeFileSync(join(taskDir, "file-stats.json"), JSON.stringify({
    task_id: taskId,
    additions: 0,
    deletions: 0,
    files: [],
  }, null, 2), "utf-8");
  const result = {
    task_id: taskId,
    status: "failed",
    agent: current.agent || "",
    workspace_root: current.workspace_root || "",
    repo_path: current.repo_path || "",
    resolved_repo_path: current.resolved_repo_path || "",
    summary: message,
    changed_files: [],
    out_of_scope_changes: [],
    verify_status: verify.status,
    verify_commands: verify.commands,
    commands_run: [],
    commands_observed: [],
    verify,
    artifacts: ["result.md", "result.json", "diff.patch", "git.diff", "test.log", "verify.log", "verify.json", "file-stats.json"],
    warnings: [],
    errors: [message],
    known_issues: [message],
    failure_reason: message,
    failed_command: null,
    suggested_next_action: "inspect_task_logs",
    safe_followup_prompt: "Inspect result.json and error.log, correct the task metadata or configuration, and retry without widening repository scope.",
    next_steps: ["Fix task metadata or configuration and retry the task."],
  };
  writeFileSync(join(taskDir, "result.json"), JSON.stringify(result, null, 2), "utf-8");
  writeFileSync(join(taskDir, "result.md"), `# PatchWarden Task Result\n\n## Status\nfailed\n\n## Summary\n${message}\n`, "utf-8");
  updateStatus(taskDir, {
    status: "failed",
    phase: "failed",
    error: message,
    finished_at: now,
    verify_status: "failed",
    changed_files: [],
    out_of_scope_changes: [],
  });
  writeTaskProgress(taskDir, "failed", { note: message });
  return { task_id: taskId, status: "failed", error: message };
}

function setTaskPhase(
  taskDir: string,
  phase: TaskPhase,
  currentCommand: string | null,
  note?: string
): void {
  const now = new Date().toISOString();
  updateStatus(taskDir, { phase, current_command: currentCommand, last_heartbeat_at: now });
  writeTaskRuntime(taskDir, {
    phase,
    current_command: currentCommand,
    last_heartbeat_at: now,
    runner_pid: process.pid,
  });
  writeTaskProgress(taskDir, phase, { currentCommand, heartbeatAt: now, note });
}

function updateStatus(taskDir: string, patch: Record<string, unknown>): void {
  const statusFile = join(taskDir, "status.json");
  const current = readStatus(statusFile);
  const next = { ...current, ...patch, updated_at: new Date().toISOString() };
  writeFileSync(statusFile, JSON.stringify(next, null, 2), "utf-8");
}

function readStatus(statusFile: string): Record<string, any> {
  return JSON.parse(readFileSync(statusFile, "utf-8"));
}

function gracefulKill(child: ChildProcess): void {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch {}
}

function forceKill(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") {
      const result = spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        timeout: 5000,
        windowsHide: true,
      });
      if (result.status !== 0) child.kill("SIGKILL");
    } else {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    try { child.kill("SIGKILL"); } catch {}
  }
}

function openStream(path?: string): WriteStream | null {
  return path ? createWriteStream(path, { flags: "a" }) : null;
}

function appendBounded(current: string, next: string): string {
  const combined = current + next;
  return combined.length <= MAX_CAPTURE_CHARS
    ? combined
    : combined.slice(combined.length - MAX_CAPTURE_CHARS);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
