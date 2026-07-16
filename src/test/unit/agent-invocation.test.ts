import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveAgentExecutable } from "../../runner/agentInvocation.js";

describe("agent executable resolution", () => {
  it("resolves an existing OpenCode npm shim to the native Windows executable", () => {
    const shim = "C:\\Users\\student\\AppData\\Roaming\\npm\\opencode.cmd";
    const native = "C:\\Users\\student\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe";
    assert.equal(resolveAgentExecutable("opencode", shim, "win32", "", (path) => path === native), native);
  });

  it("does not route unsupported wrappers through a shell", () => {
    const shim = "C:\\tools\\custom-opencode.cmd";
    assert.equal(resolveAgentExecutable("opencode", shim, "win32", "", () => false), shim);
    assert.equal(resolveAgentExecutable("codex", shim, "win32", "", () => true), shim);
  });
});
