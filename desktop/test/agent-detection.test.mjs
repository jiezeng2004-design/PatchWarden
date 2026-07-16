import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { selectAgentExecutable } from "../src/agent-detection.mjs";

describe("desktop agent detection", () => {
  it("rejects the WindowsApps desktop alias", () => {
    assert.equal(selectAgentExecutable("codex", "C:\\Users\\student\\AppData\\Local\\Microsoft\\WindowsApps\\codex.exe", "win32"), null);
  });

  it("selects a native CLI and skips Windows shell shims", () => {
    const output = "C:\\Users\\student\\AppData\\Local\\Microsoft\\WindowsApps\\codex.exe\r\nD:\\tools\\codex.cmd\r\nD:\\tools\\codex.exe\r\n";
    assert.equal(selectAgentExecutable("codex", output, "win32"), "D:\\tools\\codex.exe");
  });

  it("resolves the OpenCode npm shim to its native executable", () => {
    const output = "C:\\Users\\student\\AppData\\Roaming\\npm\\opencode\r\nC:\\Users\\student\\AppData\\Roaming\\npm\\opencode.cmd\r\n";
    const expected = "C:\\Users\\student\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe";
    assert.equal(selectAgentExecutable("opencode", output, "win32", (path) => path === expected), expected);
  });

  it("does not accept unregistered agent names", () => {
    assert.equal(selectAgentExecutable("powershell", "C:\\Windows\\powershell.exe", "win32"), null);
  });
});
