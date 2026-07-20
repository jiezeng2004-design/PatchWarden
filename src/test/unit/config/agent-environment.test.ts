import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { reloadConfig } from "../../../config.js";

describe("agent environment configuration", () => {
  let root: string;

  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "pw-agent-env-config-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

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
});

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
