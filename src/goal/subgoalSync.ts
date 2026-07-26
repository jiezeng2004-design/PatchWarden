import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { getConfig } from "../config.js";
import { logger } from "../logging.js";
import { redactSensitiveContent } from "../security/contentRedaction.js";
import { mutateGoalStatus } from "./goalStore.js";
import { updateSubgoalStatus, type GoalStatus, type SubgoalStatus } from "./goalStatus.js";

export interface TaskGoalMeta {
  goal_id?: string | null;
  subgoal_id?: string | null;
}

export function syncSubgoalOnTaskStatus(
  taskId: string,
  taskMeta: TaskGoalMeta,
  taskStatus: string,
  error: string | null = null,
  workspaceRoot?: string,
): void {
  const goalId = taskMeta.goal_id;
  const subgoalId = taskMeta.subgoal_id;
  if (!goalId || !subgoalId) return;
  try {
    mutateGoalStatus(goalId, (goalStatus) => {
      const subgoal = goalStatus.subgoals.find((entry) => entry.id === subgoalId);
      if (!subgoal || subgoal.status === "accepted" || subgoal.status === "rejected") {
        return { result: undefined };
      }
      let next = goalStatus;
      const target = targetSubgoalStatus(taskStatus);
      if (target === "running" && subgoal.status === "queued") {
        next = updateSubgoalStatus(next, subgoalId, "running");
      } else if (target === "done_by_agent") {
        if (subgoal.status === "queued") next = updateSubgoalStatus(next, subgoalId, "running");
        const current = next.subgoals.find((entry) => entry.id === subgoalId);
        if (current?.status === "running") next = updateSubgoalStatus(next, subgoalId, "done_by_agent");
      } else if (target === "needs_fix" && ["queued", "running", "done_by_agent"].includes(subgoal.status)) {
        next = updateSubgoalStatus(next, subgoalId, "needs_fix");
      }
      const changedAt = new Date().toISOString();
      next = {
        ...next,
        updated_at: changedAt,
        subgoals: next.subgoals.map((entry) => entry.id === subgoalId ? {
          ...entry,
          last_task_id: taskId,
          last_task_status: taskStatus.slice(0, 80),
          last_task_error: error ? redactSensitiveContent(error).content.slice(0, 500) : null,
          last_task_updated_at: changedAt,
        } : entry),
      };
      return { next, result: undefined };
    }, workspaceRoot);
  } catch (err) {
    logger.error(`[goal] task status sync failed for task ${taskId}`, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function syncSubgoalOnTaskDone(
  taskId: string,
  taskMeta: TaskGoalMeta,
  workspaceRoot?: string,
): void {
  syncSubgoalOnTaskStatus(taskId, taskMeta, "done_by_agent", null, workspaceRoot);
}

export function migrateQueuedSubgoalsFromTasks(goalId: string, workspaceRoot?: string): number {
  return mutateGoalStatus(goalId, (goalStatus) => {
    const root = workspaceRoot ?? getConfig().workspaceRoot;
    const tasksDir = getConfig().tasksDir;
    let migrated = 0;
    const now = new Date().toISOString();
    const subgoals = goalStatus.subgoals.map((subgoal) => {
      if (subgoal.status !== "running" || subgoal.task_ids.length === 0) return subgoal;
      const latestTaskId = subgoal.task_ids.at(-1)!;
      const statusPath = join(isAbsolute(tasksDir) ? tasksDir : join(root, tasksDir), latestTaskId, "status.json");
      if (!existsSync(statusPath)) return subgoal;
      try {
        const task = JSON.parse(readFileSync(statusPath, "utf-8")) as Record<string, unknown>;
        if (task.status !== "pending") return subgoal;
        migrated += 1;
        return {
          ...subgoal,
          status: "queued" as SubgoalStatus,
          last_task_id: latestTaskId,
          last_task_status: "pending",
          last_task_error: null,
          last_task_updated_at: now,
        };
      } catch {
        return subgoal;
      }
    });
    return {
      next: migrated > 0 ? { ...goalStatus, subgoals, updated_at: now } : undefined,
      result: migrated,
    };
  }, workspaceRoot);
}

function targetSubgoalStatus(taskStatus: string): "queued" | "running" | "done_by_agent" | "needs_fix" | null {
  if (taskStatus === "pending") return "queued";
  if (["running", "executing_agent", "verifying", "collecting_artifacts"].includes(taskStatus)) return "running";
  if (["done", "done_by_agent", "accepted"].includes(taskStatus)) return "done_by_agent";
  if ([
    "failed", "failed_verification", "failed_scope_violation", "failed_policy_violation",
    "failed_stale", "orphaned", "timeout", "canceled", "rejected", "needs_fix", "blocked",
  ].includes(taskStatus)) return "needs_fix";
  return null;
}

export function readTaskGoalMeta(taskDir: string): { goal_id: string | null; subgoal_id: string | null } {
  try {
    const data = JSON.parse(readFileSync(join(taskDir, "status.json"), "utf-8")) as Record<string, unknown>;
    return {
      goal_id: typeof data.goal_id === "string" ? data.goal_id : null,
      subgoal_id: typeof data.subgoal_id === "string" ? data.subgoal_id : null,
    };
  } catch {
    return { goal_id: null, subgoal_id: null };
  }
}
