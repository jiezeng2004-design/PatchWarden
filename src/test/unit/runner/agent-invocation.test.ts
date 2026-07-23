import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PatchWardenConfig } from "../../../config.js";
import { buildAgentInvocation, resolveAgentExecutable, resolveAgentLaunch } from "../../../runner/agentInvocation.js";
import { resolvePackageManagerInvocation } from "../../../runner/processSecurity.js";

describe("agent executable resolution", () => {
  it("resolves an existing OpenCode npm shim to the native Windows executable", () => {
    const shim = "C:\\Users\\student\\AppData\\Roaming\\npm\\opencode.cmd";
    const native = "C:\\Users\\student\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe";
    assert.equal(resolveAgentExecutable("opencode", shim, "win32", "", (path) => path === native), native);
  });

  it("does not route unsupported wrappers through a shell", () => {
    const shim = "C:\\tools\\custom-opencode.cmd";
    assert.throws(
      () => resolveAgentExecutable("custom", shim, "win32", "", () => true),
      /shell shim is not allowed/,
    );
  });

  it("resolves a known npm Agent shim through a verified package manifest", () => {
    const shimRoot = "C:\\Users\\student\\AppData\\Roaming\\npm";
    const shim = `${shimRoot}\\codex.cmd`;
    const manifest = `${shimRoot}\\node_modules\\@openai\\codex\\package.json`;
    const cli = `${shimRoot}\\node_modules\\@openai\\codex\\bin\\codex.js`;
    const node = "C:\\Program Files\\nodejs\\node.exe";
    const files = new Set([shim, manifest, cli, node].map((path) => path.toLowerCase()));
    const launch = resolveAgentLaunch(
      "codex",
      shim,
      "win32",
      `C:\\Program Files\\nodejs;${shimRoot}`,
      (path) => files.has(path.toLowerCase()),
      "C:\\work\\repo",
      "codex",
      () => JSON.stringify({ name: "@openai/codex", bin: { codex: "bin/codex.js" } }),
    );
    assert.equal(launch.command.toLowerCase(), node.toLowerCase());
    assert.deepEqual(launch.argsPrefix.map((path) => path.toLowerCase()), [cli.toLowerCase()]);
  });

  it("skips a same-named executable under the repository when resolving PATH", () => {
    const repo = "C:\\work\\untrusted-repo";
    const trusted = "C:\\Program Files\\PatchWarden Tools";
    const expected = `${trusted}\\codex.exe`;
    const resolved = resolveAgentExecutable(
      "codex",
      "codex",
      "win32",
      `${repo};${trusted}`,
      (path) => path.toLowerCase() === `${repo}\\codex.exe`.toLowerCase()
        || path.toLowerCase() === expected.toLowerCase(),
      repo,
    );
    assert.equal(resolved.toLowerCase(), expected.toLowerCase());
  });

  it("carries only configured environment variable names into the invocation", () => {
    const config = {
      agents: {
        codex: {
          command: process.execPath,
          args: ["-e", "{prompt}"],
          envAllowlist: ["OPENAI_API_KEY", "HTTPS_PROXY"],
        },
      },
      http: { ownerTokenEnv: "PATCHWARDEN_CUSTOM_OWNER_TOKEN" },
    } as unknown as PatchWardenConfig;
    const invocation = buildAgentInvocation("codex", process.cwd(), "prompt", config);
    assert.deepEqual(invocation.environmentVariableNames, ["OPENAI_API_KEY", "HTTPS_PROXY"]);
    assert.deepEqual(invocation.blockedEnvironmentVariableNames, [
      "CONTROL_PLANE_API_KEY",
      "PATCHWARDEN_CUSTOM_OWNER_TOKEN",
    ]);
  });

  it("resolves npm to its trusted JavaScript CLI without cmd.exe", () => {
    const repo = "C:\\work\\untrusted-repo";
    const trustedRoot = "C:\\Program Files\\nodejs";
    const trustedShim = `${trustedRoot}\\npm.cmd`;
    const trustedCli = `${trustedRoot}\\node_modules\\npm\\bin\\npm-cli.js`;
    const invocation = resolvePackageManagerInvocation("npm", repo, {
      platform: "win32",
      pathValue: `${repo};${trustedRoot}`,
      fileExists: (path) => [
        `${repo}\\npm.cmd`,
        trustedShim,
        trustedCli,
      ].some((candidate) => candidate.toLowerCase() === path.toLowerCase()),
    });
    assert.equal(invocation.command, process.execPath);
    assert.deepEqual(invocation.argsPrefix.map((path) => path.toLowerCase()), [trustedCli.toLowerCase()]);
  });
});
