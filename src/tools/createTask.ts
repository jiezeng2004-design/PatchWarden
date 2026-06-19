import { mkdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { getTasksDir, getPlansDir, getConfig } from "../config.js";
import { guardPath, guardWorkspacePath, guardReadPath } from "../security/pathGuard.js";
import { guardTestCommand } from "../security/commandGuard.js";
import { writeTaskProgress } from "../taskProgress.js";
import { SafeBifrostError } from "../errors.js";

export type TaskStatus =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "failed_verification"
  | "failed_scope_violation"
  | "canceled";
export type TaskPhase =
  | "queued"
  | "preparing"
  | "executing_agent"
  | "running_tests"
  | "collecting_artifacts"
  | "canceling"
  | "terminating"
  | "completed"
  | "failed"
  | "failed_verification"
  | "failed_scope_violation"
  | "canceled";

export interface CreateTaskInput {
  plan_id: string;
  agent: string;
  repo_path?: string;
  test_command?: string;
  verify_commands?: string[];
  timeout_seconds?: number;
}

export interface CreateTaskOutput {
  task_id: string;
  plan_id: string;
  agent: string;
  status: TaskStatus;
  timeout_seconds: number;
  continuation_required: true;
  next_action: string;
  path: string;
}

export function createTask(input: CreateTaskInput): CreateTaskOutput {
  const config = getConfig();
  const tasksDir = getTasksDir(config);
  const plansDir = getPlansDir(config);

  if (!input.repo_path || input.repo_path.trim() === "") {
    throw new SafeBifrostError(
      "repo_path_required",
      "create_task requires an explicit repo_path; Safe-Bifrost will not default to workspaceRoot.",
      'Pass a repository path inside workspaceRoot, for example repo_path: "my-project".',
      true,
      { operation: "create_task", safe_alternative: "Pass an existing repository directory under workspaceRoot." }
    );
  }

  // Validate agent
  if (!config.agents[input.agent]) {
    throw new SafeBifrostError(
      "agent_not_configured",
      `Unknown agent "${input.agent}". Available: ${Object.keys(config.agents).join(", ")}`,
      "Call list_agents and use an available configured agent."
    );
  }

  // Validate plan exists BEFORE creating any task directory or files
  const planDir = resolve(plansDir, input.plan_id);
  const planFile = join(planDir, "plan.md");
  guardReadPath(planFile, config.workspaceRoot, config.plansDir);
  if (!existsSync(planFile)) {
    throw new Error(
      `Plan "${input.plan_id}" not found. Save a plan with save_plan first.`
    );
  }

  // Validate repo_path is within workspace
  const safeRepoPath = guardWorkspacePath(
    input.repo_path,
    config.workspaceRoot
  );
  if (!existsSync(safeRepoPath)) {
    throw new SafeBifrostError(
      "repo_path_not_found",
      `repo_path "${input.repo_path}" resolves to "${safeRepoPath}", but that path does not exist.`,
      "Create the repository directory first or pass an existing path under workspaceRoot.",
      true,
      { operation: "create_task", path: input.repo_path, resolved_repo_path: safeRepoPath, safe_alternative: "Use an existing repository directory under workspaceRoot." }
    );
  }
  if (!statSync(safeRepoPath).isDirectory()) {
    throw new SafeBifrostError(
      "repo_path_not_directory",
      `repo_path "${input.repo_path}" resolves to a file, not a directory.`,
      "Pass the repository directory instead of a file path.",
      true,
      { operation: "create_task", path: input.repo_path, resolved_repo_path: safeRepoPath, safe_alternative: "Pass the containing repository directory instead of a file." }
    );
  }

  // Validate test command — must be in allowlist, no swallowing
  let testCmd = "";
  if (input.test_command && input.test_command.trim() !== "") {
    testCmd = guardTestCommand(input.test_command, config);
    // guardTestCommand throws if not in allowedTestCommands
  }

  if (input.verify_commands !== undefined && !Array.isArray(input.verify_commands)) {
    throw new SafeBifrostError(
      "invalid_verify_commands",
      "verify_commands must be an array of allow-listed command strings.",
      "Pass an array such as [\"npm test\", \"npm run build\"]."
    );
  }
  if ((input.verify_commands?.length || 0) > 20) {
    throw new SafeBifrostError(
      "invalid_verify_commands",
      "verify_commands cannot contain more than 20 commands.",
      "Keep verification focused and use no more than 20 allow-listed commands."
    );
  }
  const verifyCommands = [...new Set([
    ...(input.verify_commands || []).map((command) => guardTestCommand(command, config)),
    ...(testCmd ? [testCmd] : []),
  ])];

  const timeoutSeconds = input.timeout_seconds ?? config.defaultTaskTimeoutSeconds;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new SafeBifrostError(
      "invalid_timeout",
      "timeout_seconds must be a positive integer",
      `Use a whole number from 1 to ${config.maxTaskTimeoutSeconds}.`
    );
  }
  if (timeoutSeconds > config.maxTaskTimeoutSeconds) {
    throw new SafeBifrostError(
      "invalid_timeout",
      `timeout_seconds cannot exceed configured maximum ${config.maxTaskTimeoutSeconds}`,
      `Use a value no greater than ${config.maxTaskTimeoutSeconds}.`
    );
  }

  const taskId = `task_${Date.now()}_${input.plan_id.replace(/^plan_/, "")}`;
  const taskDir = resolve(tasksDir, taskId);

  guardPath(taskDir, config.workspaceRoot, config.tasksDir);
  mkdirSync(taskDir, { recursive: true });

  const status: TaskStatus = "pending";
  const statusFile = join(taskDir, "status.json");
  const statusData = {
    task_id: taskId,
    plan_id: input.plan_id,
    agent: input.agent,
    workspace_root: resolve(config.workspaceRoot),
    repo_path: input.repo_path,
    resolved_repo_path: safeRepoPath,
    test_command: testCmd,
    verify_commands: verifyCommands,
    timeout_seconds: timeoutSeconds,
    status,
    phase: "queued" as TaskPhase,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    last_heartbeat_at: new Date().toISOString(),
    current_command: null as string | null,
    error: null as string | null,
  };

  writeFileSync(statusFile, JSON.stringify(statusData, null, 2), "utf-8");
  writeTaskProgress(taskDir, "queued", {
    heartbeatAt: statusData.last_heartbeat_at,
    note: `Waiting for watcher. Timeout: ${timeoutSeconds} seconds.`,
  });

  return {
    task_id: taskId,
    plan_id: input.plan_id,
    agent: input.agent,
    status,
    timeout_seconds: timeoutSeconds,
    continuation_required: true,
    next_action: `Call wait_for_task with task_id ${taskId}; keep calling it until terminal is true, then review the returned summary.`,
    path: taskDir,
  };
}
