import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

const testDist = process.env.PATCHWARDEN_DESKTOP_TEST_DIST;
const moduleUrl = testDist
  ? pathToFileURL(resolve(testDist, "child-environment.js")).href
  : new URL("../dist/child-environment.js", import.meta.url).href;
const {
  buildDesktopChildEnvironment,
  resolveTrustedPowerShell,
  resolveTrustedWhere,
} = await import(moduleUrl);

describe("desktop child environment", () => {
  it("keeps only Windows runtime, proxy, and explicitly allowed variables", () => {
    const env = buildDesktopChildEnvironment({
      platform: "win32",
      sourceEnvironment: {
        SystemRoot: "C:\\Windows",
        Path: "C:\\Windows\\System32",
        TEMP: "C:\\Temp",
        https_proxy: "http://proxy.test:8080",
        OPENAI_API_KEY: "agent-key",
        NODE_OPTIONS: "--require attacker.js",
        UNRELATED_SECRET: "must-not-leak",
        CONTROL_PLANE_API_KEY: "control-secret",
        patchwarden_owner_token: "owner-secret",
      },
      allowedNames: ["OPENAI_API_KEY", "CONTROL_PLANE_API_KEY", "PATCHWARDEN_OWNER_TOKEN"],
      overrides: {
        PATCHWARDEN_CONFIG: "C:\\PatchWarden\\config.json",
        CONTROL_PLANE_API_KEY: "override-secret",
      },
    });

    assert.equal(env.SystemRoot, "C:\\Windows");
    assert.equal(env.Path, "C:\\Windows\\System32");
    assert.equal(env.https_proxy, "http://proxy.test:8080");
    assert.equal(env.OPENAI_API_KEY, "agent-key");
    assert.equal(env.PATCHWARDEN_CONFIG, "C:\\PatchWarden\\config.json");
    assert.equal(env.NODE_OPTIONS, undefined);
    assert.equal(env.UNRELATED_SECRET, undefined);
    assert.equal(env.CONTROL_PLANE_API_KEY, undefined);
    assert.equal(env.patchwarden_owner_token, undefined);
  });

  it("blocks a configured owner-token variable from an agent allowlist", () => {
    const env = buildDesktopChildEnvironment({
      platform: "linux",
      sourceEnvironment: {
        PATH: "/usr/bin",
        HTTPS_PROXY: "http://proxy.test:8080",
        ANTHROPIC_API_KEY: "agent-key",
        CUSTOM_OWNER_TOKEN: "owner-key",
      },
      allowedNames: ["ANTHROPIC_API_KEY", "CUSTOM_OWNER_TOKEN"],
      blockedNames: ["CUSTOM_OWNER_TOKEN"],
    });

    assert.equal(env.PATH, "/usr/bin");
    assert.equal(env.HTTPS_PROXY, "http://proxy.test:8080");
    assert.equal(env.ANTHROPIC_API_KEY, "agent-key");
    assert.equal(env.CUSTOM_OWNER_TOKEN, undefined);
  });

  it("rejects malformed allowlist names", () => {
    assert.throws(
      () => buildDesktopChildEnvironment({ allowedNames: ["SAFE_NAME", "BAD=NAME"] }),
      /Invalid child environment variable name/,
    );
  });

  it("binds PowerShell to the Windows system directory outside the project", () => {
    const expected = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    assert.equal(resolveTrustedPowerShell("D:\\PatchWarden", {
      platform: "win32",
      sourceEnvironment: { SystemRoot: "C:\\Windows" },
      fileExists: (path) => path === expected,
    }), expected);
    assert.equal(resolveTrustedWhere("D:\\PatchWarden", {
      platform: "win32",
      sourceEnvironment: { SystemRoot: "C:\\Windows" },
      fileExists: (path) => path === "C:\\Windows\\System32\\where.exe",
    }), "C:\\Windows\\System32\\where.exe");
    assert.throws(() => resolveTrustedPowerShell("D:\\PatchWarden", {
      platform: "win32",
      sourceEnvironment: { SystemRoot: "D:\\PatchWarden\\Windows" },
      fileExists: () => true,
    }), /must not resolve inside the project directory/);
  });

  it("routes every Desktop-owned process through the minimal environment", () => {
    const desktopRoot = resolve(import.meta.dirname, "..");
    const main = readFileSync(resolve(desktopRoot, "src", "main.ts"), "utf8");
    const adapters = readFileSync(resolve(desktopRoot, "src", "agent-adapters.ts"), "utf8");
    const runtimeRoot = readFileSync(resolve(desktopRoot, "src", "runtime-root.ts"), "utf8");
    const tunnelProvisioner = readFileSync(resolve(desktopRoot, "src", "tunnel-provisioner.ts"), "utf8");

    assert.doesNotMatch(main, /\.\.\.process\.env/);
    assert.match(main, /configuredAgentEnvironmentPolicy\(\)/);
    assert.match(main, /refreshAgentModels\(id, detection, \{\s*cwd: coreRoot,/);
    assert.match(runtimeRoot, /buildDesktopChildEnvironment\(\{ \.\.\.environmentOptions, overrides: env \}\)/);
    assert.match(adapters, /resolveTrustedWhere\(process\.cwd\(\),/);
    assert.match(adapters, /execFileAsync\(lookup, \[adapter\.id\], \{[^}]*\benv\b[^}]*\}\)/);
    assert.match(adapters, /execFileAsync\(lookup, \["node"\], \{[^}]*\benv\b[^}]*\}\)/);
    assert.match(adapters, /execFileAsync\(detection\.command,[\s\S]*?env: buildDesktopChildEnvironment/);
    assert.doesNotMatch(tunnelProvisioner, /childEnv[^\n]*\.\.\.env/);
    assert.equal((tunnelProvisioner.match(/resolveTrustedPowerShell\(/g) || []).length, 2);
  });
});
