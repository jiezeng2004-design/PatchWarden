import { setTimeout as sleep } from "node:timers/promises";
import { getConfig } from "../../config.js";
import { createWorktree } from "../../goal/worktreeManager.js";
import { guardWorkspacePath } from "../../security/pathGuard.js";
import { createDirectSession } from "../direct/createDirectSession.js";
import { createTask, type CreateTaskInput } from "./createTask.js";
import { recommendAgentForTask } from "../workspace/recommendAgentForTask.js";
import { runDirectVerificationBundle } from "../direct/runDirectVerificationBundle.js";
import { waitForTask } from "./waitForTask.js";
import { safeAudit, safeAuditDirectSession, safeFinalizeDirectSession, safeResult, safeTestSummary } from "../diagnostics/safeViews.js";
import type { TaskTemplateName } from "../taskTemplates.js";
import { isTerminalTaskStatus } from "./taskStates.js";
import {
  createLineageId,
  writeTaskLineage,
  type SafeTaskLineage,
  type TaskLineageDirectSession,
  type TaskLineageRecord,
  type TaskLineageRound,
  type TaskLineageWorktree,
  type TaskLoopStopReason,
} from "./taskLineage.js";

export interface RunTaskLoopInput {
  repo_path: string;
  goal: string;
  verify_commands: string[];
  agent?: string;
  template?: TaskTemplateName;
  max_iterations?: number;
  task_timeout_seconds?: number;
  auto_fix_tests?: boolean;
  auto_cleanup_artifacts?: boolean;
  stop_on_high_risk?: boolean;
  direct_verify?: boolean;
  direct_verify_commands?: string[];
  direct_verify_timeout_seconds?: number;
  scope_files?: string[];
  isolation_mode?: "current_repo" | "worktree";
  worktree_base_branch?: string;
  worktree_cleanup?: "keep" | "archive" | "delete_ignored_only";
}

export interface RunTaskLoopOutput extends SafeTaskLineage {
  created_task_count: number;
  auto_fix_tests: boolean;
  auto_cleanup_artifacts: boolean;
  direct_verify: boolean;
  isolation_mode: "current_repo" | "worktree";
  worktree: TaskLineageWorktree;
  stopped_before_execution: boolean;
}

interface RunTaskLoopDeps {
  createTask: typeof createTask;
  waitForTask: typeof waitForTask;
  safeResult: typeof safeResult;
  safeAudit: typeof safeAudit;
  safeTestSummary: typeof safeTestSummary;
  createDirectSession: typeof createDirectSession;
  runDirectVerificationBundle: typeof runDirectVerificationBundle;
  safeFinalizeDirectSession: typeof safeFinalizeDirectSession;
  safeAuditDirectSession: typeof safeAuditDirectSession;
  writeTaskLineage: typeof writeTaskLineage;
  createLineageId: typeof createLineageId;
  recommendAgentForTask: typeof recommendAgentForTask;
  createWorktree: typeof createWorktree;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
}

const DEFAULT_DEPS: RunTaskLoopDeps = {
  createTask,
  waitForTask,
  safeResult,
  safeAudit,
  safeTestSummary,
  createDirectSession,
  runDirectVerificationBundle,
  safeFinalizeDirectSession,
  safeAuditDirectSession,
  writeTaskLineage,
  createLineageId,
  recommendAgentForTask,
  createWorktree,
  now: () => new Date(),
  sleep,
};

export async function runTaskLoop(input: RunTaskLoopInput): Promise<RunTaskLoopOutput> {
  return runTaskLoopWithDeps(input, DEFAULT_DEPS);
}

export async function runTaskLoopWithDeps(
  input: RunTaskLoopInput,
  deps: RunTaskLoopDeps
): Promise<RunTaskLoopOutput> {
  const normalized = normalizeInput(input);
  const resolvedRepoPath = guardWorkspacePath(normalized.repo_path, getConfig().workspaceRoot);
  const routing = resolveAgentRouting(normalized, deps);
  const selectedAgent = routing.selected_agent;
  const now = deps.now().toISOString();
  const lineage: TaskLineageRecord = {
    lineage_id: deps.createLineageId(deps.now()),
    goal: normalized.goal,
    repo_path: resolvedRepoPath,
    created_at: now,
    updated_at: now,
    final_status: "blocked",
    stop_reason: "policy_blocked",
    next_action: "inspect_lineage",
    main_task: null,
    fix_tasks: [],
    cleanup_tasks: [],
    direct_sessions: [],
    rounds: [],
    warnings: [],
    errors: [],
    worktree: {
      isolation_mode: normalized.isolation_mode,
      cleanup: normalized.worktree_cleanup,
      status: normalized.isolation_mode === "worktree" ? "active" : "not_used",
      requested_base_branch: normalized.worktree_base_branch,
      next_action: normalized.isolation_mode === "worktree"
        ? "Review and explicitly merge or discard the worktree after acceptance."
        : "none",
    },
    agent_routing: routing,
  };

  const finalize = (
    finalStatus: TaskLineageRecord["final_status"],
    stopReason: TaskLoopStopReason,
    nextAction: string,
    error?: string
  ): RunTaskLoopOutput => {
    lineage.final_status = finalStatus;
    lineage.stop_reason = stopReason;
    lineage.next_action = nextAction;
    lineage.updated_at = deps.now().toISOString();
    if (error) lineage.errors.push(error);
    const safe = deps.writeTaskLineage(lineage);
    return {
      ...safe,
      created_task_count: [lineage.main_task, ...lineage.fix_tasks, ...lineage.cleanup_tasks].filter(Boolean).length,
      auto_fix_tests: normalized.auto_fix_tests,
      auto_cleanup_artifacts: normalized.auto_cleanup_artifacts,
      direct_verify: normalized.direct_verify,
      isolation_mode: normalized.isolation_mode,
      worktree: safe.worktree,
      stopped_before_execution: lineage.main_task === null,
    };
  };

  let taskRepoPath = resolvedRepoPath;
  if (normalized.isolation_mode === "worktree") {
    try {
      const worktree = deps.createWorktree(lineage.lineage_id, "task_loop", resolvedRepoPath);
      taskRepoPath = worktree.worktreePath;
      lineage.repo_path = taskRepoPath;
      lineage.worktree = {
        isolation_mode: "worktree",
        worktree_id: worktree.worktreeId,
        worktree_path: worktree.worktreePath,
        branch: worktree.branch,
        requested_base_branch: normalized.worktree_base_branch,
        cleanup: normalized.worktree_cleanup,
        status: "active",
        next_action: "Explicitly inspect and merge_worktree or discard_worktree after reviewing this lineage.",
      };
    } catch (err) {
      lineage.worktree = {
        isolation_mode: "worktree",
        cleanup: normalized.worktree_cleanup,
        requested_base_branch: normalized.worktree_base_branch,
        status: "failed",
        next_action: "Fix worktree creation prerequisites or rerun with isolation_mode=current_repo.",
      };
      return finalize("blocked", "policy_blocked", "Fix worktree creation prerequisites or rerun without worktree isolation.", err instanceof Error ? err.message : String(err));
    }
  }

  let role: "main" | "fix_tests" = "main";
  let latestFailurePrompt = normalized.goal;

  for (let iteration = 1; iteration <= normalized.max_iterations; iteration++) {
    const assessmentInput: CreateTaskInput = {
      template: role === "main" ? normalized.template : "fix_tests",
      goal: role === "main" ? normalized.goal : latestFailurePrompt,
      repo_path: taskRepoPath,
      agent: selectedAgent,
      verify_commands: normalized.verify_commands,
      timeout_seconds: normalized.task_timeout_seconds,
      execution_mode: "assess_only",
    };
    const assessment = asRecord(await deps.createTask(assessmentInput));
    if (assessment.decision === "blocked") {
      return finalize(
        "blocked",
        "high_risk_blocked",
        "Risk assessment blocked task execution.",
        asArray(assessment.reason_codes).map(String).join(", "),
      );
    }
    if (assessment.decision === "needs_confirm") {
      return finalize("blocked", "user_confirmation_required", "Ask the user to confirm the assessment before executing the loop.");
    }

    const created = asRecord(await deps.createTask({
      execution_mode: "execute",
      assessment_id: String(assessment.assessment_id || ""),
    }));
    const taskId = String(created.task_id || "");
    if (!taskId) {
      return finalize("failed", "policy_blocked", "create_task returned no task_id.", "create_task returned no task_id");
    }
    if (role === "main") lineage.main_task = taskId;
    else lineage.fix_tasks.push(taskId);

    const wait = await waitUntilTerminal(taskId, normalized.task_timeout_seconds, deps);
    if (wait.stop_reason) {
      return finalize("blocked", wait.stop_reason, wait.next_action, wait.error);
    }

    const result = asRecord(deps.safeResult(taskId, { max_items: 8 }));
    const tests = asRecord(deps.safeTestSummary(taskId));
    const audit = asRecord(deps.safeAudit(taskId, { max_items: 8 }));
    const round = buildRound(iteration, taskId, role, result, tests, audit);
    lineage.rounds.push(round);
    lineage.updated_at = deps.now().toISOString();

    if (isSuccessfulRound(round)) {
      if (normalized.direct_verify) {
        const direct = await runDirectVerification(lineage.lineage_id, normalized, taskRepoPath, deps);
        lineage.direct_sessions.push(direct.evidence);
        if (direct.warning) lineage.warnings.push(direct.warning);
        if (direct.stop_reason) {
          return finalize(direct.final_status, direct.stop_reason, direct.next_action, direct.error);
        }
      }
      return finalize("accepted", "success", "accept");
    }

    if (isHardStop(round, result, audit, normalized.stop_on_high_risk)) {
      return finalize("blocked", hardStopReason(round, result), round.next_action || "review_task");
    }

    latestFailurePrompt = buildFixGoal(normalized.goal, result, round);
    if (!normalized.auto_fix_tests || round.status !== "failed_verification") {
      return finalize("needs_fix", "verification_failed", round.next_action || "create_followup_task");
    }

    role = "fix_tests";
  }

  return finalize("needs_fix", "max_iterations_reached", "review_lineage_and_create_manual_followup");
}

async function waitUntilTerminal(
  taskId: string,
  timeoutSeconds: number,
  deps: RunTaskLoopDeps
): Promise<{ stop_reason?: TaskLoopStopReason; next_action: string; error?: string }> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const waited = await deps.waitForTask(taskId, 30);
    if (waited.terminal || isTerminalTaskStatus(String(waited.status))) {
      return { next_action: waited.next_action || "safe_audit" };
    }
    if (waited.next_tool_call?.name === "health_check" || waited.continuation_required === false) {
      return {
        stop_reason: "watcher_blocked",
        next_action: waited.next_action || "health_check",
        error: waited.progress_summary?.hint || "Watcher is blocked or unavailable.",
      };
    }
    await deps.sleep(250);
  }
  return {
    stop_reason: "agent_timeout",
    next_action: "inspect_task_status",
    error: `Task loop timed out waiting for ${taskId}.`,
  };
}

function buildRound(
  iteration: number,
  taskId: string,
  role: TaskLineageRound["role"],
  resultValue: unknown,
  testsValue: unknown,
  auditValue: unknown,
): TaskLineageRound {
  const result = asRecord(resultValue);
  const tests = asRecord(testsValue);
  const audit = asRecord(auditValue);
  const resultVerification = asRecord(result.verification);
  const auditAcceptance = asRecord(audit.acceptance);
  const failChecks = asArray(audit.fail_checks).map((entry) => {
    const check = asRecord(entry);
    return String(check.name || entry);
  });
  const warnChecks = asArray(audit.warn_checks).map((entry) => {
    const check = asRecord(entry);
    return String(check.name || entry);
  });
  const recommendedActions = asArray(audit.recommended_next_actions);
  return {
    iteration,
    task_id: taskId,
    role,
    status: String(result.status || "unknown"),
    terminal: Boolean(result.terminal),
    verification_status: String(tests.status || resultVerification.status || "not_available"),
    audit_verdict: String(audit.verdict || auditAcceptance.verdict || "unknown"),
    fail_checks: failChecks,
    warn_checks: warnChecks,
    next_action: String(result.next_action || recommendedActions[0] || "review_task"),
  };
}

function isSuccessfulRound(round: TaskLineageRound): boolean {
  return (
    round.terminal &&
    ["done_by_agent", "done", "accepted"].includes(round.status) &&
    round.verification_status === "passed" &&
    round.fail_checks.length === 0 &&
    round.warn_checks.length === 0 &&
    round.audit_verdict === "pass"
  );
}

function isHardStop(round: TaskLineageRound, resultValue: unknown, auditValue: unknown, stopOnHighRisk: boolean): boolean {
  if (["failed_scope_violation", "failed_policy_violation", "canceled", "timeout"].includes(round.status)) return true;
  if (!stopOnHighRisk) return false;
  const checkNames = [...round.fail_checks, ...round.warn_checks].join(" ").toLowerCase();
  const result = asRecord(resultValue);
  const audit = asRecord(auditValue);
  const reason = String(result.failure_reason || asRecord(audit.acceptance).reason || "").toLowerCase();
  return /scope|secret|sensitive|publish|release|policy|push/.test(`${checkNames} ${reason}`);
}

function hardStopReason(round: TaskLineageRound, resultValue: unknown): TaskLoopStopReason {
  const result = asRecord(resultValue);
  if (round.status === "failed_scope_violation" || round.status === "failed_policy_violation") return "policy_blocked";
  if (round.status === "timeout") return "agent_timeout";
  if (String(result.failure_reason || "").toLowerCase().includes("timeout")) return "agent_timeout";
  return "high_risk_blocked";
}

function buildFixGoal(originalGoal: string, resultValue: unknown, round: TaskLineageRound): string {
  const result = asRecord(resultValue);
  const failedCommand = result.failed_command ? ` Failed command: ${result.failed_command}.` : "";
  return [
    `Fix the failing verification for this PatchWarden loop without changing unrelated behavior.`,
    `Original goal: ${originalGoal}`,
    `Previous task: ${round.task_id}. Status: ${round.status}. Verification: ${round.verification_status}.${failedCommand}`,
    "Do not commit, push, publish, weaken tests, or touch files outside the resolved repository path.",
  ].join("\n");
}

function resolveAgentRouting(
  normalized: ReturnType<typeof normalizeInput>,
  deps: RunTaskLoopDeps
) {
  if (normalized.agent && normalized.agent !== "auto") {
    return {
      requested_agent: normalized.agent,
      selected_agent: normalized.agent,
      reason: "explicit agent supplied",
      fallback: false,
    };
  }
  const recommendation = deps.recommendAgentForTask({
    repo_path: normalized.repo_path,
    goal: normalized.goal,
    scope_files: normalized.scope_files,
    template: normalized.template,
  });
  return {
    requested_agent: normalized.agent || null,
    selected_agent: recommendation.recommended_agent,
    reason: recommendation.reason,
    fallback: recommendation.fallback,
  };
}

async function runDirectVerification(
  lineageId: string,
  normalized: ReturnType<typeof normalizeInput>,
  repoPath: string,
  deps: RunTaskLoopDeps
): Promise<{
  evidence: TaskLineageDirectSession;
  stop_reason?: TaskLoopStopReason;
  final_status: TaskLineageRecord["final_status"];
  next_action: string;
  error?: string;
  warning?: string;
}> {
  const config = getConfig();
  if (config.enableDirectProfile !== true) {
    return {
      evidence: {
        session_id: "not_created",
        status: "skipped",
        audit_decision: "not_run",
        next_action: "Enable Direct profile locally before requesting direct_verify.",
      },
      stop_reason: "direct_profile_disabled",
      final_status: "blocked",
      next_action: "Enable enableDirectProfile locally or rerun run_task_loop with direct_verify=false.",
      error: "Direct profile is disabled by local config.",
    };
  }

  let sessionId = "";
  try {
    const session = await deps.createDirectSession({
      repo_path: repoPath,
      title: `Direct verification for ${lineageId}`,
    });
    sessionId = session.session_id;
    const bundle = await deps.runDirectVerificationBundle({
      session_id: sessionId,
      commands: normalized.direct_verify_commands,
      timeout_seconds: normalized.direct_verify_timeout_seconds,
    });
    const finalized = asRecord(await deps.safeFinalizeDirectSession(sessionId, { max_items: 8 }));
    const audit = asRecord(deps.safeAuditDirectSession(sessionId, { max_items: 8 }));
    const auditEvidence = asRecord(audit.evidence);
    const auditDecision = audit.decision === "pass" || audit.decision === "warn" || audit.decision === "fail"
      ? audit.decision
      : "not_run";
    const evidence: TaskLineageDirectSession = {
      session_id: sessionId,
      status: bundle.status,
      command_count: bundle.command_count,
      passed_commands: bundle.passed_commands,
      failed_commands: bundle.failed_commands,
      timed_out_commands: bundle.timed_out_commands,
      audit_decision: auditDecision,
      changed_files_total: Number(finalized.changed_files_total || auditEvidence.changed_files_total || 0),
      next_action: String(audit.next_action || bundle.next_action || "review_direct_session"),
    };
    if (bundle.status !== "passed") {
      return {
        evidence,
        stop_reason: "direct_verification_failed",
        final_status: "needs_fix",
        next_action: "Review Direct verification summary and create a normal follow-up task.",
        error: "Direct verification failed.",
      };
    }
    if (auditDecision === "fail") {
      return {
        evidence,
        stop_reason: "direct_audit_failed",
        final_status: "blocked",
        next_action: "Review Direct audit findings before accepting the loop.",
        error: "Direct audit failed.",
      };
    }
    return {
      evidence,
      final_status: "accepted",
      next_action: "accept",
      warning: auditDecision === "warn" ? "Direct audit completed with warnings." : undefined,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      evidence: {
        session_id: sessionId || "not_created",
        status: "failed",
        audit_decision: "not_run",
        next_action: "Review Direct verification configuration and command allow-list.",
      },
      stop_reason: "direct_verification_failed",
      final_status: "needs_fix",
      next_action: "Review Direct verification configuration and command allow-list.",
      error: message,
    };
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalizeInput(input: RunTaskLoopInput): Required<Omit<RunTaskLoopInput, "agent" | "scope_files" | "worktree_base_branch">> & { agent?: string; scope_files?: string[]; worktree_base_branch?: string } {
  const config = getConfig();
  const repoPath = String(input.repo_path || "").trim();
  const goal = String(input.goal || "").trim();
  if (!repoPath) throw new Error("repo_path is required.");
  if (!goal) throw new Error("goal is required.");
  if (!Array.isArray(input.verify_commands) || input.verify_commands.length === 0) {
    throw new Error("verify_commands must contain at least one command.");
  }
  const maxIterations = input.max_iterations ?? 3;
  if (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > 5) {
    throw new Error("max_iterations must be an integer from 1 to 5.");
  }
  const timeoutSeconds = input.task_timeout_seconds ?? config.defaultTaskTimeoutSeconds;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > config.maxTaskTimeoutSeconds) {
    throw new Error(`task_timeout_seconds must be an integer from 1 to ${config.maxTaskTimeoutSeconds}.`);
  }
  const template = input.template || "feature_small";
  if (template !== "inspect_only" && template !== "feature_small" && template !== "release_check") {
    throw new Error('template must be "inspect_only", "feature_small", or "release_check".');
  }
  const directVerifyCommands = Array.isArray(input.direct_verify_commands) && input.direct_verify_commands.length > 0
    ? input.direct_verify_commands
    : input.verify_commands;
  if (input.direct_verify === true && (!Array.isArray(directVerifyCommands) || directVerifyCommands.length === 0)) {
    throw new Error("direct_verify_commands must contain at least one command when provided.");
  }
  const directVerifyTimeout = input.direct_verify_timeout_seconds ?? 120;
  const maxDirectTimeout = Math.min(config.maxTaskTimeoutSeconds, config.directSessionTtlSeconds);
  if (!Number.isInteger(directVerifyTimeout) || directVerifyTimeout < 1 || directVerifyTimeout > maxDirectTimeout) {
    throw new Error(`direct_verify_timeout_seconds must be an integer from 1 to ${maxDirectTimeout}.`);
  }
  return {
    repo_path: repoPath,
    goal,
    verify_commands: input.verify_commands.map((command) => String(command).trim()),
    agent: input.agent ? String(input.agent) : undefined,
    template,
    max_iterations: maxIterations,
    task_timeout_seconds: timeoutSeconds,
    auto_fix_tests: input.auto_fix_tests !== false,
    auto_cleanup_artifacts: input.auto_cleanup_artifacts !== false,
    stop_on_high_risk: input.stop_on_high_risk !== false,
    direct_verify: input.direct_verify === true,
    direct_verify_commands: directVerifyCommands.map((command) => String(command).trim()),
    direct_verify_timeout_seconds: directVerifyTimeout,
    scope_files: Array.isArray(input.scope_files)
      ? input.scope_files.map((entry) => String(entry).trim()).filter(Boolean).slice(0, 50)
      : undefined,
    isolation_mode: input.isolation_mode === "worktree" ? "worktree" : "current_repo",
    worktree_base_branch: input.worktree_base_branch ? String(input.worktree_base_branch).trim().slice(0, 160) : undefined,
    worktree_cleanup:
      input.worktree_cleanup === "archive" || input.worktree_cleanup === "delete_ignored_only"
        ? input.worktree_cleanup
        : "keep",
  };
}
