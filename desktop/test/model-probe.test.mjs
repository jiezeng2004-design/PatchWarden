import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  buildModelProbeArgs,
  findModelProbeRecord,
  MODEL_PROBE_TTL_MS,
  modelProbeOutputMatches,
  verifyAgentModel,
} from "../dist/model-probe.js";

function detection(prefixArgs = []) {
  return {
    id: "codex",
    name: "codex",
    displayName: "Codex CLI",
    available: true,
    command: process.execPath,
    prefixArgs,
    executablePath: process.execPath,
    source: "native",
    supportsModelOverride: true,
    supportsModelRefresh: false,
    reason: null,
  };
}

describe("desktop model probes", () => {
  it("uses fixed no-write argv templates for Codex and Claude", () => {
    const codex = buildModelProbeArgs("codex", "gpt-safe", "nonce", "C:\\temp\\mcp.json");
    assert.deepEqual(codex.slice(0, 7), ["exec", "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral", "--color", "never"]);
    assert.ok(codex.includes("--model"));
    const claude = buildModelProbeArgs("claude", "claude-safe", "nonce", "C:\\temp\\mcp.json");
    assert.ok(claude.includes("--no-session-persistence"));
    assert.ok(claude.includes("--tools"));
    assert.equal(claude[claude.indexOf("--tools") + 1], "");
    assert.doesNotMatch(claude.join(" "), /acceptEdits|bypassPermissions/);
    assert.equal(modelProbeOutputMatches("codex", "nonce\n", "nonce"), true);
    assert.equal(modelProbeOutputMatches("codex", "Reply with exactly nonce", "nonce"), false);
    assert.equal(modelProbeOutputMatches("claude", JSON.stringify({ result: "nonce" }), "nonce"), true);
    assert.equal(modelProbeOutputMatches("claude", JSON.stringify({ result: "Reply with exactly nonce" }), "nonce"), false);
  });

  it("uses a fake owned CLI, persists a bounded result, and cleans the temporary directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "patchwarden-model-probe-"));
    const probeRoot = join(root, "probes");
    const cachePath = join(root, "cache.json");
    const fake = "const p=require('node:path'); const inside=(v)=>{const r=p.relative(process.cwd(),v||''); return r && r!=='..'&&!r.startsWith('..'+p.sep)&&!p.isAbsolute(r)}; const names=['HOME','USERPROFILE','APPDATA','LOCALAPPDATA','XDG_CONFIG_HOME','CODEX_HOME','CLAUDE_CONFIG_DIR']; if(names.some((n)=>!inside(process.env[n]))) process.exit(3); const prompt=process.argv.find((value)=>value.includes('PATCHWARDEN_MODEL_PROBE_'))||''; const nonce=prompt.match(/PATCHWARDEN_MODEL_PROBE_[a-f0-9]+/)?.[0]; console.log(nonce||'missing');";
    const result = await verifyAgentModel({
      agentId: "codex",
      modelId: "gpt-safe",
      detection: detection(["-e", fake]),
      probeRoot,
      cachePath,
      sourceEnvironment: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR },
    });
    assert.equal(result.status, "verified");
    assert.equal(result.reasonCode, "ok");
    assert.equal(readdirSync(probeRoot).length, 0);
    const cached = findModelProbeRecord(cachePath, "codex", "gpt-safe", detection(["-e", fake]));
    assert.equal(cached?.status, "verified");
    const checkedAt = Date.parse(cached.checkedAt);
    assert.equal(findModelProbeRecord(cachePath, "codex", "gpt-safe", detection(["-e", fake]), checkedAt + MODEL_PROBE_TTL_MS + 1), null);
    assert.equal(findModelProbeRecord(cachePath, "codex", "gpt-safe", detection(["-e", fake]), checkedAt - (6 * 60 * 1000)), null);
  });

  it("force-settles a timed-out owned CLI and cleans its temporary directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "patchwarden-model-timeout-"));
    const probeRoot = join(root, "probes");
    const cachePath = join(root, "cache.json");
    const fake = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
    const startedAt = Date.now();
    const result = await verifyAgentModel({
      agentId: "codex",
      modelId: "gpt-timeout",
      detection: detection(["-e", fake]),
      probeRoot,
      cachePath,
      probeTimeoutMs: 500,
      terminationGraceMs: 25,
      sourceEnvironment: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR },
    });
    assert.equal(result.status, "failed");
    assert.equal(result.reasonCode, "probe_timed_out");
    assert.ok(Date.now() - startedAt < 5_000, "timed-out probe must settle within its bounded fallback");
    assert.equal(readdirSync(probeRoot).length, 0);
    const cached = findModelProbeRecord(cachePath, "codex", "gpt-timeout", detection(["-e", fake]));
    assert.equal(cached?.reasonCode, "probe_timed_out");
  });

  it("classifies a nonzero exit without persisting stderr", async () => {
    const root = mkdtempSync(join(tmpdir(), "patchwarden-model-failure-"));
    const probeRoot = join(root, "probes");
    const cachePath = join(root, "cache.json");
    const fake = "console.error('authentication failed forbidden-secret'); process.exit(7);";
    const result = await verifyAgentModel({
      agentId: "codex",
      modelId: "gpt-auth-failure",
      detection: detection(["-e", fake]),
      probeRoot,
      cachePath,
      sourceEnvironment: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR },
    });
    assert.equal(result.reasonCode, "authentication_failed");
    assert.equal(result.exitCode, 7);
    assert.equal(readdirSync(probeRoot).length, 0);
    assert.doesNotMatch(readFileSync(cachePath, "utf8"), /forbidden-secret|authentication failed/);
  });

  it("fails OpenCode verification closed without launching a model", async () => {
    const root = mkdtempSync(join(tmpdir(), "patchwarden-opencode-probe-"));
    const result = await verifyAgentModel({
      agentId: "opencode",
      modelId: "agnes/agnes-2.0-flash",
      detection: { ...detection(), id: "opencode", name: "opencode", displayName: "OpenCode" },
      probeRoot: join(root, "probes"),
      cachePath: join(root, "cache.json"),
    });
    assert.deepEqual({ status: result.status, reason: result.reasonCode }, { status: "unsupported_safe_probe", reason: "unsupported_safe_probe" });
  });
});

