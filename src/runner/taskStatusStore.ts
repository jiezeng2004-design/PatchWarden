import { PatchWardenError } from "../errors.js";
import {
  mutateLockedJsonFileSync,
  readJsonObjectFileSync,
  type LockedJsonMutation,
} from "../utils/lockedJsonFile.js";

export type TaskStatusRecord = Record<string, unknown>;

export type TaskStatusMutation<T> = LockedJsonMutation<TaskStatusRecord, T>;

export interface TaskClaimResult {
  claimed: boolean;
  status: TaskStatusRecord;
}

export function readTaskStatusFile(statusFile: string): TaskStatusRecord {
  return readJsonObjectFileSync<TaskStatusRecord>(statusFile);
}

export function mutateTaskStatus<T>(
  statusFile: string,
  mutation: (current: TaskStatusRecord) => TaskStatusMutation<T>,
): T {
  return mutateLockedJsonFileSync(statusFile, mutation, {
    busyError: () => new PatchWardenError(
      "task_status_busy",
      "Task status is currently being updated by another PatchWarden process.",
      "Retry the operation after the current task status update completes.",
      true,
    ),
  });
}

export function claimPendingTask(
  statusFile: string,
  patch: TaskStatusRecord,
): TaskClaimResult {
  return mutateTaskStatus<TaskClaimResult>(statusFile, (current) => {
    if (current.status !== "pending") return { result: { claimed: false, status: current } };
    const next = { ...current, ...patch, updated_at: new Date().toISOString() };
    return { next, result: { claimed: true, status: next } };
  });
}

export function updateTaskStatusFile(
  statusFile: string,
  patch: TaskStatusRecord,
): TaskStatusRecord {
  return mutateTaskStatus(statusFile, (current) => {
    const next = { ...current, ...patch, updated_at: new Date().toISOString() };
    return { next, result: next };
  });
}
