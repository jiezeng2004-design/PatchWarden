import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { getTasksDir, getPlansDir, getConfig } from "../../config.js";
import { guardPath } from "../../security/pathGuard.js";
import { readTaskRuntime } from "../../runner/taskRuntime.js";
import type { TaskPhase, TaskStatus, AcceptanceStatus } from "./createTask.js";
import {
  derivePendingReason,
  readWatcherStatus,
  type PendingReason,
  type WatcherState,
  type WatcherStatusSnapshot,
} from "../../watcherStatus.js";
import { isActiveTaskStatus } from "./taskStates.js";
import { readTaskHistoryState, type TaskHistoryState } from "./taskHistory.js";

export interface TaskEntry {
  task_id: string;
  plan_id: string;
  title: string;
  agent: string;
  requested_model: string | null;
  model_selection: Record<string, unknown> | null;
  failure_category: string | null;
  agent_failure_category: string | null;
  failure_source: string | null;
  counts_against_agent: boolean;
  fallback_eligible: boolean;
  retryable: boolean;
  lineage_id: string | null;
  source_changes: number;
  generated_changes: number;
  scope_violations: number;
  verification_progress: { status: string; configured: number; executed: number };
  completion_state: Record<string, unknown> | null;
  connector_state: "not_observable_server_side";
  provider_error_reference: string | null;
  status: TaskStatus;
  phase: TaskPhase;
  acceptance_status: AcceptanceStatus;
  created_at: string;
  updated_at: string;
  workspace_root: string;
  repo_path: string;
  resolved_repo_path: string;
  test_command: string;
  verify_commands: string[];
  error: string | null;
  last_heartbeat_at: string;
  current_command: string | null;
  timeout_seconds: number;
  pending_reason: PendingReason;
  watcher_status: WatcherState;
  history_state: TaskHistoryState;
}

export interface ListTasksInput {
  status?: string;
  repo_path?: string;
  active_only?: boolean;
  acceptance_status?: string;
  limit?: number;
  history_state?: TaskHistoryState | "all";
}

export interface ListTasksOutput {
  tasks: TaskEntry[];
  total: number;
  returned: number;
  watcher: WatcherStatusSnapshot;
}

/**
 * Enumerate the complete matching task set for in-process consumers.
 * MCP callers must continue to use listTasks(), which applies its bounded
 * response limit after this scan completes.
 */
export function listAllTasks(input?: Omit<ListTasksInput, "limit">): ListTasksOutput {
  return scanTasks(input);
}

export function listTasks(input?: ListTasksInput): ListTasksOutput {
  const limit = input?.limit && input.limit > 0 ? Math.min(input.limit, 100) : 20;
  const scanned = scanTasks(input);
  const tasks = scanned.tasks.slice(0, limit);
  return { ...scanned, tasks, returned: tasks.length };
}

function scanTasks(input?: Omit<ListTasksInput, "limit"> | ListTasksInput): ListTasksOutput {
  const config = getConfig();
  const tasksDir = getTasksDir(config);
  const plansDir = getPlansDir(config);
  const filterStatus = input?.status || null;
  const filterAcceptance = input?.acceptance_status || null;
  const filterRepo = input?.repo_path?.trim().replace(/\\/g, "/") || null;
  const watcher = readWatcherStatus(config);
  const historyState = input?.history_state || "active";

  if (!existsSync(tasksDir)) {
    return { tasks: [], total: 0, returned: 0, watcher };
  }

  const entries = readdirSync(tasksDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .sort((a, b) => {
      // Sort by mtime descending (newest first)
      try {
        const sa = statSync(join(tasksDir, a.name, "status.json"));
        const sb = statSync(join(tasksDir, b.name, "status.json"));
        return sb.mtimeMs - sa.mtimeMs;
      } catch {
        return b.name.localeCompare(a.name);
      }
    });

  const tasks: TaskEntry[] = [];
  let totalMatched = 0;

  for (const entry of entries) {
    const taskId = entry.name;
    const taskDir = join(tasksDir, taskId);
    const statusFile = join(taskDir, "status.json");

    if (!existsSync(statusFile)) continue;

    try {
      const data = JSON.parse(readFileSync(statusFile, "utf-8"));
      const runtime = readTaskRuntime(taskDir);
      const taskHistoryState = readTaskHistoryState(data);
      if (historyState !== "all" && taskHistoryState !== historyState) continue;
      if (filterStatus && data.status !== filterStatus) continue;
      if (filterAcceptance) {
        const taskAcceptance = data.status === "done_by_agent"
          ? (typeof data.acceptance_status === "string" ? data.acceptance_status : "pending")
          : null;
        if (taskAcceptance !== filterAcceptance) continue;
      }
      if (input?.active_only && !isActiveTaskStatus(String(data.status))) continue;
      const normalizedRepo = String(data.repo_path || ".").replace(/\\/g, "/");
      const normalizedResolvedRepo = String(data.resolved_repo_path || "").replace(/\\/g, "/");
      if (filterRepo && normalizedRepo !== filterRepo && normalizedResolvedRepo !== filterRepo) continue;
      totalMatched++;

      // Read plan title from plans directory (not task dir)
      let title = `Plan: ${data.plan_id || "unknown"}`;
      if (data.plan_id) {
        const planFile = join(plansDir, data.plan_id, "plan.md");
        if (existsSync(planFile)) {
          try {
            const planContent = readFileSync(planFile, "utf-8");
            const titleMatch = planContent.match(/^#\s*(.+)/m);
            if (titleMatch) title = titleMatch[1];
          } catch { /* keep default */ }
        }
      }

      const phase = runtime.phase || data.phase || "queued";
      const VALID_ACCEPTANCE = ["pending", "accepted", "rejected", "needs_fix", "blocked"];
      const acceptanceStatus: AcceptanceStatus = data.status === "done_by_agent"
        ? (typeof data.acceptance_status === "string" && VALID_ACCEPTANCE.includes(data.acceptance_status) ? data.acceptance_status : "pending")
        : null;
      tasks.push({
        task_id: taskId,
        plan_id: data.plan_id || "",
        title,
        agent: data.agent || "",
        requested_model: typeof data.requested_model === "string" ? data.requested_model : null,
        model_selection: data.model_selection && typeof data.model_selection === "object" ? data.model_selection : null,
        failure_category: data.failure_category || data.agent_failure_category || null,
        agent_failure_category: data.agent_failure_category || null,
        failure_source: data.failure_source || null,
        counts_against_agent: data.counts_against_agent === true,
        fallback_eligible: data.fallback_eligible === true,
        retryable: data.retryable === true,
        lineage_id: typeof data.lineage_id === "string" ? data.lineage_id : null,
        source_changes: Number(data.acceptance_report?.source_changes || 0),
        generated_changes: Number(data.acceptance_report?.generated_changes || 0),
        scope_violations: Number(data.acceptance_report?.scope_violations || 0),
        verification_progress: {
          status: String(data.verify_status || "not_run"),
          configured: Array.isArray(data.configured_verify_commands ?? data.verify_commands) ? (data.configured_verify_commands ?? data.verify_commands).length : 0,
          executed: Array.isArray(data.executed_verify_commands) ? data.executed_verify_commands.length : 0,
        },
        completion_state: data.completion_state && typeof data.completion_state === "object" && !Array.isArray(data.completion_state) ? data.completion_state : null,
        connector_state: "not_observable_server_side",
        provider_error_reference: typeof data.provider_error_reference === "string"
          && /^err_[A-Za-z0-9_-]{4,120}$/.test(data.provider_error_reference)
          ? data.provider_error_reference
          : null,
        status: data.status || "pending",
        phase,
        acceptance_status: acceptanceStatus,
        created_at: data.created_at || "",
        updated_at: data.updated_at || "",
        workspace_root: data.workspace_root || config.workspaceRoot,
        repo_path: data.repo_path || ".",
        resolved_repo_path: data.resolved_repo_path || data.repo_path || config.workspaceRoot,
        test_command: data.test_command || "",
        verify_commands: Array.isArray(data.verify_commands) ? data.verify_commands : [],
        error: data.error || null,
        last_heartbeat_at: runtime.last_heartbeat_at || data.last_heartbeat_at || data.updated_at || "",
        current_command: runtime.current_command ?? data.current_command ?? null,
        timeout_seconds: data.timeout_seconds || config.defaultTaskTimeoutSeconds,
        pending_reason: derivePendingReason({ status: data.status, phase }, watcher),
        watcher_status: watcher.status,
        history_state: taskHistoryState,
      });
    } catch {
      // skip corrupted entries
    }
  }

  return { tasks, total: totalMatched, returned: tasks.length, watcher };
}
