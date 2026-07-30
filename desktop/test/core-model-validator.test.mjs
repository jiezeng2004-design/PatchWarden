import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  CoreModelValidationError,
  validateAgentSelectionsWithCore,
} from "../dist/core-model-validator.js";

function fakeCore() {
  const root = mkdtempSync(join(tmpdir(), "patchwarden-core-model-validator-"));
  const agents = join(root, "dist", "agents");
  mkdirSync(agents, { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(agents, "modelSelection.js"), `
    export function optionalModel(value) {
      if (value === undefined || value === null || value === "") return null;
      if (typeof value !== "string" || !/^core-validated\\/[a-z0-9-]+$/.test(value.trim())) throw new Error("invalid");
      return value.trim();
    }
  `);
  return root;
}

describe("desktop Core model validator bridge", () => {
  it("uses Core's exported optionalModel before returning selections", async () => {
    const result = await validateAgentSelectionsWithCore(fakeCore(), [
      { id: "codex", enabled: true, model: " core-validated/model-a ", envAllowlist: ["OPENAI_API_KEY"] },
      { id: "claude", enabled: true, model: null },
    ]);
    assert.equal(result[0].model, "core-validated/model-a");
    assert.deepEqual(result[0].envAllowlist, ["OPENAI_API_KEY"]);
    assert.equal(result[1].model, null);
  });

  it("fails closed with a safe reason when Core rejects a model or is unavailable", async () => {
    await assert.rejects(
      validateAgentSelectionsWithCore(fakeCore(), [{ id: "codex", model: "desktop-only-model" }]),
      (error) => error instanceof CoreModelValidationError && error.reasonCode === "invalid_model",
    );
    await assert.rejects(
      validateAgentSelectionsWithCore(join(tmpdir(), "missing-patchwarden-core"), [{ id: "codex", model: "core-validated/model-a" }]),
      (error) => error instanceof CoreModelValidationError && error.reasonCode === "save_failed",
    );
  });
});

