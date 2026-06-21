import { mkdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getTasksDir, getPlansDir, getConfig } from "../config.js";
import { guardPath, guardWorkspacePath, guardReadPath } from "../security/pathGuard.js";
import { guardTestCommand } from "../security/commandGuard.js";
import { writeTaskProgress } from "../taskProgress.js";
import { PatchWardenError } from "../errors.js";
import { savePlan } from "./savePlan.js";
import {
  expandTaskTemplate,
  TASK_TEMPLATE_NAMES,
  type ChangePolicy,
  type TaskTemplateName,
} from "./taskTemplates.js";
import { PATCHWARDEN_VERSION } from "../version.js";
import { getLastToolCatalogSnapshot, resolveToolProfile } from "./toolCatalog.js";
import {
  derivePendingReason,
  readWatcherStatus,
  type PendingReason,
  type WatcherStatusSnapshot,
} from "../watcherStatus.js";

export type TaskStatus =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "failed_verification"
  | "failed_scope_violation"
  | "failed_policy_violation"
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
  | "failed_policy_violation"
  | "canceled";

export interface CreateTaskInput {
  plan_id?: string;
  inline_plan?: string;
  plan_title?: string;
  template?: TaskTemplateName;
  goal?: string;
  source_task_id?: string;
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
  continuation_required: boolean;
  next_action: string;
  path: string;
  plan_source: "saved" | "inline" | "template";
  template?: TaskTemplateName;
  change_policy: ChangePolicy;
  server_version: string;
  tool_profile: string;
  tool_manifest_sha256: string | null;
  execution_blocked: boolean;
  pending_reason: PendingReason;
  watcher: WatcherStatusSnapshot;
  available_followup_tools: string[];
  next_tool_call: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

export function createTask(input: CreateTaskInput): CreateTaskOutput {
  const config = getConfig();
  const tasksDir = getTasksDir(config);
  const plansDir = getPlansDir(config);

  const planSources = [
    input.plan_id?.trim() ? "plan_id" : "",
    input.inline_plan?.trim() ? "inline_plan" : "",
    input.template ? "template" : "",
  ].filter(Boolean);
  if (planSources.length !== 1) {
    throw new PatchWardenError(
      "invalid_plan_source",
      "create_task requires exactly one of plan_id, inline_plan, or template.",
      "Use an existing plan_id, pass inline_plan text, or choose one built-in template."
    );
  }
  if (input.template && !TASK_TEMPLATE_NAMES.includes(input.template)) {
    throw new PatchWardenError(
      "invalid_task_template",
      `Unknown task template "${input.template}".`,
      `Use one of: ${TASK_TEMPLATE_NAMES.join(", ")}.`
    );
  }

  // Resolve repo alias if configured
  let resolvedRepoPath = input.repo_path?.trim() || "";
  const aliases = (config as any).repoAliases as Record<string, string> | undefined;
  if (aliases && resolvedRepoPath && aliases[resolvedRepoPath]) {
    resolvedRepoPath = aliases[resolvedRepoPath];
  }

  if (!resolvedRepoPath || resolvedRepoPath === "") {
    throw new PatchWardenError(
      "repo_path_required",
      "create_task requires an explicit repo_path; PatchWarden will not default to workspaceRoot.",
      'Pass a repository path inside workspaceRoot, for example repo_path: "my-project".',
      true,
      { operation: "create_task", safe_alternative: "Pass an existing repository directory under workspaceRoot." }
    );
  }

  // Validate agent
  if (!config.agents[input.agent]) {
    throw new PatchWardenError(
      "agent_not_configured",
      `Unknown agent "${input.agent}". Available: ${Object.keys(config.agents).join(", ")}`,
      "Call list_agents and use an available configured agent."
    );
  }

  // Validate repo_path is within workspace
  const safeRepoPath = guardWorkspacePath(
    resolvedRepoPath,
    config.workspaceRoot
  );
  if (!existsSync(safeRepoPath)) {
    throw new PatchWardenError(
      "repo_path_not_found",
      `repo_path "${resolvedRepoPath}" resolves to "${safeRepoPath}", but that path does not exist.`,
      "Create the repository directory first or pass an existing path under workspaceRoot.",
      true,
      { operation: "create_task", path: resolvedRepoPath, resolved_repo_path: safeRepoPath, safe_alternative: "Use an existing repository directory under workspaceRoot." }
    );
  }
  if (!statSync(safeRepoPath).isDirectory()) {
    throw new PatchWardenError(
      "repo_path_not_directory",
      `repo_path "${resolvedRepoPath}" resolves to a file, not a directory.`,
      "Pass the repository directory instead of a file path.",
      true,
      { operation: "create_task", path: resolvedRepoPath, resolved_repo_path: safeRepoPath, safe_alternative: "Pass the containing repository directory instead of a file." }
    );
  }

  // Runtime self-modification protection: refuse to modify the active
  // PatchWarden runtime directory or its critical subdirectories.
  const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const criticalDirs = ["dist", "src", "scripts", "release"];
  if (safeRepoPath === runtimeRoot || safeRepoPath.startsWith(runtimeRoot + resolve("/")[0])) {
    const isCritical = criticalDirs.some((dir) =>
      safeRepoPath === join(runtimeRoot, dir) ||
      safeRepoPath.startsWith(join(runtimeRoot, dir) + resolve("/")[0])
    );
    if (safeRepoPath === runtimeRoot || isCritical) {
      throw new PatchWardenError(
        "runtime_self_modification_blocked",
        `repo_path "${resolvedRepoPath}" points to the active PatchWarden runtime or its critical subdirectories.`,
        "Use a dev copy or git worktree for PatchWarden development. The running MCP server must not be modified by a task.",
        true,
        {
          operation: "create_task",
          path: resolvedRepoPath,
          resolved_repo_path: safeRepoPath,
          runtime_root: runtimeRoot,
          safe_alternative: "Clone or copy PatchWarden to a separate directory for development tasks.",
        }
      );
    }
  }

  // Validate test command — must be in allowlist, no swallowing
  let testCmd = "";
  if (input.test_command && input.test_command.trim() !== "") {
    testCmd = guardTestCommand(input.test_command, config);
    // guardTestCommand throws if not in allowedTestCommands
  }

  if (input.verify_commands !== undefined && !Array.isArray(input.verify_commands)) {
    throw new PatchWardenError(
      "invalid_verify_commands",
      "verify_commands must be an array of allow-listed command strings.",
      "Pass an array such as [\"npm test\", \"npm run build\"]."
    );
  }
  if ((input.verify_commands?.length || 0) > 20) {
    throw new PatchWardenError(
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
    throw new PatchWardenError(
      "invalid_timeout",
      "timeout_seconds must be a positive integer",
      `Use a whole number from 1 to ${config.maxTaskTimeoutSeconds}.`
    );
  }
  if (timeoutSeconds > config.maxTaskTimeoutSeconds) {
    throw new PatchWardenError(
      "invalid_timeout",
      `timeout_seconds cannot exceed configured maximum ${config.maxTaskTimeoutSeconds}`,
      `Use a value no greater than ${config.maxTaskTimeoutSeconds}.`
    );
  }

  let planId = input.plan_id?.trim() || "";
  let planSource: CreateTaskOutput["plan_source"] = "saved";
  let changePolicy: ChangePolicy = "repo_scoped_changes";
  if (planId) {
    const planFile = join(resolve(plansDir, planId), "plan.md");
    guardReadPath(planFile, config.workspaceRoot, config.plansDir);
    if (!existsSync(planFile)) {
      throw new PatchWardenError(
        "plan_not_found",
        `Plan "${planId}" not found.`,
        "Call save_plan first, or pass inline_plan/template directly to create_task."
      );
    }
  } else if (input.inline_plan?.trim()) {
    const saved = savePlan({
      title: input.plan_title?.trim() || "Inline task plan",
      content: input.inline_plan.trim(),
    });
    planId = saved.plan_id;
    planSource = "inline";
  } else {
    const expanded = expandTaskTemplate({
      template: input.template!,
      goal: input.goal || "",
      source_task_id: input.source_task_id,
      verify_commands: verifyCommands,
    });
    const saved = savePlan({ title: expanded.title, content: expanded.content });
    planId = saved.plan_id;
    planSource = "template";
    changePolicy = expanded.change_policy;
  }

  const taskId = `task_${Date.now()}_${planId.replace(/^plan_/, "")}`;
  const taskDir = resolve(tasksDir, taskId);

  guardPath(taskDir, config.workspaceRoot, config.tasksDir);
  mkdirSync(taskDir, { recursive: true });

  const status: TaskStatus = "pending";
  const statusFile = join(taskDir, "status.json");
  const statusData = {
    task_id: taskId,
    plan_id: planId,
    plan_source: planSource,
    template: input.template || null,
    change_policy: changePolicy,
    agent: input.agent,
    workspace_root: resolve(config.workspaceRoot),
    repo_path: resolvedRepoPath,
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

  const catalog = getLastToolCatalogSnapshot();
  const watcher = readWatcherStatus(config);
  const pendingReason = derivePendingReason({ status, phase: statusData.phase }, watcher);
  const hasWaitForTask = catalog?.tool_names?.includes("wait_for_task") ?? true;
  const nextActionWait = `Call wait_for_task with task_id ${taskId}; keep calling it until terminal is true, then review the returned summary.`;
  const nextActionPoll = `Task created. Monitor status with get_task_status(task_id: "${taskId}") and check progress.md. When status reaches done/failed, review get_task_summary or get_result.`;
  const nextActionBlocked = `Task was saved but execution is blocked because the watcher is ${watcher.status}. Call health_check and restart the owned watcher; the queued task will be picked up after recovery.`;
  const followupCandidates = ["health_check", "get_task_status", "list_tasks", "wait_for_task", "cancel_task"];
  const availableFollowupTools = catalog
    ? followupCandidates.filter((name) => catalog.tool_names.includes(name))
    : followupCandidates;

  return {
    task_id: taskId,
    plan_id: planId,
    agent: input.agent,
    status,
    timeout_seconds: timeoutSeconds,
    continuation_required: watcher.available && hasWaitForTask,
    next_action: !watcher.available ? nextActionBlocked : hasWaitForTask ? nextActionWait : nextActionPoll,
    path: taskDir,
    plan_source: planSource,
    ...(input.template ? { template: input.template } : {}),
    change_policy: changePolicy,
    server_version: PATCHWARDEN_VERSION,
    tool_profile: catalog?.tool_profile || resolveToolProfile(config.toolProfile),
    tool_manifest_sha256: catalog?.tool_manifest_sha256 || null,
    execution_blocked: !watcher.available,
    pending_reason: pendingReason,
    watcher,
    available_followup_tools: availableFollowupTools,
    next_tool_call: !watcher.available
      ? { name: "health_check", arguments: { detail: "standard" } }
      : hasWaitForTask
        ? { name: "wait_for_task", arguments: { task_id: taskId, timeout_seconds: 25 } }
        : { name: "get_task_status", arguments: { task_id: taskId } },
  };
}
