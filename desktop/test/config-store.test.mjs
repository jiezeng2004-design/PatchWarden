import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  atomicWriteJson,
  buildConfig,
  readJson,
  readPreferences,
  resolveDesktopLanguage,
  readRuntimeSettings,
  resolveDesktopPaths,
  updatePreferences,
  updateAgentSettings,
  updateRuntimeSettings,
} from "../dist/config-store.js";

describe("desktop config store", () => {
  it("uses PATCHWARDEN_CONFIG before the LocalAppData default", () => {
    const paths = resolveDesktopPaths({ LOCALAPPDATA: "C:\\Local", PATCHWARDEN_CONFIG: "C:\\custom\\config.json" }, "C:\\UserData");
    assert.match(paths.config, /custom[\\/]config\.json$/i);
  });

  it("backs up existing configuration before an atomic update", () => {
    const root = mkdtempSync(join(tmpdir(), "patchwarden-desktop-config-"));
    const configPath = join(root, "patchwarden.config.json");
    atomicWriteJson(configPath, { workspaceRoot: "one" }, true);
    atomicWriteJson(configPath, { workspaceRoot: "two" }, true);
    assert.equal(readJson(configPath).workspaceRoot, "two");
    assert.equal(readdirSync(root).filter((name) => name.includes(".bak-")).length, 1);
    assert.equal(readdirSync(root).filter((name) => name.includes(`.tmp-${process.pid}-`)).length, 0);
  });

  it("accepts only fixed desktop preferences", () => {
    const root = mkdtempSync(join(tmpdir(), "patchwarden-desktop-prefs-"));
    const path = join(root, "prefs.json");
    updatePreferences(path, { theme: "dark", closeBehavior: "quit" });
    assert.deepEqual(readPreferences(path), { theme: "dark", closeBehavior: "quit", language: "system", connectionMode: "chatgpt" });
    assert.deepEqual(updatePreferences(path, { theme: "purple", closeBehavior: "shell", language: "fr" }), { theme: "dark", closeBehavior: "quit", language: "system", connectionMode: "chatgpt" });
    assert.equal(updatePreferences(path, { language: "en" }).language, "en");
  });

  it("resolves system language from Windows locale and preserves manual choice", () => {
    assert.equal(resolveDesktopLanguage("system", "zh-CN"), "zh-CN");
    assert.equal(resolveDesktopLanguage("system", "en-US"), "en");
    assert.equal(resolveDesktopLanguage("en", "zh-CN"), "en");
    assert.equal(resolveDesktopLanguage("zh-CN", "en-US"), "zh-CN");
  });

  it("builds only supported detected agent registrations", () => {
    const config = buildConfig("C:\\workspace", [
      { name: "codex", available: true, executablePath: "C:\\tools\\codex.exe" },
      { name: "unknown", available: true, executablePath: "C:\\bad.exe" },
    ]);
    assert.deepEqual(Object.keys(config.agents), ["codex"]);
    assert.equal(config.agents.codex.command, "C:\\tools\\codex.exe");
  });

  it("updates Direct, tunnel path, and proxy settings with a backup", () => {
    const root = mkdtempSync(join(tmpdir(), "patchwarden-desktop-runtime-"));
    const path = join(root, "patchwarden.config.json");
    atomicWriteJson(path, buildConfig("C:\\workspace", []), false);
    const next = updateRuntimeSettings(path, {
      tunnelClientPath: "C:\\tools\\tunnel-client.exe",
      enableDirectProfile: true,
      tunnelProxy: {
        scope: "separate",
        core: { mode: "manual", url: "http://127.0.0.1:7890" },
        direct: { mode: "none" },
      },
    });
    assert.equal(next.enableDirectProfile, true);
    assert.equal(next.tunnelProxy.scope, "separate");
    assert.equal(readRuntimeSettings(path).tunnelClientPath, "C:\\tools\\tunnel-client.exe");
    assert.equal(readdirSync(root).filter((name) => name.includes(".bak-")).length, 1);
  });

  it("rejects proxy credentials and unsupported protocols", () => {
    const root = mkdtempSync(join(tmpdir(), "patchwarden-desktop-proxy-"));
    const path = join(root, "patchwarden.config.json");
    atomicWriteJson(path, buildConfig("C:\\workspace", []), false);
    assert.throws(() => updateRuntimeSettings(path, {
      tunnelProxy: { scope: "shared", core: { mode: "manual", url: "http://user:secret@127.0.0.1:7890" }, direct: { mode: "environment" } },
    }), /不能包含用户名或密码/);
    assert.throws(() => updateRuntimeSettings(path, {
      tunnelProxy: { scope: "shared", core: { mode: "manual", url: "file:///tmp/proxy" }, direct: { mode: "environment" } },
    }), /仅支持/);
  });

  it("merges managed agents while preserving custom registrations", () => {
    const root = mkdtempSync(join(tmpdir(), "patchwarden-desktop-agents-"));
    const path = join(root, "patchwarden.config.json");
    const config = buildConfig("C:\\workspace", []);
    config.agents.custom = { command: "custom-agent", args: ["{prompt}"] };
    atomicWriteJson(path, config, false);
    const settings = updateAgentSettings(path, [{ id: "codex", available: true, command: "C:\\tools\\codex.exe", prefixArgs: [] }], [{ id: "codex", enabled: true, model: "gpt-codex" }]);
    const updated = readJson(path);
    assert.ok(updated.agents.custom);
    assert.equal(updated.agents.codex.model, "gpt-codex");
    assert.ok(settings.some((item) => item.id === "custom" && item.managed === false));
  });

  it("preserves an existing managed registration while its CLI is temporarily unavailable", () => {
    const root = mkdtempSync(join(tmpdir(), "patchwarden-desktop-agents-offline-"));
    const path = join(root, "patchwarden.config.json");
    const config = buildConfig("C:\\workspace", [
      { id: "codex", available: true, command: "C:\\tools\\codex.exe", prefixArgs: [] },
    ]);
    atomicWriteJson(path, config, false);
    updateAgentSettings(path, [{ id: "codex", available: false, command: null }], [{ id: "codex", enabled: true, model: null }]);
    assert.deepEqual(readJson(path).agents.codex, config.agents.codex);
  });

  it("preserves an explicit provider environment allowlist when refreshing a managed agent", () => {
    const root = mkdtempSync(join(tmpdir(), "patchwarden-desktop-agent-env-"));
    const path = join(root, "patchwarden.config.json");
    const config = buildConfig("C:\\workspace", [
      { id: "codex", available: true, command: "C:\\tools\\codex.exe", prefixArgs: [] },
    ]);
    config.agents.codex.envAllowlist = ["OPENAI_API_KEY", "HTTPS_PROXY"];
    atomicWriteJson(path, config, false);
    updateAgentSettings(path, [{ id: "codex", available: true, command: "C:\\tools\\codex.exe", prefixArgs: [] }], [{ id: "codex", enabled: true, model: "gpt-codex" }]);
    assert.deepEqual(readJson(path).agents.codex.envAllowlist, ["OPENAI_API_KEY", "HTTPS_PROXY"]);
  });
});
