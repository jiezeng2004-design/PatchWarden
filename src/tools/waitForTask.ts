import { setTimeout as sleep } from "node:timers/promises";
import { getTaskStatus } from "./getTaskStatus.js";
import { getTaskSummary, type TaskSummaryOutput } from "./getTaskSummary.js";

const TERMINAL_STATUSES = new Set([
  "done",
  "failed",
  "failed_verification",
  "failed_scope_violation",
  "canceled",
]);

export interface WaitForTaskOutput {
  task_id: string;
  status: string;
  phase: string;
  terminal: boolean;
  timed_out: boolean;
  continuation_required: boolean;
  waited_ms: number;
  next_action: string;
  summary?: TaskSummaryOutput;
}

export async function waitForTask(taskId: string, waitSeconds = 25): Promise<WaitForTaskOutput> {
  if (!Number.isInteger(waitSeconds) || waitSeconds < 1 || waitSeconds > 30) {
    throw new Error("wait_seconds must be an integer from 1 to 30.");
  }
  const started = Date.now();
  const deadline = started + waitSeconds * 1000;
  let status = getTaskStatus(taskId);

  while (!TERMINAL_STATUSES.has(status.status) && Date.now() < deadline) {
    await sleep(Math.min(500, Math.max(1, deadline - Date.now())));
    status = getTaskStatus(taskId);
  }

  const terminal = TERMINAL_STATUSES.has(status.status);
  return {
    task_id: taskId,
    status: status.status,
    phase: status.phase,
    terminal,
    timed_out: !terminal,
    continuation_required: !terminal,
    waited_ms: Date.now() - started,
    next_action: terminal
      ? "Review the returned summary, then call audit_task for independent acceptance evidence."
      : `Call wait_for_task again immediately for task_id ${taskId}; do not end the assistant turn while continuation_required is true.`,
    ...(terminal ? { summary: getTaskSummary(taskId) } : {}),
  };
}
