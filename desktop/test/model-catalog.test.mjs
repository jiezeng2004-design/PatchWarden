import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseOpenCodeModelOutput } from "../dist/agent-adapters.js";
import {
  executableCatalogFingerprint,
  findModelCatalogCache,
  MODEL_CATALOG_TTL_MS,
  modelCatalogStrategy,
  workspaceCatalogKey,
  writeModelCatalogCache,
} from "../dist/model-catalog.js";

function detection() {
  return { command: process.execPath, executablePath: process.execPath, prefixArgs: [], available: true };
}

describe("desktop model catalog cache", () => {
  it("parses only exact OpenCode provider/model rows", () => {
    const models = parseOpenCodeModelOutput([
      "\u001b[32mopenai/gpt-5.6-sol\u001b[0m",
      "https://example.invalid/model",
      "plain-heading",
      "agnes/agnes-2.0-flash",
      "o4-mini",
    ].join("\n"));
    assert.deepEqual(models.map((item) => item.id), ["agnes/agnes-2.0-flash", "openai/gpt-5.6-sol"]);
  });

  it("persists only safe model metadata scoped to workspace and executable", () => {
    const root = mkdtempSync(join(tmpdir(), "patchwarden-model-catalog-"));
    const cachePath = join(root, "catalog.json");
    const workspace = join(root, "workspace");
    const agent = detection();
    const entry = writeModelCatalogCache(cachePath, "opencode", workspace, agent, [
      { id: "agnes/agnes-2.0-flash", label: "untrusted-label", source: "secret-path" },
    ]);
    const cached = findModelCatalogCache(cachePath, "opencode", workspace, agent);
    assert.equal(cached?.models[0]?.id, "agnes/agnes-2.0-flash");
    assert.equal(cached?.models[0]?.label, "agnes/agnes-2.0-flash");
    assert.equal(cached?.models[0]?.source, "Agent CLI cache");
    const serialized = readFileSync(cachePath, "utf8");
    assert.doesNotMatch(serialized, /untrusted-label|secret-path/);
    assert.equal(findModelCatalogCache(cachePath, "opencode", join(root, "other"), agent), null);
    const refreshedAt = Date.parse(entry.refreshedAt);
    assert.equal(findModelCatalogCache(cachePath, "opencode", workspace, agent, refreshedAt + MODEL_CATALOG_TTL_MS + 1), null);
    assert.equal(findModelCatalogCache(cachePath, "opencode", workspace, agent, refreshedAt - (6 * 60 * 1000)), null);
    assert.match(entry.workspaceKey, /^[a-f0-9]{64}$/);
  });

  it("derives empty cache state from normalized models", () => {
    const root = mkdtempSync(join(tmpdir(), "patchwarden-model-catalog-empty-"));
    const entry = writeModelCatalogCache(join(root, "catalog.json"), "opencode", join(root, "workspace"), detection(), [
      { id: "invalid model id", label: "ignored", source: "ignored" },
    ]);
    assert.deepEqual({ state: entry.state, reasonCode: entry.reasonCode, models: entry.models }, {
      state: "empty",
      reasonCode: "catalog_empty",
      models: [],
    });
  });

  it("keeps catalog strategy explicit and fingerprints without returning paths", () => {
    assert.equal(modelCatalogStrategy("opencode"), "opencode_cli");
    assert.equal(modelCatalogStrategy("codex"), "config_only");
    assert.match(workspaceCatalogKey("C:\\workspace"), /^[a-f0-9]{64}$/);
    assert.match(executableCatalogFingerprint(detection()), /^[a-f0-9]{64}$/);
  });
});

