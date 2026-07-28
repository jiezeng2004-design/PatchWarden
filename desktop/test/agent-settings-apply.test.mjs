import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluateAgentSettingsApplication } from "../dist/agent-settings-apply.js";

const revision = "a".repeat(64);
const response = (agents) => ({ agents });

describe("desktop Agent settings application", () => {
  it("accepts Core's canonical revision without rebuilding it in Desktop", () => {
    const result = evaluateAgentSettingsApplication(
      [{ id: "opencode", enabled: true, model: "agnes/agnes-2.0-flash" }],
      response([{ name: "opencode", effective_model: "agnes/agnes-2.0-flash", invocation_ready: true, agent_config_revision: revision }]),
    );
    assert.deepEqual(result, { applied: true, reason: "applied" });
  });

  it("requires restart when Core still reports an old effective model", () => {
    const result = evaluateAgentSettingsApplication(
      [{ id: "opencode", enabled: true, model: "agnes/agnes-2.0-flash" }],
      response([{ name: "opencode", effective_model: null, invocation_ready: true, agent_config_revision: revision }]),
    );
    assert.deepEqual(result, { applied: false, reason: "backend_stale" });
  });

  it("requires disabled registrations to disappear from Core", () => {
    const result = evaluateAgentSettingsApplication(
      [{ id: "claude", enabled: false, model: null }],
      response([{ name: "claude", effective_model: null, invocation_ready: true, agent_config_revision: revision }]),
    );
    assert.deepEqual(result, { applied: false, reason: "backend_stale" });
  });

  it("rejects missing, malformed, or split Core revisions", () => {
    const selection = [
      { id: "opencode", enabled: true, model: "model-a" },
      { id: "claude", enabled: true, model: "model-b" },
    ];
    const missing = evaluateAgentSettingsApplication(selection, response([
      { name: "opencode", effective_model: "model-a", invocation_ready: true },
      { name: "claude", effective_model: "model-b", invocation_ready: true, agent_config_revision: revision },
    ]));
    const split = evaluateAgentSettingsApplication(selection, response([
      { name: "opencode", effective_model: "model-a", invocation_ready: true, agent_config_revision: revision },
      { name: "claude", effective_model: "model-b", invocation_ready: true, agent_config_revision: "b".repeat(64) },
    ]));
    assert.deepEqual(missing, { applied: false, reason: "backend_stale" });
    assert.deepEqual(split, { applied: false, reason: "backend_stale" });
  });

  it("treats a missing Core response as unavailable", () => {
    assert.deepEqual(
      evaluateAgentSettingsApplication([{ id: "opencode", enabled: true, model: "model-a" }], null),
      { applied: false, reason: "backend_unavailable" },
    );
  });
});
