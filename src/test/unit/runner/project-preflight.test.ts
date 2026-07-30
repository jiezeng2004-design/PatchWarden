import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { reloadConfig } from "../../../config.js";
import { runProjectPreflight } from "../../../runner/projectPreflight.js";

const roots: string[] = [];
afterEach(() => {
  reloadConfig();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("project preflight", () => {
  it("passes a prepared Node project without executing its scripts", async () => {
    const { root, config } = fixture({ scripts: { lint: "node -e \"process.exit(99)\"" }, dependencies: { x: "1.0.0" } }, true);
    const report = await runProjectPreflight({ repoPath: root, verifyCommands: ["npm run lint"], config });
    assert.equal(report.manifest, "passed");
    assert.equal(report.lockfile, "passed");
    assert.equal(report.dependencies, "passed");
    assert.equal(report.verification_scripts, "passed");
    assert.equal(report.blocking, false);
  });

  it("reports missing dependencies and exact package scripts before Agent execution", async () => {
    const { root, config } = fixture({ scripts: { test: "node test.js" }, dependencies: { x: "1.0.0" } }, false);
    const report = await runProjectPreflight({ repoPath: root, verifyCommands: ["npm run lint"], config });
    assert.equal(report.dependencies, "missing");
    assert.equal(report.verification_scripts, "missing");
    assert.deepEqual(report.missing_scripts, ["lint"]);
    assert.equal(report.blocking, true);
    assert.equal(report.recommended_action, "fix_verification_scripts");
  });
});

function fixture(pkg: Record<string, unknown>, installDependencies: boolean) {
  const root = mkdtempSync(join(tmpdir(), "patchwarden-preflight-"));
  roots.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify(pkg), "utf-8");
  writeFileSync(join(root, "package-lock.json"), "{}", "utf-8");
  writeFileSync(join(root, ".gitignore"), "node_modules/\n", "utf-8");
  if (installDependencies) {
    mkdirSync(join(root, "node_modules", "x"), { recursive: true });
    writeFileSync(join(root, "node_modules", "x", "package.json"), "{}", "utf-8");
  }
  const configPath = join(root, "patchwarden.config.json");
  writeFileSync(configPath, JSON.stringify({ workspaceRoot: root, allowedTestCommands: ["npm run lint"] }), "utf-8");
  return { root, config: reloadConfig(configPath) };
}
