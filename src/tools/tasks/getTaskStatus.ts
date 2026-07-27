import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { getTasksDir, getConfig, sanitizeAgentRuntimeMetadata, type AgentRuntimeMetadata } from "../../config.js";
import { guardReadPath } from "../../security/pathGuard.js";
import { guardSensitivePath } from "../../security/sensitiveGuard.js";
import type { TaskStatus } from "./createTask.js";
import type { TaskPhase } from "./createTask.js";
import { readTaskRuntime } from "../../runner/taskRuntime.js";
import {
  derivePendingReason,
  readWatcherStatus,
  type PendingReason,
  type WatcherStatusSnapshot,
} from "../../watcherStatus.js";
import { isTerminalTaskStatus } from "./taskStates.js";
import { readTaskHistoryState, type TaskHistoryState } from "./taskHistory.js";

export interface GetTaskStatusOutput {
  task_id: string;
  plan_id: string;
  plan_source?: "saved" | "inline" | "template";
  template?: string | null;
  change_policy?: "repo_scoped_changes" | "no_changes";
  agent: string;
  requested_model?: string | null;
  agent_runtime?: AgentRuntimeMetadata | null;
  model_selection?: AgentRuntimeMetadata | null;
  failure_category?: string | null;
  agent_failure_category?: string | null;
  provider_error_reference?: string | null;
  workspace_root: string;
  repo_path: string;
  resolved_repo_path: string;
  status: TaskStatus;
  phase: TaskPhase;
  created_at: string;
  updated_at: string;
  last_heartbeat_at: string;
  current_command: string | null;
  timeout_seconds: number;
  started_at?: string;
  finished_at?: string;
  changed_files?: Array<{ path: string; change: string }>;
  out_of_scope_changes?: Array<{ path: string; change: string }>;
  new_out_of_scope_changes?: Array<{ path: string; change: string }>;
  artifact_hygiene_counts?: Record<string, unknown>;
  verify_status?: "passed" | "failed" | "skipped" | "not_run";
  verify_commands?: string[];
  diff_available?: boolean;
  diff_truncated?: boolean;
  workspace_dirty_before?: boolean;
  workspace_dirty_after?: boolean;
  workspace_dirty?: boolean;
  error: string | null;
  watcher_status: WatcherStatusSnapshot["status"];
  watcher_last_heartbeat_at: string | null;
  watcher_heartbeat_age_seconds: number | null;
  watcher: WatcherStatusSnapshot;
  pending_reason: PendingReason;
  execution_blocked: boolean;
  history_state: TaskHistoryState;
}

export function getTaskStatus(taskId: string): GetTaskStatusOutput {
  const config = getConfig();
  const tasksDir = getTasksDir(config);

  const taskDir = resolve(tasksDir, taskId);
  const statusFile = join(taskDir, "status.json");

  guardReadPath(statusFile, config.workspaceRoot, config.tasksDir);
  guardSensitivePath(statusFile);

  if (!existsSync(statusFile)) {
    throw new Error(`Task not found: "${taskId}". Check the task ID or create a task first.`);
  }

  const raw = readFileSync(statusFile, "utf-8");
  const status = JSON.parse(raw) as GetTaskStatusOutput;
  const runtime = readTaskRuntime(taskDir);
  // A terminal status is authoritative. A stale runtime phase from a crashed
  // Runner must never make a reconciled task look active again.
  const phase = isTerminalTaskStatus(String(status.status))
    ? status.phase || "queued"
    : runtime.phase || status.phase || "queued";
  const watcher = readWatcherStatus(config);
  const pendingReason = derivePendingReason({ status: status.status, phase }, watcher);
  return {
    ...status,
    phase,
    last_heartbeat_at: runtime.last_heartbeat_at || status.last_heartbeat_at || status.updated_at,
    current_command: runtime.current_command ?? status.current_command ?? null,
    watcher_status: watcher.status,
    watcher_last_heartbeat_at: watcher.last_heartbeat_at,
    watcher_heartbeat_age_seconds: watcher.heartbeat_age_seconds,
    watcher,
    pending_reason: pendingReason,
    execution_blocked: status.status === "pending" && !watcher.available,
    history_state: readTaskHistoryState(status as unknown as Record<string, unknown>),
    agent_runtime: sanitizeAgentRuntimeMetadata(status.agent_runtime ?? status.model_selection),
    model_selection: sanitizeAgentRuntimeMetadata(status.model_selection ?? status.agent_runtime),
    failure_category: status.failure_category ?? status.agent_failure_category ?? null,
    agent_failure_category: status.agent_failure_category ?? status.failure_category ?? null,
    provider_error_reference: typeof status.provider_error_reference === "string"
      && /^err_[A-Za-z0-9_-]{4,120}$/.test(status.provider_error_reference)
      ? status.provider_error_reference
      : null,
  };
}
