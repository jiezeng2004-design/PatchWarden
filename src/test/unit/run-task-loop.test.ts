import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { reloadConfig } from "../../config.js";
import { runTaskLoopWithDeps } from "../../tools/runTaskLoop.js";
import { createLineageId, getTaskLineage, writeTaskLineage } from "../../tools/taskLineage.js";

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
        fake: { command: "fake-agent", args: [] },
      },
      allowedTestCommands: ["npm test", "npm run build"],
      directAllowedCommands: ["npm test", "npm run build"],
      defaultTaskTimeoutSeconds: 30,
      maxTaskTimeoutSeconds: 120,
      enableDirectProfile: true,
    }),
    "utf-8"
  );
  prevConfigEnv = process.env.PATCHWARDEN_CONFIG;
  process.env.PATCHWARDEN_CONFIG = configPath;
  reloadConfig();
}

function depsFor(options: {
  decisions?: string[];
  tasks?: string[];
  statuses?: Record<string, string>;
  verifications?: Record<string, string>;
  audits?: Record<string, { verdict: string; fail?: string[]; warn?: string[] }>;
  directEnabled?: boolean;
  directBundleStatus?: "passed" | "failed";
  directAuditDecision?: "pass" | "warn" | "fail";
}) {
  const decisions = [...(options.decisions || ["allow"])];
  const tasks = [...(options.tasks || ["task-main"])];
  const calls: string[] = [];
  const deps = {
    createTask: ((input: any) => {
      calls.push(input.execution_mode === "assess_only" ? "assess" : "execute");
      if (input.execution_mode === "assess_only") {
        const decision = decisions.shift() || "allow";
        return {
          assessment_id: `assessment-${calls.length}`,
          decision,
          reason_codes: decision === "allow" ? ["repo_scoped"] : ["release_template_needs_confirm"],
        };
      }
      return { task_id: tasks.shift() || `task-${calls.length}`, status: "pending" };
    }) as any,
    waitForTask: (async (taskId: string) => ({
      task_id: taskId,
      status: options.statuses?.[taskId] || "done_by_agent",
      phase: options.statuses?.[taskId] || "done_by_agent",
      terminal: true,
      continuation_required: false,
      next_action: "safe_audit",
    })) as any,
    safeResult: ((taskId: string) => ({
      task_id: taskId,
      status: options.statuses?.[taskId] || "done_by_agent",
      terminal: true,
      verification: { status: options.verifications?.[taskId] || "passed" },
      next_action: "audit_or_accept",
    })) as any,
    safeTestSummary: ((taskId: string) => ({
      task_id: taskId,
      status: options.verifications?.[taskId] || "passed",
      commands: [{ command: "npm test", status: options.verifications?.[taskId] || "passed", exit_code: 0 }],
    })) as any,
    safeAudit: ((taskId: string) => {
      const audit = options.audits?.[taskId] || { verdict: "pass" };
      return {
        task_id: taskId,
        verdict: audit.verdict,
        fail_checks: (audit.fail || []).map((name) => ({ name, result: "fail" })),
        warn_checks: (audit.warn || []).map((name) => ({ name, result: "warn" })),
        recommended_next_actions: ["accept"],
      };
    }) as any,
    createDirectSession: ((input: any) => ({
      session_id: "direct-test",
      repo_path: input.repo_path,
      resolved_repo_path: tempDir,
      workspace_clean: true,
      allowed_commands: ["npm test", "npm run build"],
      expires_at: "2026-07-04T13:00:00.000Z",
      next_action: "run_verification",
    })) as any,
    runDirectVerificationBundle: (async () => ({
      session_id: "direct-test",
      status: options.directBundleStatus || "passed",
      command_count: 1,
      passed_commands: (options.directBundleStatus || "passed") === "passed" ? 1 : 0,
      failed_commands: (options.directBundleStatus || "passed") === "passed" ? 0 : 1,
      timed_out_commands: 0,
      commands: [{
        command: "npm test",
        passed: (options.directBundleStatus || "passed") === "passed",
        exit_code: (options.directBundleStatus || "passed") === "passed" ? 0 : 1,
        timed_out: false,
        redacted: false,
        redaction_categories: [],
        started_at: "2026-07-04T12:00:00.000Z",
        finished_at: "2026-07-04T12:00:01.000Z",
      }],
      large_logs_omitted: true,
      next_action: "safe_finalize_direct_session",
    })) as any,
    safeFinalizeDirectSession: (() => ({
      session_id: "direct-test",
      finalized: true,
      changed_files_total: 0,
      next_action: "safe_audit_direct_session",
    })) as any,
    safeAuditDirectSession: (() => ({
      session_id: "direct-test",
      decision: options.directAuditDecision || "pass",
      reason_codes: [],
      blocking_findings: [],
      warnings: [],
      evidence: { changed_files_total: 0, verification_runs: [] },
      next_action: "accept",
    })) as any,
    writeTaskLineage,
    createLineageId: (() => "lineage_20260704_test") as typeof createLineageId,
    recommendAgentForTask: ((input: any) => ({
      repo_path: input.repo_path,
      resolved_repo_path: tempDir,
      recommended_agent: "fake",
      fallback_agent: null,
      fallback: false,
      reason: "test route",
      risk_notes: [],
      suggested_verify_commands: ["npm test"],
      bounded: true,
    })) as any,
    createWorktree: (() => ({
      worktreeId: "wt-test",
      worktreePath: tempDir,
      branch: "pw-test",
    })) as any,
    now: () => new Date("2026-07-04T12:00:00.000Z"),
    sleep: async () => {},
  };
  return { deps, calls };
}

describe("runTaskLoop", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pw-loop-"));
    writeConfig();
  });

  afterEach(() => {
    if (prevConfigEnv === undefined) delete process.env.PATCHWARDEN_CONFIG;
    else process.env.PATCHWARDEN_CONFIG = prevConfigEnv;
    reloadConfig();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns success with a bounded lineage summary", async () => {
    const { deps } = depsFor({});
    const result = await runTaskLoopWithDeps({
      repo_path: ".",
      goal: "Make a safe change",
      agent: "fake",
      verify_commands: ["npm test"],
    }, deps);

    assert.equal(result.stop_reason, "success");
    assert.equal(result.final_status, "accepted");
    assert.equal(result.tasks.main, "task-main");
    const payload = JSON.stringify(result);
    assert.ok(!payload.includes("stdout"));
    assert.ok(!payload.includes("stderr"));
    assert.ok(!payload.includes("diff.patch"));
  });

  it("keeps v1.3 behavior when direct_verify is false", async () => {
    const { deps } = depsFor({});
    const result = await runTaskLoopWithDeps({
      repo_path: ".",
      goal: "Run without Direct",
      agent: "fake",
      verify_commands: ["npm test"],
      direct_verify: false,
    }, deps);

    assert.equal(result.stop_reason, "success");
    assert.equal(result.direct_verify, false);
    assert.deepEqual(result.tasks.direct_sessions, []);
    assert.equal(result.isolation_mode, "current_repo");
    assert.equal(result.worktree.status, "not_used");
  });

  it("records bounded agent routing when agent is auto", async () => {
    const { deps } = depsFor({});
    const result = await runTaskLoopWithDeps({
      repo_path: ".",
      goal: "Pick a safe agent",
      agent: "auto",
      verify_commands: ["npm test"],
      scope_files: ["src/index.ts"],
    }, deps);

    assert.equal(result.stop_reason, "success");
    assert.equal(result.agent_routing?.requested_agent, "auto");
    assert.equal(result.agent_routing?.selected_agent, "fake");
    assert.equal(result.agent_routing?.reason, "test route");
  });

  it("uses worktree isolation for task execution and records worktree evidence", async () => {
    const { deps } = depsFor({});
    const result = await runTaskLoopWithDeps({
      repo_path: ".",
      goal: "Run in a worktree",
      agent: "fake",
      verify_commands: ["npm test"],
      isolation_mode: "worktree",
      worktree_cleanup: "keep",
    }, deps);

    assert.equal(result.stop_reason, "success");
    assert.equal(result.isolation_mode, "worktree");
    assert.equal(result.worktree.worktree_id, "wt-test");
    assert.equal(result.worktree.branch, "pw-test");
    assert.equal(result.worktree.status, "active");
  });

  it("records Direct verification evidence when direct_verify succeeds", async () => {
    const { deps } = depsFor({});
    const result = await runTaskLoopWithDeps({
      repo_path: ".",
      goal: "Run with Direct verification",
      agent: "fake",
      verify_commands: ["npm test"],
      direct_verify: true,
    }, deps);

    assert.equal(result.stop_reason, "success");
    assert.equal(result.direct_verify, true);
    assert.equal(result.tasks.direct_sessions.length, 1);
    assert.equal(result.tasks.direct_sessions[0].session_id, "direct-test");
    assert.equal(result.tasks.direct_sessions[0].status, "passed");
    assert.equal(result.tasks.direct_sessions[0].audit_decision, "pass");
    const payload = JSON.stringify(result);
    assert.ok(!payload.includes("stdout_tail"));
    assert.ok(!payload.includes("stderr_tail"));
    assert.ok(!payload.includes("diff.patch"));
  });

  it("stops clearly when direct_verify is requested but Direct profile is disabled", async () => {
    const configPath = join(tempDir, "patchwarden.config.json");
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    raw.enableDirectProfile = false;
    writeFileSync(configPath, JSON.stringify(raw), "utf-8");
    reloadConfig();
    const { deps } = depsFor({});

    const result = await runTaskLoopWithDeps({
      repo_path: ".",
      goal: "Run with unavailable Direct",
      agent: "fake",
      verify_commands: ["npm test"],
      direct_verify: true,
    }, deps);

    assert.equal(result.stop_reason, "direct_profile_disabled");
    assert.equal(result.final_status, "blocked");
    assert.equal(result.tasks.main, "task-main");
    assert.equal(result.tasks.direct_sessions[0].session_id, "not_created");
  });

  it("returns direct_verification_failed without leaking Direct logs", async () => {
    const { deps } = depsFor({ directBundleStatus: "failed" });
    const result = await runTaskLoopWithDeps({
      repo_path: ".",
      goal: "Run with failing Direct verification",
      agent: "fake",
      verify_commands: ["npm test"],
      direct_verify: true,
    }, deps);

    assert.equal(result.stop_reason, "direct_verification_failed");
    assert.equal(result.final_status, "needs_fix");
    assert.equal(result.tasks.direct_sessions[0].failed_commands, 1);
    const payload = JSON.stringify(result);
    assert.ok(!payload.includes("stdout_tail"));
    assert.ok(!payload.includes("stderr_tail"));
  });

  it("returns direct_audit_failed when Direct audit fails", async () => {
    const { deps } = depsFor({ directAuditDecision: "fail" });
    const result = await runTaskLoopWithDeps({
      repo_path: ".",
      goal: "Run with failing Direct audit",
      agent: "fake",
      verify_commands: ["npm test"],
      direct_verify: true,
    }, deps);

    assert.equal(result.stop_reason, "direct_audit_failed");
    assert.equal(result.final_status, "blocked");
    assert.equal(result.tasks.direct_sessions[0].audit_decision, "fail");
  });

  it("creates a fix_tests follow-up after failed verification", async () => {
    const { deps } = depsFor({
      tasks: ["task-main", "task-fix"],
      statuses: { "task-main": "failed_verification", "task-fix": "done_by_agent" },
      verifications: { "task-main": "failed", "task-fix": "passed" },
      audits: {
        "task-main": { verdict: "warn", warn: ["test_exit_code"] },
        "task-fix": { verdict: "pass" },
      },
    });

    const result = await runTaskLoopWithDeps({
      repo_path: ".",
      goal: "Repair tests",
      agent: "fake",
      verify_commands: ["npm test"],
      max_iterations: 2,
    }, deps);

    assert.equal(result.stop_reason, "success");
    assert.equal(result.tasks.main, "task-main");
    assert.deepEqual(result.tasks.fix, ["task-fix"]);
    assert.equal(result.rounds.length, 2);
  });

  it("stops before execution when assessment needs confirmation", async () => {
    const { deps, calls } = depsFor({ decisions: ["needs_confirm"] });
    const result = await runTaskLoopWithDeps({
      repo_path: ".",
      goal: "Release-like work",
      agent: "fake",
      verify_commands: ["npm test"],
    }, deps);

    assert.equal(result.stop_reason, "user_confirmation_required");
    assert.equal(result.stopped_before_execution, true);
    assert.deepEqual(calls, ["assess"]);
  });

  it("returns max_iterations_reached when verification keeps failing", async () => {
    const { deps } = depsFor({
      statuses: { "task-main": "failed_verification" },
      verifications: { "task-main": "failed" },
      audits: { "task-main": { verdict: "warn", warn: ["test_exit_code"] } },
    });
    const result = await runTaskLoopWithDeps({
      repo_path: ".",
      goal: "Fix tests",
      agent: "fake",
      verify_commands: ["npm test"],
      max_iterations: 1,
    }, deps);

    assert.equal(result.stop_reason, "max_iterations_reached");
    assert.equal(result.final_status, "needs_fix");
  });

  it("writes BOM-free lineage JSON readable through get_task_lineage", async () => {
    const { deps } = depsFor({});
    const result = await runTaskLoopWithDeps({
      repo_path: ".",
      goal: "Persist lineage",
      agent: "fake",
      verify_commands: ["npm test"],
    }, deps);

    const lineagePath = join(tempDir, ".patchwarden", "lineages", result.lineage_id, "lineage.json");
    const raw = readFileSync(lineagePath);
    assert.notEqual(raw[0], 0xef);
    const parsed = JSON.parse(raw.toString("utf-8"));
    assert.equal(parsed.lineage_id, result.lineage_id);

    const safe = getTaskLineage(result.lineage_id);
    assert.equal(safe.lineage_id, result.lineage_id);
    assert.equal(safe.rounds.length, 1);
  });

  it("reads legacy string direct_sessions as bounded evidence", () => {
    const safe = writeTaskLineage({
      lineage_id: "lineage_legacy_direct",
      goal: "Legacy lineage",
      repo_path: ".",
      created_at: "2026-07-04T12:00:00.000Z",
      updated_at: "2026-07-04T12:00:00.000Z",
      final_status: "accepted",
      stop_reason: "success",
      next_action: "accept",
      main_task: "task-main",
      fix_tasks: [],
      cleanup_tasks: [],
      direct_sessions: ["direct-old"],
      rounds: [],
      warnings: [],
      errors: [],
    });

    assert.equal(safe.tasks.direct_sessions[0].session_id, "direct-old");
    const readBack = getTaskLineage("lineage_legacy_direct");
    assert.equal(readBack.tasks.direct_sessions[0].session_id, "direct-old");
  });
});
