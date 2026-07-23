import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

const testDist = process.env.PATCHWARDEN_DESKTOP_TEST_DIST;
const moduleUrl = testDist
  ? pathToFileURL(resolve(testDist, "runtime-root.js")).href
  : new URL("../dist/runtime-root.js", import.meta.url).href;
const { resolveCoreRoot, utilityProcessOptions } = await import(moduleUrl);

describe("desktop packaged runtime root", () => {
  it("uses resources/core for a packaged application", () => {
    const resourcesPath = "C:\\Program Files\\PatchWarden\\resources";
    assert.equal(resolveCoreRoot({ isPackaged: true, resourcesPath, desktopRoot: "ignored" }), join(resourcesPath, "core"));
  });

  it("stages the MCP manifest preflight and production dependency closure", () => {
    const stageSource = readFileSync(resolve(import.meta.dirname, "..", "scripts", "stage.mjs"), "utf8");
    const desktopPackage = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "package.json"), "utf8"));
    assert.match(stageSource, /mcp-manifest-check\.js/);
    assert.match(stageSource, /rmSync\(join\(coreStage, "dist", "test"\)/);
    assert.doesNotMatch(stageSource, /\["dist", "ui", "scripts\/checks"/);
    assert.match(stageSource, /rootPackageLock\.packages/);
    assert.match(stageSource, /node_modules\/@modelcontextprotocol\/sdk\/package\.json/);
    assert.ok(desktopPackage.build.extraResources.some((resource) => resource.to === "core/node_modules"));
    assert.deepEqual(desktopPackage.build.files, ["dist/**", "src/preload.cjs", "onboarding/**", "assets/**", "package.json"]);
  });

  it("pins utility processes to the core working directory", () => {
    const coreRoot = resolve("C:\\PatchWarden\\resources\\core");
    const options = utilityProcessOptions(coreRoot, {
      PATCHWARDEN_CONFIG: "config.json",
      CONTROL_PLANE_API_KEY: "control-secret",
      PATCHWARDEN_OWNER_TOKEN: "owner-secret",
    }, "Doctor", {
      platform: "win32",
      sourceEnvironment: { SystemRoot: "C:\\Windows", OPENAI_API_KEY: "agent-key" },
      allowedNames: ["OPENAI_API_KEY"],
    });
    assert.equal(options.cwd, coreRoot);
    assert.equal(options.env.PATCHWARDEN_CONFIG, "config.json");
    assert.equal(options.env.SystemRoot, "C:\\Windows");
    assert.equal(options.env.OPENAI_API_KEY, "agent-key");
    assert.equal(options.env.CONTROL_PLANE_API_KEY, undefined);
    assert.equal(options.env.PATCHWARDEN_OWNER_TOKEN, undefined);
    assert.equal(options.stdio, "pipe");
  });
});
