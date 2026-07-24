import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { reloadConfig } from "../../../config.js";
import {
  createAssessment,
  validateAssessmentFreshness,
} from "../../../assessments/assessmentStore.js";
import type { RepoSnapshot } from "../../../runner/changeCapture.js";
import { createTask } from "../../../tools/tasks/createTask.js";

describe("assessment cross-process freshness", () => {
  let root: string;
  let configPath: string;
  let previousConfig: string | undefined;

  const snapshot: RepoSnapshot = {
    captured_at: new Date().toISOString(),
    is_git: false,
    head: null,
    status: "",
    workspace_dirty: false,
    files: {},
    dirty_paths: [],
    warnings: [],
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pw-assessment-cross-process-"));
    configPath = join(root, "patchwarden.config.json");
    previousConfig = process.env.PATCHWARDEN_CONFIG;
    writeConfig(["exec", "{prompt}"]);
    process.env.PATCHWARDEN_CONFIG = configPath;
    reloadConfig(configPath);
  });

  afterEach(() => {
    if (previousConfig === undefined) delete process.env.PATCHWARDEN_CONFIG;
    else process.env.PATCHWARDEN_CONFIG = previousConfig;
    reloadConfig(previousConfig);
    rmSync(root, { recursive: true, force: true });
  });

  it("validates the same canonical tool manifest in a fresh process", () => {
    const assessment = createAssessment({
      decision: "allow",
      risk_level: "low",
      risk_hints: [],
      hard_rule_hits: [],
      reason_codes: ["fixture"],
      repo_path: ".",
      resolved_repo_path: root,
      plan_id: null,
      plan_content: null,
      agent: "codex",
      snapshot,
    });

    const moduleUrl = new URL("../../../assessments/assessmentStore.js", import.meta.url).href;
    const configUrl = new URL("../../../config.js", import.meta.url).href;
    const source = [
      `const config = await import(${JSON.stringify(configUrl)});`,
      `const assessments = await import(${JSON.stringify(moduleUrl)});`,
      `process.env.PATCHWARDEN_CONFIG = process.argv[1];`,
      `config.reloadConfig(process.argv[1]);`,
      `const snapshot = ${JSON.stringify(snapshot)};`,
      `process.stdout.write(JSON.stringify(assessments.validateAssessmentFreshness(process.argv[2], snapshot)));`,
    ].join("\n");
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", source, configPath, assessment.assessment_id], {
      encoding: "utf-8",
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).valid, true);

    writeConfig(["exec", "--different", "{prompt}"]);
    reloadConfig(configPath);
    const changed = validateAssessmentFreshness(assessment.assessment_id, snapshot);
    assert.equal(changed.valid, false);
    assert.equal(changed.failure_reason, "assessment_stale_config");
    assert.match(changed.expected_hash || "", /^[0-9a-f]{64}$/);
    assert.match(changed.actual_hash || "", /^[0-9a-f]{64}$/);
    assert.notEqual(changed.expected_hash, changed.actual_hash);
    assert.deepEqual(changed.config_change_categories, ["agent_launch"]);
  });

  it("distinguishes invalid, expired, incompatible, and corrupted assessments", () => {
    const invalid = validateAssessmentFreshness("deadbeef", snapshot);
    assert.equal(invalid.failure_reason, "assessment_id_invalid");

    const assessment = createAssessment({
      decision: "allow",
      risk_level: "low",
      risk_hints: [],
      hard_rule_hits: [],
      reason_codes: ["fixture"],
      repo_path: ".",
      resolved_repo_path: root,
      plan_id: null,
      plan_content: null,
      agent: "codex",
      snapshot,
    });
    assert.equal(validateAssessmentFreshness(assessment.assessment_id, snapshot).valid, true);

    const assessmentFile = join(root, ".patchwarden", "assessments", assessment.assessment_id, "assessment.json");
    const record = JSON.parse(readFileSync(assessmentFile, "utf-8"));
    record.expires_at = new Date(Date.now() - 1).toISOString();
    writeFileSync(assessmentFile, JSON.stringify(record), "utf-8");
    assert.equal(validateAssessmentFreshness(assessment.assessment_id, snapshot).failure_reason, "assessment_expired");

    record.expires_at = new Date(Date.now() + 60_000).toISOString();
    record.assessment_security_snapshot_version = "future-version";
    writeFileSync(assessmentFile, JSON.stringify(record), "utf-8");
    assert.equal(
      validateAssessmentFreshness(assessment.assessment_id, snapshot).failure_reason,
      "assessment_snapshot_version_incompatible",
    );

    writeFileSync(assessmentFile, "{not-json", "utf-8");
    assert.equal(validateAssessmentFreshness(assessment.assessment_id, snapshot).failure_reason, "assessment_corrupted");
  });

  it("invalidates only material command and project-policy changes", () => {
    const baseline = createAssessmentFixture();
    writeConfig(["exec", "{prompt}"], ["npm test", "npm run build"]);
    reloadConfig(configPath);
    const commandChanged = validateAssessmentFreshness(baseline.assessment_id, snapshot);
    assert.equal(commandChanged.failure_reason, "assessment_stale_config");
    assert.ok(commandChanged.config_change_categories?.includes("allowed_commands"));

    writeConfig(["exec", "{prompt}"]);
    reloadConfig(configPath);
    const policyAssessment = createAssessmentFixture();
    const policyDir = join(root, ".patchwarden");
    mkdirSync(policyDir, { recursive: true });
    writeFileSync(join(policyDir, "project-policy.json"), JSON.stringify({
      protected_paths: [".env", "secrets/**"],
    }), "utf-8");
    const policyChanged = validateAssessmentFreshness(policyAssessment.assessment_id, snapshot);
    assert.equal(policyChanged.failure_reason, "assessment_stale_config");
    assert.ok(policyChanged.config_change_categories?.includes("project_policy"));
    assert.ok(policyChanged.config_change_categories?.includes("protected_paths"));
  });

  it("executes an assess-only ticket created by a separate MCP process", async () => {
    writeConfig(["-e", "process.exit(0)"]);
    reloadConfig(configPath);
    const configUrl = new URL("../../../config.js", import.meta.url).href;
    const createTaskUrl = new URL("../../../tools/tasks/createTask.js", import.meta.url).href;
    const assessSource = [
      `const config = await import(${JSON.stringify(configUrl)});`,
      `const tasks = await import(${JSON.stringify(createTaskUrl)});`,
      `config.reloadConfig(process.argv[1]);`,
      `const result = await tasks.createTask({`,
      `  execution_mode: "assess_only",`,
      `  inline_plan: "Inspect the workspace and produce task evidence without changing files.",`,
      `  plan_title: "Cross-process assessment fixture",`,
      `  repo_path: ".",`,
      `  agent: "codex",`,
      `  verify_commands: [],`,
      `  scope: ["src/**"],`,
      `  forbidden: ["release/**"],`,
      `  done_evidence: ["result.md"]`,
      `});`,
      `process.stdout.write(JSON.stringify(result));`,
    ].join("\n");
    const assessed = spawnSync(process.execPath, ["--input-type=module", "-e", assessSource, configPath], {
      encoding: "utf-8",
      windowsHide: true,
      env: { ...process.env, PATCHWARDEN_CONFIG: configPath },
    });
    assert.equal(assessed.status, 0, assessed.stderr);
    const ticket = JSON.parse(assessed.stdout);
    assert.equal(ticket.decision, "allow");

    const executeSource = [
      `const config = await import(${JSON.stringify(configUrl)});`,
      `const tasks = await import(${JSON.stringify(createTaskUrl)});`,
      `config.reloadConfig(process.argv[1]);`,
      `const result = await tasks.createTask({ execution_mode: "execute", assessment_id: process.argv[2] });`,
      `process.stdout.write(JSON.stringify(result));`,
    ].join("\n");
    const executed = spawnSync(process.execPath, ["--input-type=module", "-e", executeSource, configPath, ticket.assessment_id], {
      encoding: "utf-8",
      windowsHide: true,
      env: { ...process.env, PATCHWARDEN_CONFIG: configPath },
    });
    assert.equal(executed.status, 0, executed.stderr);
    const task = JSON.parse(executed.stdout);
    assert.equal(task.status, "pending");
    const persisted = JSON.parse(readFileSync(join(task.path, "status.json"), "utf-8"));
    assert.equal(persisted.assessment_id, ticket.assessment_id);
    assert.deepEqual(persisted.scope, ["src/**"]);
    assert.deepEqual(persisted.forbidden, ["release/**"]);
    assert.deepEqual(persisted.done_evidence, ["result.md"]);

    const { runTask } = await import("../../../runner/runTask.js");
    const completed = await runTask(task.task_id);
    assert.equal(completed.status, "done_by_agent");
    const finalStatus = JSON.parse(readFileSync(join(task.path, "status.json"), "utf-8"));
    assert.equal(finalStatus.phase, "done_by_agent");
    assert.doesNotMatch(String(finalStatus.error || ""), /assessment_stale_config/);
    await assert.rejects(
      createTask({ execution_mode: "execute", assessment_id: ticket.assessment_id }),
      (error: unknown) => (error as { reason?: string }).reason === "assessment_used",
    );
  });

  function createAssessmentFixture() {
    return createAssessment({
      decision: "allow",
      risk_level: "low",
      risk_hints: [],
      hard_rule_hits: [],
      reason_codes: ["fixture"],
      repo_path: ".",
      resolved_repo_path: root,
      plan_id: null,
      plan_content: null,
      agent: "codex",
      snapshot,
    });
  }

  function writeConfig(args: string[], allowedTestCommands = ["npm test"]): void {
    writeFileSync(configPath, JSON.stringify({
      workspaceRoot: root,
      toolProfile: "chatgpt_core",
      agents: { codex: { command: process.execPath, args } },
      allowedTestCommands,
    }), "utf-8");
  }
});
