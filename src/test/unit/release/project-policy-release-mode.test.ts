import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { reloadConfig } from "../../../config.js";
import { getProjectPolicySummary } from "../../../policy/projectPolicy.js";
import { releaseCleanup, releasePrepare, releaseVerify } from "../../../tools/release/releaseMode.js";

let tempDir: string;
let repoPath: string;
let prevConfigEnv: string | undefined;

function writeConfig(allowedTestCommands = ["npm test", "npm run build"]): void {
  const configPath = join(tempDir, "patchwarden.config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      workspaceRoot: tempDir,
      plansDir: ".patchwarden/plans",
      tasksDir: ".patchwarden/tasks",
      assessmentsDir: ".patchwarden/assessments",
      allowedTestCommands,
      agents: {},
      defaultTaskTimeoutSeconds: 30,
      maxTaskTimeoutSeconds: 120,
    }),
    "utf-8",
  );
  prevConfigEnv = process.env.PATCHWARDEN_CONFIG;
  process.env.PATCHWARDEN_CONFIG = configPath;
  reloadConfig(configPath);
}

function writePackage(version = "1.3.0"): void {
  writeFileSync(
    join(repoPath, "package.json"),
    JSON.stringify({
      name: "patchwarden-test",
      version,
      repository: { type: "git", url: "git+https://github.com/example/patchwarden-test.git" },
    }),
    "utf-8",
  );
}

describe("project policy and release mode", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pw-policy-"));
    repoPath = join(tempDir, "repo");
    mkdirSync(repoPath, { recursive: true });
    writePackage();
    writeConfig();
  });

  afterEach(() => {
    if (prevConfigEnv === undefined) {
      delete process.env.PATCHWARDEN_CONFIG;
    } else {
      process.env.PATCHWARDEN_CONFIG = prevConfigEnv;
    }
    reloadConfig();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns safe defaults when project-policy.json is missing", () => {
    const summary = getProjectPolicySummary(repoPath);
    assert.equal(summary.exists, false);
    assert.equal(summary.valid, true);
    assert.equal(summary.effective_policy.release_mode.version_source, "package.json");
    assert.equal(summary.release_readiness.version, "1.3.0");
  });

  it("parses BOM-prefixed policy JSON and reports allowlist issues without granting permission", () => {
    mkdirSync(join(repoPath, ".patchwarden"), { recursive: true });
    writeFileSync(
      join(repoPath, ".patchwarden", "project-policy.json"),
      "\uFEFF" + JSON.stringify({
        allowed_commands: ["npm run build", "npm publish"],
        release_mode: {
          version_source: "package.json",
          required_commands: ["npm run build", "not-allowed"],
        },
      }),
      "utf-8",
    );
    const summary = getProjectPolicySummary(repoPath);
    assert.equal(summary.exists, true);
    assert.equal(summary.valid, false);
    assert.ok(summary.issues.some((issue) => issue.code === "high_risk_command"));
    assert.ok(summary.issues.some((issue) => issue.code === "command_not_allowlisted"));
  });

  it("rejects unsafe path patterns and sensitive protected paths block cleanup", () => {
    mkdirSync(join(repoPath, ".patchwarden"), { recursive: true });
    writeFileSync(
      join(repoPath, ".patchwarden", "project-policy.json"),
      JSON.stringify({
        auto_cleanup: { enabled: true, patterns: ["../escape", ".git", "release_packages"], exclude: [] },
        protected_paths: [".env", "release_packages"],
      }),
      "utf-8",
    );
    mkdirSync(join(repoPath, "release_packages"), { recursive: true });
    const summary = getProjectPolicySummary(repoPath);
    assert.equal(summary.valid, false);
    assert.ok(summary.issues.some((issue) => issue.code === "unsafe_path_pattern"));
    const cleanup = releaseCleanup({ repo_path: repoPath, dry_run: true });
    const skipped = cleanup.summary.skipped as Array<{ path: string; reason: string }>;
    assert.ok(skipped.some((entry) => entry.path === "release_packages" && entry.reason === "protected_or_sensitive"));
  });

  it("release_cleanup defaults to dry run and writes BOM-free JSON summary", () => {
    mkdirSync(join(repoPath, "release_packages"), { recursive: true });
    const result = releaseCleanup({ repo_path: repoPath });
    assert.equal(result.mode, "release_cleanup");
    assert.equal((result.summary as any).dry_run, true);
    assert.equal(existsSync(join(repoPath, "release_packages")), true);
    const reportPath = join(repoPath, String((result.summary as any).report_path));
    const raw = readFileSync(reportPath, "utf-8");
    assert.notEqual(raw.charCodeAt(0), 0xfeff);
    assert.doesNotThrow(() => JSON.parse(raw));
  });

  it("release_cleanup honors auto_cleanup.enabled=false before deleting", () => {
    mkdirSync(join(repoPath, ".patchwarden"), { recursive: true });
    writeFileSync(
      join(repoPath, ".patchwarden", "project-policy.json"),
      JSON.stringify({
        auto_cleanup: { enabled: false, patterns: ["release_packages"], exclude: [] },
      }),
      "utf-8",
    );
    mkdirSync(join(repoPath, "release_packages"), { recursive: true });
    const result = releaseCleanup({ repo_path: repoPath, dry_run: false });
    assert.equal((result.summary as any).cleanup_disabled_by_policy, true);
    assert.deepEqual((result.summary as any).removed, []);
    assert.equal(existsSync(join(repoPath, "release_packages")), true);
  });

  it("release_verify fails when required metadata cannot be inferred", async () => {
    writeFileSync(join(repoPath, "package.json"), JSON.stringify({ name: "", version: "" }), "utf-8");
    const result = await releaseVerify({ repo_path: repoPath });
    assert.equal(result.ok, false);
    const stages = result.summary.stages as Record<string, string>;
    assert.equal(stages.published_verified, "failed");
    assert.equal(stages.github_release_verified, "failed");
    assert.equal(stages.ci_verified, "failed");
  });

  it("release_prepare blocks commands not accepted by the existing command guard", () => {
    const result = releasePrepare({ repo_path: repoPath, required_commands: ["npm run build", "npm run secret"] });
    const commands = result.summary.commands as Array<{ command: string; status: string }>;
    assert.equal(commands.find((entry) => entry.command === "npm run secret")?.status, "blocked");
  });
});
