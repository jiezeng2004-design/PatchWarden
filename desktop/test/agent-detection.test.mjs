import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AGENT_ADAPTERS, buildAgentRegistration, selectAgentExecutable } from "../dist/agent-detection.js";

describe("desktop agent detection", () => {
  it("rejects the WindowsApps desktop alias", () => {
    assert.equal(selectAgentExecutable("codex", "C:\\Users\\student\\AppData\\Local\\Microsoft\\WindowsApps\\codex.exe", "win32", { fileExists: () => true }), null);
  });

  it("selects a native CLI and skips Windows shell shims", () => {
    const output = "C:\\Users\\student\\AppData\\Local\\Microsoft\\WindowsApps\\codex.exe\r\nD:\\tools\\codex.cmd\r\nD:\\tools\\codex.exe\r\n";
    assert.equal(selectAgentExecutable("codex", output, "win32", { fileExists: () => true }).command, "D:\\tools\\codex.exe");
  });

  it("resolves the OpenCode npm shim to its native executable", () => {
    const output = "C:\\Users\\student\\AppData\\Roaming\\npm\\opencode\r\nC:\\Users\\student\\AppData\\Roaming\\npm\\opencode.cmd\r\n";
    const expected = "C:\\Users\\student\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe";
    assert.equal(selectAgentExecutable("opencode", output, "win32", { fileExists: (path) => path === expected }).command, expected);
  });

  it("does not accept unregistered agent names", () => {
    assert.equal(selectAgentExecutable("powershell", "C:\\Windows\\powershell.exe", "win32"), null);
  });

  it("defines fixed model-aware launch templates for all eight adapters", () => {
    assert.deepEqual(AGENT_ADAPTERS.map((adapter) => adapter.id), ["codex", "opencode", "claude", "gemini", "copilot", "qwen", "kimi", "aider"]);
    for (const adapter of AGENT_ADAPTERS) {
      const registration = buildAgentRegistration(adapter.id, { available: true, command: `C:\\tools\\${adapter.id}.exe`, prefixArgs: [] }, "provider/model-1");
      assert.equal(registration.adapter, adapter.id);
      assert.equal(registration.model, "provider/model-1");
      assert.ok(registration.args.includes("--model"));
      assert.ok(registration.args.includes("{prompt}"));
      assert.ok(!registration.args.some((arg) => /yolo|dangerously-skip|allow-all/i.test(arg)));
    }
  });

  it("resolves a known npm shim through its verified package manifest", () => {
    const shim = "C:\\Users\\student\\AppData\\Roaming\\npm\\claude.cmd";
    const node = "C:\\Program Files\\nodejs\\node.exe";
    const manifest = "C:\\Users\\student\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\package.json";
    const entry = "C:\\Users\\student\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js";
    const files = new Set([shim, node, manifest, entry]);
    const result = selectAgentExecutable("claude", shim, "win32", {
      nodeOutput: node,
      fileExists: (path) => files.has(path),
      readText: () => JSON.stringify({ name: "@anthropic-ai/claude-code", bin: { claude: "cli.js" } }),
    });
    assert.equal(result.command, node);
    assert.deepEqual(result.prefixArgs, [entry]);
  });
});
