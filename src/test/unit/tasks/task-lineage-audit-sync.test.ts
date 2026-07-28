import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { reloadConfig } from "../../../config.js";
import { auditTask } from "../../../tools/diagnostics/auditTask.js";
import { getTaskLineage, syncTaskAuditToLineages, writeTaskLineage } from "../../../tools/tasks/taskLineage.js";

let tempDir: string;
let previousConfig: string | undefined;

function configure() {
  const configPath = join(tempDir, "patchwarden.config.json");
  writeFileSync(configPath, JSON.stringify({
    workspaceRoot: tempDir,
    tasksDir: ".patchwarden/tasks",
    plansDir: ".patchwarden/plans",
    assessmentsDir: ".patchwarden/assessments",
    agents: { fake: { command: "fake-agent", args: [] } },
    allowedTestCommands: ["npm test", "npm run build", "npm run lint"],
    defaultTaskTimeoutSeconds: 30,
    maxTaskTimeoutSeconds: 120,
  }), "utf-8");
  previousConfig = process.env.PATCHWARDEN_CONFIG;
  process.env.PATCHWARDEN_CONFIG = configPath;
  reloadConfig();
  writeFileSync(join(tempDir, "package.json"), JSON.stringify({
    name: "lineage-audit-fixture",
    version: "1.0.0",
    scripts: { test: "node test.js" },
  }), "utf-8");
}

function writeTaskFixture(taskId: string, lineageId: string, scopeViolation = false) {
  const taskDir = join(tempDir, ".patchwarden", "tasks", taskId);
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "status.json"), JSON.stringify({
    task_id: taskId,
    status: "done_by_agent",
    repo_path: ".",
    resolved_repo_path: tempDir,
    goal: "Read-only inspection",
    test_command: "npm test",
    verify_commands: ["npm test"],
    verification: ["npm test"],
    forbidden: [],
    done_evidence: ["result.md", "result.json", "verify.json", "test.log", "git.diff"],
    new_out_of_scope_changes: scopeViolation ? [{ path: "outside.ts", change: "modified" }] : [],
    artifact_status: "clean",
    acceptance_status: "pending",
    lineage_id: lineageId,
    updated_at: "2026-01-01T00:00:00.000Z",
  }), "utf-8");
  writeFileSync(join(taskDir, "result.md"), "Read-only inspection completed.\n", "utf-8");
  writeFileSync(join(taskDir, "result.json"), JSON.stringify({ summary: "Inspection complete" }), "utf-8");
  writeFileSync(join(taskDir, "verify.json"), JSON.stringify({
    status: "passed",
    configured_commands: ["npm test"],
  }), "utf-8");
  writeFileSync(join(taskDir, "test.log"), "npm test\nExit code: 0\n", "utf-8");
  writeFileSync(join(taskDir, "git.diff"), "", "utf-8");
  writeFileSync(join(taskDir, "changed-files.json"), JSON.stringify({
    changed_files: [],
    artifact_hygiene: {
      counts: {
        tracked_build_artifacts: 0,
        ignored_untracked_artifacts: 0,
        runtime_generated_files: 0,
        suspicious_changes: 0,
      },
    },
  }), "utf-8");
}

function writeReadyLineage(taskId: string, lineageId: string) {
  return writeTaskLineage({
    lineage_id: lineageId,
    goal: "Read-only inspection",
    repo_path: tempDir,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:01:00.000Z",
    final_status: "ready_for_audit",
    stop_reason: "verification_passed",
    next_action: "audit_task",
    main_task: taskId,
    fix_tasks: [],
    cleanup_tasks: [],
    direct_sessions: [],
    rounds: [{
      iteration: 1,
      task_id: taskId,
      role: "main",
      status: "done_by_agent",
      terminal: true,
      verification_status: "passed",
      audit_verdict: "not_run",
      fail_checks: [],
      warn_checks: [],
      next_action: "audit_task",
    }],
    warnings: [],
    errors: [],
  });
}

describe("task audit lineage synchronization", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pw-lineage-audit-"));
    configure();
  });

  afterEach(() => {
    if (previousConfig === undefined) delete process.env.PATCHWARDEN_CONFIG;
    else process.env.PATCHWARDEN_CONFIG = previousConfig;
    reloadConfig();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("synchronizes a passing audit into the linked lineage", () => {
    const taskId = "task_audit_pass";
    const lineageId = "lineage_audit_pass";
    writeTaskFixture(taskId, lineageId);
    const before = writeReadyLineage(taskId, lineageId);

    const audit = auditTask(taskId);
    const after = getTaskLineage(lineageId);

    assert.equal(audit.verdict, "pass");
    assert.equal(audit.acceptance.verdict, "ACCEPTED");
    assert.equal(after.rounds[0].audit_verdict, "pass");
    assert.deepEqual(after.rounds[0].fail_checks, []);
    assert.equal(after.final_status, "accepted");
    assert.equal(after.stop_reason, "audit_accepted");
    assert.equal(after.next_action, "none");
    assert.notEqual(after.updated_at, before.updated_at);
  });

  it("synchronizes a failing audit and its fail checks into the linked lineage", () => {
    const taskId = "task_audit_fail";
    const lineageId = "lineage_audit_fail";
    writeTaskFixture(taskId, lineageId, true);
    writeReadyLineage(taskId, lineageId);

    const audit = auditTask(taskId);
    const after = getTaskLineage(lineageId);

    assert.equal(audit.verdict, "fail");
    assert.equal(after.rounds[0].audit_verdict, "fail");
    assert.ok(after.rounds[0].fail_checks.includes("scope_changes"));
    assert.ok(["blocked", "needs_fix"].includes(after.final_status));
    assert.equal(after.stop_reason, "audit_failed");
    assert.notEqual(after.next_action, "audit_task");
  });

  it("does not accept a passing audit summary when acceptance blocks approval", () => {
    const taskId = "task_audit_blocked";
    const lineageId = "lineage_audit_blocked";
    writeTaskFixture(taskId, lineageId);
    writeReadyLineage(taskId, lineageId);

    syncTaskAuditToLineages(taskId, {
      task_id: taskId,
      verdict: "pass",
      acceptance: {
        verdict: "BLOCKED_BY_APPROVAL",
        status: "blocked",
        warn_checks: [{ name: "release_claims_unverified" }],
        next_suggested_task: "Verify the remote release claim before accepting this task.",
      },
    }, lineageId);
    const after = getTaskLineage(lineageId);

    assert.equal(after.rounds[0].audit_verdict, "fail");
    assert.ok(after.rounds[0].warn_checks.includes("release_claims_unverified"));
    assert.equal(after.final_status, "blocked");
    assert.equal(after.stop_reason, "audit_failed");
    assert.notEqual(after.next_action, "none");
  });
});
