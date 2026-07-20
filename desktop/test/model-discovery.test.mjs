import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { discoverModelsForAgent } from "../dist/model-discovery.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "patchwarden-models-"));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  mkdirSync(home, { recursive: true }); mkdirSync(workspace, { recursive: true });
  return { root, home, workspace };
}

describe("desktop model discovery", () => {
  it("extracts only allowed OpenCode model fields and never returns credentials", () => {
    const { home, workspace } = fixture();
    const configDir = join(home, ".config", "opencode"); mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "opencode.jsonc"), `{
      // local config
      "model": "openai/gpt-safe",
      "provider": { "private": { "apiKey": "forbidden-secret", "models": { "coder": { "token": "hidden" } } } }
    }`);
    const result = discoverModelsForAgent("opencode", workspace, {}, home);
    assert.deepEqual(result.models.map((item) => item.id), ["openai/gpt-safe", "private/coder"]);
    assert.doesNotMatch(JSON.stringify(result), /forbidden-secret|hidden|apiKey/);
  });

  it("reads Codex profiles, Kimi model tables, and Aider YAML without env files", () => {
    const { home, workspace } = fixture();
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "config.toml"), `model = "gpt-main"\n[profiles.fast]\nmodel = "gpt-fast"\n`);
    mkdirSync(join(home, ".kimi"), { recursive: true });
    writeFileSync(join(home, ".kimi", "config.toml"), `default_model = "kimi-main"\n[models.kimi-alt]\nprovider = "x"\n`);
    writeFileSync(join(home, ".aider.conf.yml"), "model: openrouter/coder\napi-key: forbidden-secret\n");
    assert.deepEqual(discoverModelsForAgent("codex", workspace, {}, home).models.map((item) => item.id), ["gpt-fast", "gpt-main"]);
    assert.deepEqual(discoverModelsForAgent("kimi", workspace, {}, home).models.map((item) => item.id), ["kimi-alt", "kimi-main"]);
    const aider = discoverModelsForAgent("aider", workspace, {}, home);
    assert.deepEqual(aider.models.map((item) => item.id), ["openrouter/coder"]);
    assert.doesNotMatch(JSON.stringify(aider), /forbidden-secret/);
  });

  it("rejects symbolic-link config files", () => {
    const { root, home, workspace } = fixture();
    const target = join(root, "target.json"); writeFileSync(target, '{"model":"must-not-load"}');
    mkdirSync(join(home, ".gemini"), { recursive: true });
    try { symlinkSync(target, join(home, ".gemini", "settings.json")); }
    catch { return; }
    assert.deepEqual(discoverModelsForAgent("gemini", workspace, {}, home).models, []);
  });

  it("rejects workspace config reached through a directory link outside the workspace", () => {
    const { root, home, workspace } = fixture();
    const outside = join(root, "outside"); mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "settings.json"), '{"model":"must-not-load"}');
    try { symlinkSync(outside, join(workspace, ".gemini"), "junction"); }
    catch { return; }
    assert.deepEqual(discoverModelsForAgent("gemini", workspace, {}, home).models, []);
  });
});
