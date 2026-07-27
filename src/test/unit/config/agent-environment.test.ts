import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  getAgentConfigRevision,
  getAgentRuntimeMetadata,
  refreshAgentConfig,
  reloadConfig,
} from "../../../config.js";

describe("agent environment configuration", () => {
  let root: string;
  let previousConfigPath: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pw-agent-env-config-"));
    previousConfigPath = process.env.PATCHWARDEN_CONFIG;
  });
  afterEach(() => {
    if (previousConfigPath === undefined) delete process.env.PATCHWARDEN_CONFIG;
    else process.env.PATCHWARDEN_CONFIG = previousConfigPath;
    rmSync(root, { recursive: true, force: true });
  });

  it("normalizes an explicit per-agent environment allowlist", () => {
    const configPath = writeConfig(root, ["OPENAI_API_KEY", "HTTPS_PROXY", "OPENAI_API_KEY"]);
    const config = reloadConfig(configPath);
    assert.deepEqual(config.agents.codex.envAllowlist, ["OPENAI_API_KEY", "HTTPS_PROXY"]);
  });

  it("rejects Tunnel and HTTP owner credentials in an agent allowlist", () => {
    for (const reserved of ["CONTROL_PLANE_API_KEY", "PATCHWARDEN_CUSTOM_OWNER_TOKEN"]) {
      const configPath = writeConfig(root, [reserved], "PATCHWARDEN_CUSTOM_OWNER_TOKEN");
      assert.throws(() => reloadConfig(configPath), /envAllowlist cannot include reserved variable/);
    }
  });

  it("hot reloads Agent-only model changes and changes the revision", () => {
    const configPath = writeManagedConfig(root, "provider/model-a");
    process.env.PATCHWARDEN_CONFIG = configPath;
    const initial = reloadConfig(configPath);
    const initialRuntime = getAgentRuntimeMetadata("opencode", initial);
    writeManagedConfig(root, "provider/model-b", configPath);
    const refreshed = refreshAgentConfig();
    const runtime = getAgentRuntimeMetadata("opencode", refreshed);
    assert.equal(runtime.effective_model, "provider/model-b");
    assert.notEqual(runtime.agent_config_revision, initialRuntime.agent_config_revision);
    assert.equal(runtime.model_argument_present, true);
    assert.equal(runtime.requested_agent, "opencode");
    assert.equal(runtime.selected_agent, "opencode");
    assert.equal(runtime.provider, "provider");
    assert.equal(runtime.fallback_used, false);
    assert.equal(runtime.exit_code, null);
  });

  it("rejects non-Agent changes during hot reload", () => {
    const configPath = writeManagedConfig(root, "provider/model-a");
    process.env.PATCHWARDEN_CONFIG = configPath;
    reloadConfig(configPath);
    const otherRoot = join(root, "other");
    mkdirSync(otherRoot);
    writeFileSync(configPath, JSON.stringify(managedConfig(otherRoot, "provider/model-b")), "utf-8");
    assert.throws(() => refreshAgentConfig(), /non-Agent runtime settings changed/);
  });

  it("fails closed when managed model metadata and CLI arguments disagree", () => {
    const configPath = join(root, "managed-mismatch.json");
    const value = managedConfig(root, "provider/model-a");
    value.agents.opencode.args = ["run", "--model", "provider/model-b", "{prompt}"];
    writeFileSync(configPath, JSON.stringify(value), "utf-8");
    process.env.PATCHWARDEN_CONFIG = configPath;
    reloadConfig(configPath);
    assert.throws(() => refreshAgentConfig(), /model metadata does not match/);
  });

  it("infers a legacy CLI model argument when model metadata is absent", () => {
    const configPath = join(root, "legacy-model.json");
    const value = managedConfig(root, "provider/model-a");
    const { model: _model, ...legacyAgent } = value.agents.opencode;
    value.agents.opencode = legacyAgent as typeof value.agents.opencode;
    writeFileSync(configPath, JSON.stringify(value), "utf-8");
    const config = reloadConfig(configPath);
    const runtime = getAgentRuntimeMetadata("opencode", config);
    assert.equal(runtime.effective_model, "provider/model-a");
    assert.equal(runtime.model_argument_present, true);
  });

  it("records no model argument when no model override is configured", () => {
    const configPath = join(root, "default-model.json");
    writeFileSync(configPath, JSON.stringify({
      workspaceRoot: root,
      agents: {
        codex: {
          command: process.execPath,
          adapter: "codex",
          args: ["-e", "process.exit(0)", "{prompt}"],
        },
      },
    }), "utf-8");
    const config = reloadConfig(configPath);
    const runtime = getAgentRuntimeMetadata("codex", config);

    assert.equal(runtime.effective_model, null);
    assert.equal(runtime.model_argument_present, false);
  });

  it("keeps revisions stable across key order and unrelated config while tracking model policy inputs", () => {
    const base = {
      workspaceRoot: root,
      agents: {
        claude: {
          command: "claude",
          args: ["-p", "{prompt}"],
          adapter: "claude",
          default_model: "claude/model-a",
          available_models: ["claude/model-a"],
          allow_unlisted_model_override: false,
          settings_policy: "inherit" as const,
        },
      },
      repoAgentDefaults: { repo: { claude: "claude/model-a" } },
      allowedTestCommands: ["npm test"],
    } as any;
    const reordered = {
      ...base,
      unrelated: "ignored",
      agents: { claude: {
        settings_policy: "inherit",
        allow_unlisted_model_override: false,
        available_models: ["claude/model-a"],
        default_model: "claude/model-a",
        adapter: "claude",
        args: ["-p", "{prompt}"],
        command: "claude",
      } },
    } as any;
    const revision = getAgentConfigRevision(base);
    assert.equal(getAgentConfigRevision(reordered), revision);
    for (const changed of [
      { ...base, agents: { claude: { ...base.agents.claude, default_model: "claude/model-b" } } },
      { ...base, agents: { claude: { ...base.agents.claude, available_models: ["claude/model-b"] } } },
      { ...base, agents: { claude: { ...base.agents.claude, settings_policy: "isolated" } } },
      { ...base, repoAgentDefaults: { repo: { claude: "claude/model-b" } } },
    ]) {
      assert.notEqual(getAgentConfigRevision(changed as any), revision);
    }
  });

  it("rejects an unlisted repository model before any task can start", () => {
    const configPath = join(root, "repo-model-not-allowed.json");
    writeFileSync(configPath, JSON.stringify({
      workspaceRoot: root,
      agents: {
        opencode: {
          command: "opencode",
          args: ["run", "{prompt}"],
          adapter: "opencode",
          available_models: ["agnes/allowed"],
          allow_unlisted_model_override: false,
        },
      },
      repoAgentDefaults: { repo: { opencode: "agnes/blocked" } },
    }), "utf-8");
    assert.throws(() => reloadConfig(configPath), /not present in available_models/);
  });
});

function managedConfig(workspaceRoot: string, model: string) {
  return {
    workspaceRoot,
    agents: {
      opencode: {
        command: process.execPath,
        adapter: "opencode",
        model,
        args: ["run", "--model", model, "{prompt}"],
      },
    },
  };
}

function writeManagedConfig(root: string, model: string, path = join(root, "managed.json")): string {
  writeFileSync(path, JSON.stringify(managedConfig(root, model)), "utf-8");
  return path;
}

function writeConfig(root: string, envAllowlist: string[], ownerTokenEnv?: string): string {
  const configPath = join(root, `config-${Math.random().toString(16).slice(2)}.json`);
  writeFileSync(configPath, JSON.stringify({
    workspaceRoot: root,
    agents: {
      codex: {
        command: process.execPath,
        args: ["-e", "console.log('ok')"],
        envAllowlist,
      },
    },
    ...(ownerTokenEnv ? { http: { ownerTokenEnv } } : {}),
  }), "utf-8");
  return configPath;
}
