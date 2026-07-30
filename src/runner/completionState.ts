export interface CompletionState {
  implementation_complete: boolean;
  static_verification_complete: boolean;
  runtime_validation_required: boolean;
  runtime_validation_complete: boolean;
  manual_review_required: boolean;
  user_acceptance_ready: boolean;
  accepted: boolean;
}

export function deriveCompletionState(input: {
  status: string;
  verify_status?: string | null;
  runtime_validation?: unknown;
  manual_scope_review_required?: boolean;
  acceptance_status?: string | null;
}): CompletionState {
  const runtime = asRecord(input.runtime_validation);
  const runtimeRequired = Object.keys(runtime).length > 0 && runtime.status !== "not_configured";
  const runtimeComplete = runtimeRequired && runtime.status === "passed";
  const implementationComplete = [
    "done_by_agent", "done", "accepted", "failed_verification",
  ].includes(input.status);
  const staticComplete = input.verify_status === "passed";
  const accepted = input.status === "accepted" || input.acceptance_status === "accepted";
  const manualReviewRequired = input.manual_scope_review_required === true || !runtimeRequired;
  return {
    implementation_complete: implementationComplete,
    static_verification_complete: staticComplete,
    runtime_validation_required: runtimeRequired,
    runtime_validation_complete: runtimeComplete,
    manual_review_required: manualReviewRequired,
    user_acceptance_ready:
      implementationComplete
      && staticComplete
      && (!runtimeRequired || runtimeComplete)
      && !manualReviewRequired,
    accepted,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
