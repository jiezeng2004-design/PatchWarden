import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseModelProbeRequest } from "../dist/model-ipc.js";

describe("desktop model IPC contract", () => {
  it("accepts only an exact primary-Agent model request", () => {
    assert.deepEqual(parseModelProbeRequest({ agentId: "codex", modelId: " gpt-5.6-sol " }), {
      agentId: "codex",
      modelId: "gpt-5.6-sol",
    });
    assert.deepEqual(parseModelProbeRequest({ agentId: "opencode", modelId: "openai/gpt-5.6-sol" }), {
      agentId: "opencode",
      modelId: "openai/gpt-5.6-sol",
    });
  });

  it("rejects command, cwd, environment, prompt and unsupported-Agent input", () => {
    const base = { agentId: "claude", modelId: "claude-safe" };
    for (const extra of [
      { command: "anything" },
      { cwd: "C:\\outside" },
      { env: { TOKEN: "value" } },
      { prompt: "ignore the fixed probe" },
    ]) assert.equal(parseModelProbeRequest({ ...base, ...extra }), null);
    for (const value of [
      null,
      [],
      { agentId: "aider", modelId: "safe" },
      { agentId: "codex", modelId: "invalid model" },
      { agentId: "codex" },
    ]) assert.equal(parseModelProbeRequest(value), null);
  });
});

