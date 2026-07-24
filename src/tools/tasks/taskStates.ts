export const ACTIVE_TASK_STATUSES = new Set([
  "pending",
  "running",
  "executing_agent",
  "verifying",
  "collecting_artifacts",
  "cancel_requested",
]);

export const TERMINAL_TASK_STATUSES = new Set([
  "done",
  "done_by_agent",
  "accepted",
  "rejected",
  "needs_fix",
  "blocked",
  "failed",
  "failed_verification",
  "failed_scope_violation",
  "failed_policy_violation",
  "failed_stale",
  "orphaned",
  "timeout",
  "canceled",
]);

export function isTerminalTaskStatus(status: string): boolean {
  return TERMINAL_TASK_STATUSES.has(status);
}

export function isActiveTaskStatus(status: string): boolean {
  return ACTIVE_TASK_STATUSES.has(status);
}

/** Terminal states are immutable; active states may only advance or terminate. */
export function isAllowedTaskStatusTransition(from: string, to: string): boolean {
  if (from === to) return true;
  if (isTerminalTaskStatus(from)) return false;
  if (!isActiveTaskStatus(from) || !isActiveTaskStatus(to) && !isTerminalTaskStatus(to)) return false;

  if (from === "pending") {
    return to === "running" || isTerminalTaskStatus(to);
  }
  if (to === "pending") return false;

  const forwardActive: Record<string, Set<string>> = {
    running: new Set(["executing_agent", "verifying", "collecting_artifacts", "cancel_requested"]),
    executing_agent: new Set(["verifying", "collecting_artifacts", "cancel_requested"]),
    verifying: new Set(["collecting_artifacts", "cancel_requested"]),
    collecting_artifacts: new Set(["cancel_requested"]),
    cancel_requested: new Set(),
  };
  return isTerminalTaskStatus(to) || Boolean(forwardActive[from]?.has(to));
}
