import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { getTasksDir, getConfig } from "../config.js";
import { guardReadPath } from "../security/pathGuard.js";
import { guardSensitivePath } from "../security/sensitiveGuard.js";
import type { TaskStatus } from "./createTask.js";
import type { TaskPhase } from "./createTask.js";
import { readTaskRuntime } from "../taskRuntime.js";
import {
  derivePendingReason,
  readWatcherStatus,
  type PendingReason,
  type WatcherStatusSnapshot,
} from "../watcherStatus.js";

export interface GetTaskStatusOutput {
  task_id: string;
  plan_id: string;
  plan_source?: "saved" | "inline" | "template";
  template?: string | null;
  change_policy?: "repo_scoped_changes" | "no_changes";
  agent: string;
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
  verify_status?: "passed" | "failed" | "skipped";
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
  const phase = runtime.phase || status.phase || "queued";
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
  };
}
