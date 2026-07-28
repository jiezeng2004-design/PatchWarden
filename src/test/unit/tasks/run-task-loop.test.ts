import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join, normalize } from "node:path";
import { tmpdir } from "node:os";
import { reloadConfig } from "../../../config.js";
import {
  runTaskLoopCoordinatedWithDeps,
  runTaskLoopWithDeps,
} from "../../../tools/tasks/runTaskLoop.js";
import { MODEL_SELECTION_REPO_PATH } from "../../../tools/tasks/createTask.js";
import { createLineageId, getTaskLineage, writeTaskLineage } from "../../../tools/tasks/taskLineage.js";
import { PatchWardenError } from "../../../errors.js";

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
  const inputs: any[] = [];
  let lastRequestedModel: string | null = null;
  const deps = {
    createTask: ((input: any) => {
      inputs.push(input);
      calls.push(input.execution_mode === "assess_only" ? "assess" : "execute");
      if (input.execution_mode === "assess_only") {
        lastRequestedModel = input.requested_model ?? null;
        const decision = decisions.shift() || "allow";
        return {
          assessment_id: `assessment-${calls.length}`,
          decision,
          reason_codes: decision === "allow" ? ["repo_scoped"] : ["release_template_needs_confirm"],
        };
      }
      return {
        task_id: tasks.shift() || `task-${calls.length}`,
        status: "pending",
        model_selection: {
          requested_agent: "fake",
          selected_agent: "fake",
          requested_model: lastRequestedModel,
          configured_default_model: null,
          effective_model: lastRequestedModel,
          model_source: lastRequestedModel ? "task_override" : "agent_default_unobserved",
          provider: null,
          model_argument_present: lastRequestedModel !== null,
          agent_config_revision: "a".repeat(64),
          fallback_used: false,
          agent_fallback_used: false,
          model_fallback_used: false,
        },
      };
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
    createDirectSession: ((input: any) => {
      calls.push(`direct-session:${String(input.expected_changes)}`);
      return {
        session_id: "direct-test",
        repo_path: input.repo_path,
        resolved_repo_path: tempDir,
        workspace_clean: true,
        allowed_commands: ["npm test", "npm run build"],
        expected_changes: input.expected_changes !== false,
        expires_at: "2026-07-04T13:00:00.000Z",
        next_action: "run_verification",
      };
    }) as any,
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
    createWorktree: ((goalId: string, subgoalId: string, workspaceRoot: string) => {
      calls.push(`worktree:${workspaceRoot}`);
      return {
        worktreeId: "wt-test",
        worktreePath: tempDir,
        branch: "pw-test",
      };
    }) as any,
    now: () => new Date("2026-07-04T12:00:00.000Z"),
    sleep: async () => {},
  };
  return { deps, calls, inputs };
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

    assert.equal(result.stop_reason, "audit_accepted");
    assert.equal(result.final_status, "accepted");
    assert.equal(result.tasks.main, "task-main");
    const payload = JSON.stringify(result);
    assert.ok(!payload.includes("stdout"));
    assert.ok(!payload.includes("stderr"));
    assert.ok(!payload.includes("diff.patch"));
  });

  it("keeps verified terminal work ready for audit when no audit has run", async () => {
    const { deps } = depsFor({
      audits: { "task-main": { verdict: "not_run" } },
    });
    const result = await runTaskLoopWithDeps({
      repo_path: ".",
      goal: "Inspect files without changing them",
      agent: "fake",
      template: "inspect_only",
      verify_commands: ["npm test"],
      max_iterations: 1,
      auto_fix_tests: false,
    }, deps);

    assert.equal(result.final_status, "ready_for_audit");
    assert.notEqual(result.final_status, "needs_fix");
    assert.equal(result.stop_reason, "verification_passed");
    assert.notEqual(result.stop_reason, "verification_failed");
    assert.equal(result.next_action, "audit_task");
    assert.equal(result.verification.latest_status, "passed");
    assert.equal(result.verification.passed, true);
  });

  it("emits lineage and main task evidence before waiting for completion", async () => {
    const { deps } = depsFor({});
    let resolveQueued!: (value: any) => void;
    const queuedResult = new Promise<any>((resolvePromise) => { resolveQueued = resolvePromise; });
    const completion = runTaskLoopWithDeps({
      repo_path: ".",
      goal: "Return the queued task quickly",
      agent: "fake",
      verify_commands: ["npm test"],
      request_id: "request-fast-001",
    }, deps, {
      lineageId: "lineage_fast_001",
      requestId: "request-fast-001",
      onMainTaskCreated: resolveQueued,
    });

    const queued = await queuedResult;
    assert.equal(queued.request_id, "request-fast-001");
    assert.equal(queued.lineage_id, "lineage_fast_001");
    assert.equal(queued.tasks.main, "task-main");
    assert.equal(queued.final_status, "running");
    assert.equal(queued.stop_reason, "task_queued");
    assert.equal(queued.continuation_required, true);

    const completed = await completion;
    assert.equal(completed.final_status, "accepted");
    assert.equal(completed.continuation_required, false);
  });

  it("reuses one task for concurrent async and synchronous retries", async () => {
    const { deps, calls } = depsFor({});
    let releaseWait!: () => void;
    const waitGate = new Promise<void>((resolvePromise) => { releaseWait = resolvePromise; });
    deps.waitForTask = (async (taskId: string) => {
      await waitGate;
      return {
        task_id: taskId,
        status: "done_by_agent",
        phase: "done_by_agent",
        terminal: true,
        continuation_required: false,
        next_action: "safe_audit",
      };
    }) as any;
    const input = {
      repo_path: ".",
      goal: "Reuse one guarded task",
      agent: "fake",
      verify_commands: ["npm test"],
      request_id: "request-idempotent-001",
    };

    const first = await runTaskLoopCoordinatedWithDeps(input, deps);
    const retry = await runTaskLoopCoordinatedWithDeps(input, deps);
    const completion = runTaskLoopCoordinatedWithDeps({
      ...input,
      wait_for_completion: true,
    }, deps);

    assert.equal(first.tasks.main, "task-main");
    assert.equal(first.reused_request, false);
    assert.equal(retry.tasks.main, "task-main");
    assert.equal(retry.reused_request, true);
    assert.equal(calls.filter((entry) => entry === "execute").length, 1);

    releaseWait();
    const completed = await completion;
    assert.equal(completed.final_status, "accepted");
    assert.equal(completed.reused_request, true);
    assert.equal(calls.filter((entry) => entry === "execute").length, 1);

    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    const persistedRetry = await runTaskLoopCoordinatedWithDeps(input, deps);
    assert.equal(persistedRetry.final_status, "accepted");
    assert.equal(persistedRetry.reused_request, true);
    assert.equal(calls.filter((entry) => entry === "execute").length, 1);

    await assert.rejects(
      runTaskLoopCoordinatedWithDeps({ ...input, goal: "Different arguments" }, deps),
      /different run_task_loop arguments/,
    );
  });

  it("fails a persisted running lineage closed after the original Core exits", async () => {
    const { deps, calls } = depsFor({});
    const input = {
      repo_path: ".",
      goal: "Recover an interrupted guarded task loop",
      agent: "fake",
      verify_commands: ["npm test"],
      request_id: "request-recovery-001",
      wait_for_completion: true,
    };

    const completed = await runTaskLoopCoordinatedWithDeps(input, deps);
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    const lineagePath = join(tempDir, ".patchwarden", "lineages", completed.lineage_id, "lineage.json");
    const interrupted = JSON.parse(readFileSync(lineagePath, "utf-8"));
    interrupted.final_status = "running";
    interrupted.stop_reason = "task_queued";
    interrupted.next_action = "wait_for_task_then_get_task_lineage";
    writeFileSync(lineagePath, JSON.stringify(interrupted), "utf-8");

    const recovered = await runTaskLoopCoordinatedWithDeps(input, deps);
    assert.equal(recovered.reused_request, true);
    assert.equal(recovered.final_status, "failed");
    assert.equal(recovered.stop_reason, "recovery_required");
    assert.equal(recovered.continuation_required, false);
    assert.equal(recovered.next_action, "rerun_run_task_loop_with_a_new_request_id");
    assert.equal(recovered.tasks.main, "task-main");
    assert.equal(calls.filter((entry) => entry === "execute").length, 1);
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

    assert.equal(result.stop_reason, "audit_accepted");
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

    assert.equal(result.stop_reason, "audit_accepted");
    assert.equal(result.agent_routing?.requested_agent, "auto");
    assert.equal(result.agent_routing?.selected_agent, "fake");
    assert.equal(result.agent_routing?.reason, "test route");
  });

  it("inherits requested_model through assessment and every repair round", async () => {
    const { deps, inputs } = depsFor({
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
      goal: "Repair with one fixed model",
      agent: "fake",
      requested_model: "agnes/agnes-2.0-flash",
      verify_commands: ["npm test"],
      max_iterations: 2,
    }, deps);

    assert.deepEqual(inputs.filter((input) => input.execution_mode === "assess_only").map((input) => input.requested_model), [
      "agnes/agnes-2.0-flash",
      "agnes/agnes-2.0-flash",
    ]);
    assert.equal(result.model_selection?.requested_model, "agnes/agnes-2.0-flash");
    assert.equal(result.model_selection?.model_fallback_used, false);
  });

  it("reports requested_model as the only changed idempotency field", async () => {
    const { deps, calls } = depsFor({});
    const input = {
      repo_path: ".",
      goal: "Stable model request",
      agent: "fake",
      requested_model: "agnes/model-a",
      verify_commands: ["npm test"],
      request_id: "request-model-conflict-001",
      wait_for_completion: true,
    };
    await runTaskLoopCoordinatedWithDeps(input, deps);
    await assert.rejects(
      runTaskLoopCoordinatedWithDeps({ ...input, requested_model: "agnes/model-b" }, deps),
      (error: unknown) => {
        assert.ok(error instanceof PatchWardenError);
        assert.equal(error.reason, "request_id_parameter_mismatch");
        assert.deepEqual(error.details.changed_fields, ["requested_model"]);
        return true;
      },
    );
  });

  it("rejects requested_model with automatic Agent routing", async () => {
    const { deps } = depsFor({});
    for (const agent of [undefined, "auto"] as const) {
      await assert.rejects(
        runTaskLoopWithDeps({
          repo_path: ".",
          goal: "Do not auto-route a model override",
          ...(agent === undefined ? {} : { agent }),
          requested_model: "agnes/model-a",
          verify_commands: ["npm test"],
        }, deps),
        (error: unknown) => error instanceof PatchWardenError
          && error.reason === "requested_model_requires_explicit_agent",
      );
    }
  });

  it("uses worktree isolation for task execution and records worktree evidence", async () => {
    const { deps, calls, inputs } = depsFor({});
    const result = await runTaskLoopWithDeps({
      repo_path: "child-repo",
      goal: "Run in a worktree",
      agent: "fake",
      verify_commands: ["npm test"],
      isolation_mode: "worktree",
      worktree_cleanup: "keep",
    }, deps);

    assert.equal(result.stop_reason, "audit_accepted");
    assert.equal(result.isolation_mode, "worktree");
    assert.equal(result.worktree.worktree_id, "wt-test");
    assert.equal(result.worktree.branch, "pw-test");
    assert.equal(result.worktree.status, "active");
    const sourceRepo = normalize(join(tempDir, "child-repo"));
    assert.ok(calls.includes(`worktree:${sourceRepo}`));
    assert.equal(inputs[0][MODEL_SELECTION_REPO_PATH], sourceRepo);
    assert.equal(inputs[1][MODEL_SELECTION_REPO_PATH], sourceRepo);
  });

  it("records Direct verification evidence when direct_verify succeeds", async () => {
    const { deps, calls } = depsFor({});
    const result = await runTaskLoopWithDeps({
      repo_path: ".",
      goal: "Run with Direct verification",
      agent: "fake",
      verify_commands: ["npm test"],
      direct_verify: true,
    }, deps);

    assert.equal(result.stop_reason, "audit_accepted");
    assert.equal(result.direct_verify, true);
    assert.equal(result.tasks.direct_sessions.length, 1);
    assert.equal(result.tasks.direct_sessions[0].session_id, "direct-test");
    assert.equal(result.tasks.direct_sessions[0].status, "passed");
    assert.equal(result.tasks.direct_sessions[0].audit_decision, "pass");
    assert.ok(calls.includes("direct-session:false"));
    const payload = JSON.stringify(result);
    assert.ok(!payload.includes("stdout_tail"));
    assert.ok(!payload.includes("stderr_tail"));
    assert.ok(!payload.includes("diff.patch"));
  });

  it("runs Direct verification before returning a verified task as ready for audit", async () => {
    const { deps, calls } = depsFor({
      audits: { "task-main": { verdict: "not_run" } },
    });
    const result = await runTaskLoopWithDeps({
      repo_path: ".",
      goal: "Verify read-only work with Direct",
      agent: "fake",
      verify_commands: ["npm test"],
      direct_verify: true,
      auto_fix_tests: false,
    }, deps);

    assert.equal(result.final_status, "ready_for_audit");
    assert.equal(result.stop_reason, "verification_passed");
    assert.equal(result.tasks.direct_sessions[0].status, "passed");
    assert.ok(calls.includes("direct-session:false"));
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

    assert.equal(result.stop_reason, "audit_accepted");
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
