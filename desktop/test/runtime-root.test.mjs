import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { resolveCoreRoot, utilityProcessOptions } from "../src/runtime-root.mjs";

describe("desktop packaged runtime root", () => {
  it("uses resources/core for a packaged application", () => {
    const resourcesPath = "C:\\Program Files\\PatchWarden\\resources";
    assert.equal(resolveCoreRoot({ isPackaged: true, resourcesPath, desktopRoot: "ignored" }), join(resourcesPath, "core"));
  });

  it("stages the MCP manifest preflight and production dependency closure", () => {
    const stageSource = readFileSync(resolve(import.meta.dirname, "..", "scripts", "stage.mjs"), "utf8");
    const desktopPackage = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "package.json"), "utf8"));
    assert.match(stageSource, /"scripts\/checks"/);
    assert.match(stageSource, /rootPackageLock\.packages/);
    assert.match(stageSource, /node_modules\/@modelcontextprotocol\/sdk\/package\.json/);
    assert.ok(desktopPackage.build.extraResources.some((resource) => resource.to === "core/node_modules"));
  });

  it("pins utility processes to the core working directory", () => {
    const coreRoot = resolve("C:\\PatchWarden\\resources\\core");
    const options = utilityProcessOptions(coreRoot, { PATCHWARDEN_CONFIG: "config.json" }, "Doctor");
    assert.equal(options.cwd, coreRoot);
    assert.equal(options.env.PATCHWARDEN_CONFIG, "config.json");
    assert.equal(options.stdio, "pipe");
  });
});
