export type TaskFailureCategory =
  | "agent_execution_error"
  | "agent_timeout"
  | "environment_bootstrap_failure"
  | "dependency_install_failure"
  | "verification_failure"
  | "scope_violation"
  | "policy_block"
  | "connector_failure"
  | "watcher_failure"
  | "user_confirmation_required";

export interface FailureCategoryEvidence {
  failure_category: TaskFailureCategory;
  failure_source: "agent" | "environment" | "verification" | "scope" | "policy" | "connector" | "watcher" | "user";
  counts_against_agent: boolean;
  fallback_eligible: boolean;
  retryable: boolean;
}

const TASK_FAILURE_CATEGORIES = new Set<TaskFailureCategory>([
  "agent_execution_error",
  "agent_timeout",
  "environment_bootstrap_failure",
  "dependency_install_failure",
  "verification_failure",
  "scope_violation",
  "policy_block",
  "connector_failure",
  "watcher_failure",
  "user_confirmation_required",
]);

export function isTaskFailureCategory(value: unknown): value is TaskFailureCategory {
  return typeof value === "string" && TASK_FAILURE_CATEGORIES.has(value as TaskFailureCategory);
}

export function failureCategoryEvidence(category: TaskFailureCategory): FailureCategoryEvidence {
  switch (category) {
    case "agent_execution_error":
    case "agent_timeout":
      return { failure_category: category, failure_source: "agent", counts_against_agent: true, fallback_eligible: true, retryable: true };
    case "verification_failure":
      return { failure_category: category, failure_source: "verification", counts_against_agent: true, fallback_eligible: true, retryable: true };
    case "environment_bootstrap_failure":
    case "dependency_install_failure":
      return { failure_category: category, failure_source: "environment", counts_against_agent: false, fallback_eligible: false, retryable: category === "dependency_install_failure" };
    case "scope_violation":
      return { failure_category: category, failure_source: "scope", counts_against_agent: false, fallback_eligible: false, retryable: false };
    case "policy_block":
      return { failure_category: category, failure_source: "policy", counts_against_agent: false, fallback_eligible: false, retryable: false };
    case "connector_failure":
      return { failure_category: category, failure_source: "connector", counts_against_agent: false, fallback_eligible: false, retryable: true };
    case "watcher_failure":
      return { failure_category: category, failure_source: "watcher", counts_against_agent: false, fallback_eligible: false, retryable: true };
    case "user_confirmation_required":
      return { failure_category: category, failure_source: "user", counts_against_agent: false, fallback_eligible: false, retryable: false };
  }
}
