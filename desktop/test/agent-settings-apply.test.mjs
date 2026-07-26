import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeAgentConfigRevision, evaluateAgentSettingsApplication } from "../dist/agent-settings-apply.js";

const agents = {
  opencode: {
    command: "opencode",
    args: ["run", "--model", "agnes/agnes-2.0-flash"],
    adapter: "opencode",
    model: "agnes/agnes-2.0-flash",
  },
};
const revision = computeAgentConfigRevision(agents);

describe("desktop Agent settings application", () => {
  it("accepts only the model loaded by the running Core", () => {
    const result = evaluateAgentSettingsApplication(
      [{ id: "opencode", enabled: true, model: "agnes/agnes-2.0-flash" }],
      revision,
      { agents: [{ name: "opencode", model: "agnes/agnes-2.0-flash", invocation_ready: true, agent_config_revision: revision }] },
    );
    assert.deepEqual(result, { applied: true, reason: "applied" });
  });

  it("requires restart when the running Core still reports its old model", () => {
    const result = evaluateAgentSettingsApplication(
      [{ id: "opencode", enabled: true, model: "agnes/agnes-2.0-flash" }],
      revision,
      { agents: [{ name: "opencode", model: null, invocation_ready: true, agent_config_revision: revision }] },
    );
    assert.deepEqual(result, { applied: false, reason: "backend_stale" });
  });

  it("requires disabled registrations to disappear from the running Core", () => {
    const result = evaluateAgentSettingsApplication(
      [{ id: "claude", enabled: false, model: null }],
      revision,
      { agents: [{ name: "claude", model: null, invocation_ready: true }] },
    );
    assert.equal(result.applied, false);
  });

  it("requires restart when the Core revision does not match the saved config", () => {
    const result = evaluateAgentSettingsApplication(
      [{ id: "opencode", enabled: true, model: "agnes/agnes-2.0-flash" }],
      revision,
      { agents: [{ name: "opencode", model: "agnes/agnes-2.0-flash", invocation_ready: true, agent_config_revision: "0".repeat(64) }] },
    );
    assert.deepEqual(result, { applied: false, reason: "backend_stale" });
  });

  it("normalizes the default env allowlist exactly once before hashing", () => {
    assert.equal(revision, computeAgentConfigRevision({
      opencode: { ...agents.opencode, envAllowlist: [] },
    }));
  });
});
