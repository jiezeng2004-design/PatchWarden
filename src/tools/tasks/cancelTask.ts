import { existsSync } from "node:fs";
import { join } from "node:path";
import { getTasksDir, getConfig } from "../../config.js";
import { guardReadPath } from "../../security/pathGuard.js";
import { writeTaskProgress } from "../../runner/taskProgress.js";
import { mutateTaskStatus } from "../../runner/taskStatusStore.js";
import type { TaskStatus } from "./createTask.js";

export interface TaskTerminationResponse {
  task_id: string;
  previous_status: TaskStatus;
  new_status: TaskStatus;
  message: string;
  cancel_requested?: boolean;
  force_kill_requested?: boolean;
}

interface TaskTerminationOutcome {
  response: TaskTerminationResponse;
  progress: {
    phase: "canceled" | "canceling" | "terminating";
    note: string;
  } | null;
}

export function cancelTask(taskId: string) {
  return requestTaskTermination(taskId, false);
}

export function requestTaskTermination(taskId: string, force: boolean) {
  const config = getConfig();
  const taskDir = join(getTasksDir(config), taskId);
  const statusFile = join(taskDir, "status.json");
  guardReadPath(statusFile, config.workspaceRoot, config.tasksDir);

  if (!existsSync(statusFile)) throw new Error(`Task not found: "${taskId}"`);

  const now = new Date().toISOString();
  const outcome = mutateTaskStatus<TaskTerminationOutcome>(statusFile, (current) => {
    const currentStatus = current.status as TaskStatus;
    if (["done", "done_by_agent", "failed", "failed_verification", "failed_scope_violation", "failed_policy_violation", "canceled"].includes(currentStatus)) {
      return { result: {
        response: {
          task_id: taskId,
          previous_status: currentStatus,
          new_status: currentStatus,
          message: `Task is already ${currentStatus}. No action taken.`,
        },
        progress: null,
      } };
    }

    if (currentStatus === "pending") {
      const reason = force ? "Killed before execution by user request." : "Canceled by user request.";
      const next = {
        ...current,
        status: "canceled",
        phase: "canceled",
        canceled_at: now,
        cancel_reason: reason,
        updated_at: now,
      };
      return { next, result: {
        response: {
          task_id: taskId,
          previous_status: "pending" as const,
          new_status: "canceled" as const,
          message: "Pending task canceled. It will not be executed by watcher.",
        },
        progress: { phase: "canceled" as const, note: reason },
      } };
    }

    const phase = force ? "terminating" as const : "canceling" as const;
    const next = {
      ...current,
      cancel_requested: true,
      cancel_requested_at: now,
      force_kill_requested: force,
      ...(force ? { kill_requested_at: now } : {}),
      phase,
      updated_at: now,
    };
    return { next, result: {
      response: {
        task_id: taskId,
        previous_status: "running" as const,
        new_status: "running" as const,
        cancel_requested: true,
        force_kill_requested: force,
        message: force
          ? "Kill requested. The runner that owns the child process will terminate it."
          : "Cancel requested. The runner will stop the child process safely.",
      },
      progress: {
        phase,
        note: force ? "Immediate termination requested." : "Graceful cancellation requested.",
      },
    } };
  });

  if (outcome.progress) {
    writeTaskProgress(taskDir, outcome.progress.phase, {
      note: outcome.progress.note,
      heartbeatAt: now,
    });
  }
  return outcome.response;
}
