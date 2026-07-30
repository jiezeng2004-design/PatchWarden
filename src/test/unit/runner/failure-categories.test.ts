import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { failureCategoryEvidence, type TaskFailureCategory } from "../../../runner/failureCategories.js";

describe("task failure categories", () => {
  it("keeps Agent-accounting and fallback eligibility separate from infrastructure and policy failures", () => {
    const categories: TaskFailureCategory[] = [
      "agent_execution_error", "agent_timeout", "environment_bootstrap_failure", "dependency_install_failure",
      "verification_failure", "scope_violation", "policy_block", "connector_failure", "watcher_failure",
      "user_confirmation_required",
    ];
    const evidence = Object.fromEntries(categories.map((category) => [category, failureCategoryEvidence(category)]));
    assert.equal(evidence.agent_execution_error.counts_against_agent, true);
    assert.equal(evidence.agent_timeout.fallback_eligible, true);
    assert.equal(evidence.verification_failure.fallback_eligible, true);
    for (const category of ["environment_bootstrap_failure", "scope_violation", "policy_block", "connector_failure", "watcher_failure", "user_confirmation_required"]) {
      assert.equal(evidence[category].counts_against_agent, false, category);
    }
    assert.equal(evidence.connector_failure.retryable, true);
    assert.equal(evidence.connector_failure.fallback_eligible, false);
    assert.equal(evidence.policy_block.retryable, false);
  });
});
