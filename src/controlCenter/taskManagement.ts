import { listTasks, type TaskEntry } from "../tools/listTasks.js";
import type { WatcherStatusSnapshot } from "../watcherStatus.js";
import type { PatchWardenConfig } from "../config.js";
import { errorMessage } from "./helpers.js";

// ── Terminal task statuses ─────────────────────────────────────────

export const TERMINAL_TASK_STATUSES = new Set([
  "done",
  "done_by_agent",
  "failed",
  "failed_verification",
  "failed_scope_violation",
  "failed_policy_violation",
  "canceled",
  "timeout",
]);

// ── Stale classification ───────────────────────────────────────────

export interface StaleClassification {
  is_stale: boolean;
  stale_reasons: string[];
}

/**
 * Classify a task as stale based on Phase 2 rules:
 *  - status=running but last_heartbeat_at exceeds threshold
 *  - phase=collecting_artifacts exceeds threshold
 *  - current_command=null AND watcher currently healthy
 *  - task last_heartbeat_at significantly earlier than current watcher heartbeat
 *
 * Only pending/running tasks can be stale; terminal tasks are never stale.
 */
export function classifyStaleTask(
  task: TaskEntry,
  watcher: WatcherStatusSnapshot,
  config: PatchWardenConfig,
  nowMs = Date.now()
): StaleClassification {
  const reasons: string[] = [];
  if (TERMINAL_TASK_STATUSES.has(task.status)) {
    return { is_stale: false, stale_reasons: reasons };
  }
  // Only pending/running are candidates for staleness.
  if (task.status !== "pending" && task.status !== "running") {
    return { is_stale: false, stale_reasons: reasons };
  }

  const staleThresholdMs = config.watcherStaleSeconds * 1000;
  const hbMs = Date.parse(task.last_heartbeat_at || "");
  const heartbeatAgeMs = Number.isFinite(hbMs) ? Math.max(0, nowMs - hbMs) : null;

  // Rule 1: running with stale heartbeat
  if (task.status === "running" && heartbeatAgeMs !== null && heartbeatAgeMs > staleThresholdMs) {
    reasons.push("heartbeat_stale");
  }

  // Rule 2: collecting_artifacts phase exceeds threshold
  if (task.phase === "collecting_artifacts" && heartbeatAgeMs !== null && heartbeatAgeMs > staleThresholdMs) {
    reasons.push("collecting_artifacts_stale");
  }

  // Rule 3: running with no current_command while watcher is healthy
  if (
    task.status === "running" &&
    (task.current_command === null || task.current_command === "") &&
    watcher.status === "healthy"
  ) {
    reasons.push("running_no_command_watcher_healthy");
  }

  // Rule 4: task heartbeat significantly earlier than watcher heartbeat
  if (heartbeatAgeMs !== null && watcher.last_heartbeat_at) {
    const watcherHbMs = Date.parse(watcher.last_heartbeat_at);
    if (Number.isFinite(watcherHbMs)) {
      const gapMs = watcherHbMs - hbMs;
      // Task heartbeat is "significantly earlier" than watcher heartbeat when
      // the task has not heartbeat for at least 2x the stale threshold while
      // the watcher is alive.
      if (gapMs > staleThresholdMs * 2 && watcher.status === "healthy") {
        reasons.push("heartbeat_far_behind_watcher");
      }
    }
  }

  return { is_stale: reasons.length > 0, stale_reasons: reasons };
}

export function augmentTaskWithStale(
  task: TaskEntry,
  watcher: WatcherStatusSnapshot,
  config: PatchWardenConfig,
  nowMs = Date.now()
): TaskEntry & StaleClassification {
  const cls = classifyStaleTask(task, watcher, config, nowMs);
  return { ...task, is_stale: cls.is_stale, stale_reasons: cls.stale_reasons };
}

export interface StatusTasks {
  tasks: unknown[];
  total: number;
  active: number;
  stale: number;
  stale_task_ids: string[];
  reason: string | null;
}

export function listTasksForStatus(config: PatchWardenConfig): StatusTasks {
  try {
    const result = listTasks({ limit: 100 });
    const watcher = result.watcher;
    const now = Date.now();
    let active = 0;
    let stale = 0;
    const staleTaskIds: string[] = [];
    const augmented = result.tasks.map((t) => {
      const a = augmentTaskWithStale(t, watcher, config, now);
      if (t.status === "pending" || t.status === "running") active++;
      if (a.is_stale) {
        stale++;
        staleTaskIds.push(t.task_id);
      }
      return a;
    });
    return { tasks: augmented, total: result.total, active, stale, stale_task_ids: staleTaskIds, reason: null };
  } catch (err) {
    return { tasks: [], total: 0, active: 0, stale: 0, stale_task_ids: [], reason: errorMessage(err) };
  }
}