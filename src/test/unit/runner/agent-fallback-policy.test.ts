import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { decideAgentTransition } from "../../../runner/agentFallbackPolicy.js";

const base = {
  current_agent: "opencode",
  current_agent_attempt: 1,
  priority: ["opencode", "claude", "codex"],
  max_retries_per_agent: 1,
  fallback_on: ["agent_execution_error", "agent_timeout", "verification_failure"] as const,
  do_not_fallback_on: ["policy_block", "scope_violation", "user_confirmation_required", "connector_failure", "watcher_failure"] as const,
};

describe("Agent fallback policy", () => {
  it("retries the same Agent before moving to the next configured Agent", () => {
    const retry = decideAgentTransition({ ...base, fallback_on: [...base.fallback_on], do_not_fallback_on: [...base.do_not_fallback_on], failure_category: "agent_execution_error" });
    assert.equal(retry.action, "retry_same_agent");
    assert.equal(retry.next_agent, "opencode");
    assert.equal(retry.consumes_agent_retry, true);

    const fallback = decideAgentTransition({ ...base, fallback_on: [...base.fallback_on], do_not_fallback_on: [...base.do_not_fallback_on], current_agent_attempt: 2, failure_category: "agent_execution_error" });
    assert.equal(fallback.action, "switch_agent");
    assert.equal(fallback.next_agent, "claude");
    assert.equal(fallback.consumes_agent_retry, false);
  });

  it("never changes Agent for policy, scope, confirmation, connector, or watcher failures", () => {
    for (const category of ["policy_block", "scope_violation", "user_confirmation_required"] as const) {
      const decision = decideAgentTransition({ ...base, fallback_on: [...base.fallback_on], do_not_fallback_on: [...base.do_not_fallback_on], failure_category: category });
      assert.equal(decision.action, "stop", category);
    }
    const connector = decideAgentTransition({ ...base, fallback_on: [...base.fallback_on], do_not_fallback_on: [...base.do_not_fallback_on], failure_category: "connector_failure" });
    assert.equal(connector.action, "recover_connector");
    assert.equal(connector.consumes_agent_retry, false);
    const watcher = decideAgentTransition({ ...base, fallback_on: [...base.fallback_on], do_not_fallback_on: [...base.do_not_fallback_on], failure_category: "watcher_failure" });
    assert.equal(watcher.action, "recover_watcher");
    assert.equal(watcher.consumes_agent_retry, false);
  });
});
