import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { reloadConfig } from "../../config.js";
import { recommendAgentForTask } from "../../tools/recommendAgentForTask.js";
import { exportTaskEvidencePack, listEvidencePacks, readEvidencePack } from "../../tools/evidencePack.js";
import { writeTaskLineage } from "../../tools/taskLineage.js";

let tempDir: string;
let prevConfigEnv: string | undefined;

function writeConfig() {
  const configPath = join(tempDir, "patchwarden.config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      workspaceRoot: tempDir,
      tasksDir: ".patchwarden/tasks",
      plansDir: ".patchwarden/plans",
      assessmentsDir: ".patchwarden/assessments",
      agents: {
        codex: { command: "codex", args: [] },
        opencode: { command: "opencode", args: [] },
      },
      allowedTestCommands: ["npm test", "npm run build"],
      defaultTaskTimeoutSeconds: 30,
      maxTaskTimeoutSeconds: 120,
    }),
    "utf-8"
  );
  prevConfigEnv = process.env.PATCHWARDEN_CONFIG;
  process.env.PATCHWARDEN_CONFIG = configPath;
  reloadConfig();
}

describe("v1.5 evidence packs and agent recommendations", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pw-evidence-"));
    writeConfig();
  });

  afterEach(() => {
    if (prevConfigEnv === undefined) delete process.env.PATCHWARDEN_CONFIG;
    else process.env.PATCHWARDEN_CONFIG = prevConfigEnv;
    reloadConfig();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("recommends an agent without creating task evidence", () => {
    const recommendation = recommendAgentForTask({
      repo_path: ".",
      goal: "Refactor two modules safely",
      scope_files: ["src/a.ts", "src/b.ts"],
    });

    assert.equal(recommendation.bounded, true);
    assert.ok(["codex", "opencode"].includes(recommendation.recommended_agent));
    assert.ok(Array.isArray(recommendation.suggested_verify_commands));
    const payload = JSON.stringify(recommendation);
    assert.ok(!payload.includes("stdout"));
    assert.ok(!payload.includes("stderr"));
    assert.ok(!payload.includes("diff"));
  });

  it("exports bounded BOM-free evidence pack from lineage", () => {
    writeTaskLineage({
      lineage_id: "lineage_v15_pack",
      goal: "Export evidence",
      repo_path: ".",
      created_at: "2026-07-05T12:00:00.000Z",
      updated_at: "2026-07-05T12:01:00.000Z",
      final_status: "accepted",
      stop_reason: "success",
      next_action: "accept",
      main_task: "task-main",
      fix_tasks: [],
      cleanup_tasks: [],
      direct_sessions: [{
        session_id: "direct-one",
        status: "passed",
        command_count: 1,
        passed_commands: 1,
        failed_commands: 0,
        timed_out_commands: 0,
        audit_decision: "pass",
        changed_files_total: 0,
        next_action: "accept",
      }],
      rounds: [{
        iteration: 1,
        task_id: "task-main",
        role: "main",
        status: "done_by_agent",
        terminal: true,
        verification_status: "passed",
        audit_verdict: "pass",
        fail_checks: [],
        warn_checks: [],
        next_action: "accept",
      }],
      warnings: [],
      errors: [],
      worktree: {
        isolation_mode: "worktree",
        worktree_id: "wt-one",
        worktree_path: join(tempDir, "_workspacetrees", "wt-one"),
        branch: "pw-test",
        cleanup: "keep",
        status: "active",
        next_action: "merge or discard explicitly",
      },
      agent_routing: {
        requested_agent: "auto",
        selected_agent: "codex",
        reason: "test route",
        fallback: false,
      },
    });

    const pack = exportTaskEvidencePack({ lineage_id: "lineage_v15_pack" });
    assert.equal(pack.bounded, true);
    assert.equal(pack.lineage.worktree.worktree_id, "wt-one");
    assert.equal(pack.lineage.agent_routing?.selected_agent, "codex");
    const raw = readFileSync(pack.files.json);
    assert.notEqual(raw[0], 0xef);
    JSON.parse(raw.toString("utf-8"));

    const payload = JSON.stringify(pack);
    assert.ok(!payload.includes("stdout_tail"));
    assert.ok(!payload.includes("stderr_tail"));
    assert.ok(!payload.includes("diff.patch"));
    assert.ok(!payload.includes("verification.log"));

    const readBack = readEvidencePack("lineage_v15_pack");
    assert.equal(readBack?.lineage_id, "lineage_v15_pack");
    const listed = listEvidencePacks();
    assert.equal(listed.total, 1);
    assert.equal(listed.evidence_packs[0].lineage_id, "lineage_v15_pack");

    // v2: all six structured artifact files should exist.
    for (const key of ["risk", "verify", "diffstat", "lineage", "attestation", "redactions"] as const) {
      assert.ok(existsSync(pack.files[key]), `${key} file should exist`);
    }

    // v2: attestation.json must carry the required provenance fields.
    const attestation = JSON.parse(readFileSync(pack.files.attestation, "utf-8"));
    assert.ok(attestation.patchwarden_version, "attestation should have patchwarden_version");
    assert.ok(attestation.package_version, "attestation should have package_version");
    assert.ok(attestation.commit, "attestation should have commit");
    assert.ok(attestation.node_version, "attestation should have node_version");
    assert.ok(attestation.os, "attestation should have os");
    assert.ok(attestation.schema_epoch, "attestation should have schema_epoch");

    // v2: redactions.json must have the audit structure even when empty.
    const redactions = JSON.parse(readFileSync(pack.files.redactions, "utf-8"));
    assert.ok(Array.isArray(redactions.redactions), "redactions should be an array");
    assert.equal(typeof redactions.total_redacted, "number", "total_redacted should be a number");
  });

  it("exports v2 structured artifacts and redacts secrets in diffstat", () => {
    const secretValue = "ghp_1234567890abcdefghijklmnop";
    // Create a task directory with file-stats.json containing a secret in a file path.
    const taskDir = join(tempDir, ".patchwarden", "tasks", "task-v2-secret");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "file-stats.json"), JSON.stringify({
      task_id: "task-v2-secret",
      additions: 5,
      deletions: 2,
      files: [{
        path: `secrets/${secretValue}.json`,
        status: "modified",
        additions: 5,
        deletions: 2,
      }],
    }), "utf-8");

    writeTaskLineage({
      lineage_id: "lineage_v2_secret",
      goal: "Export v2 evidence with diffstat",
      repo_path: ".",
      created_at: "2026-07-09T12:00:00.000Z",
      updated_at: "2026-07-09T12:01:00.000Z",
      final_status: "accepted",
      stop_reason: "success",
      next_action: "accept",
      main_task: "task-v2-secret",
      fix_tasks: [],
      cleanup_tasks: [],
      direct_sessions: [],
      rounds: [{
        iteration: 1,
        task_id: "task-v2-secret",
        role: "main",
        status: "done_by_agent",
        terminal: true,
        verification_status: "passed",
        audit_verdict: "pass",
        fail_checks: [],
        warn_checks: ["minor scope drift"],
        next_action: "accept",
      }],
      warnings: [],
      errors: [],
      worktree: {
        isolation_mode: "current_repo",
        cleanup: "keep",
        status: "not_used",
        next_action: "none",
      },
    });

    const pack = exportTaskEvidencePack({ lineage_id: "lineage_v2_secret" });

    // All six v2 files should exist.
    for (const key of ["risk", "verify", "diffstat", "lineage", "attestation", "redactions"] as const) {
      assert.ok(existsSync(pack.files[key]), `${key} file should exist`);
    }

    // The original secret must not appear in any v2 file.
    for (const key of ["risk", "verify", "diffstat", "lineage", "attestation", "redactions"] as const) {
      const content = readFileSync(pack.files[key], "utf-8");
      assert.ok(!content.includes(secretValue), `${key} should not contain the original secret value`);
    }

    // redactions.json should have detected the secret via diffstat aggregation.
    const redactions = JSON.parse(readFileSync(pack.files.redactions, "utf-8"));
    assert.ok(redactions.total_redacted > 0, "redactions.json should have detected the secret");
    assert.ok(
      !JSON.stringify(redactions).includes(secretValue),
      "redactions.json should not contain the original secret value"
    );

    // risk.json should carry the warn_check as a medium-severity risk.
    const risk = JSON.parse(readFileSync(pack.files.risk, "utf-8"));
    assert.ok(risk.count > 0, "risk.json should have at least one risk item");
    assert.equal(risk.by_severity.medium, 1, "should have one medium-severity risk");

    // verify.json should carry the round verification record.
    const verify = JSON.parse(readFileSync(pack.files.verify, "utf-8"));
    assert.ok(verify.count > 0, "verify.json should have at least one record");
    assert.equal(verify.records[0].verification_status, "passed");

    // lineage.json should carry the bounded summary.
    const lineageSummary = JSON.parse(readFileSync(pack.files.lineage, "utf-8"));
    assert.equal(lineageSummary.lineage_id, "lineage_v2_secret");
    assert.equal(lineageSummary.iterations_count, 1);
    assert.equal(lineageSummary.final_status, "accepted");
  });
});
