/**
 * Dispatch handlers for core task-management tools.
 *
 * Each handler directly calls the existing tool function — no logic is
 * rewritten. Extracted from the original handleToolCallInternal switch.
 */

import { savePlan } from "../savePlan.js";
import { getPlan } from "../getPlan.js";
import { createTask } from "../createTask.js";
import { getTaskStatus } from "../getTaskStatus.js";
import { getResult, getResultJson, getDiff, getTestLog, getTaskLogTail } from "../taskOutputs.js";
import { listWorkspace } from "../listWorkspace.js";
import { readWorkspaceFile } from "../readWorkspaceFile.js";
import { listTasks } from "../listTasks.js";
import { cancelTask } from "../cancelTask.js";
import { killTask } from "../killTask.js";
import { retryTask } from "../retryTask.js";
import { getTaskStdoutTail } from "../getTaskStdoutTail.js";
import { getTaskProgress } from "../getTaskProgress.js";
import { listAgents } from "../listAgents.js";
import { healthCheck } from "../healthCheck.js";
import { getTaskSummary } from "../getTaskSummary.js";
import { waitForTask } from "../waitForTask.js";
import { runTaskLoop } from "../runTaskLoop.js";
import { getTaskLineage } from "../taskLineage.js";
import { exportTaskEvidencePack } from "../evidencePack.js";
import { recommendAgentForTask } from "../recommendAgentForTask.js";
import { auditTask } from "../auditTask.js";
import { safeStatus } from "../safeStatus.js";
import { safeAudit, safeDiffSummary, safeResult, safeTestSummary } from "../safeViews.js";
import { diagnoseTask } from "../diagnoseTask.js";
import { reconcileTasks } from "../reconcileTasks.js";
import { checkReleaseGate } from "../checkReleaseGate.js";
import { getProjectPolicyTool } from "../releaseMode.js";
import { runTask } from "../../runner/runTask.js";
import { getConfig } from "../../config.js";
import { getToolCatalogSnapshot } from "../registry.js";
import type { ToolHandlerMap } from "./types.js";
import { toResult } from "./types.js";

// ── Local helpers (moved verbatim from registry.ts) ───────────────

function normalizeWaitSeconds(args: Record<string, unknown> | undefined): number | undefined {
  const legacy = args?.wait_seconds;
  const preferred = args?.timeout_seconds;
  if (legacy !== undefined && preferred !== undefined && Number(legacy) !== Number(preferred)) {
    throw new Error("wait_seconds and timeout_seconds must match when both are supplied.");
  }
  const value = preferred ?? legacy;
  return value === undefined ? undefined : Number(value);
}

function normalizeSummaryView(value: unknown): "compact" | "standard" {
  if (value === undefined) return "standard";
  if (value !== "compact" && value !== "standard") {
    throw new Error('view must be "compact" or "standard".');
  }
  return value;
}

// ── Handler map ───────────────────────────────────────────────────

export const coreHandlers: ToolHandlerMap = {
  save_plan: async (args) => {
    return toResult(
      savePlan({
        title: String(args?.title ?? ""),
        content: args?.content !== undefined ? String(args.content) : "",
        plan_ref: args?.plan_ref ? String(args.plan_ref) : undefined,
      }),
    );
  },

  get_plan: async (args) => {
    return toResult(getPlan({ plan_id: String(args?.plan_id ?? "") }));
  },

  create_task: async (args) => {
    return toResult(
      await createTask({
        plan_id: args?.plan_id ? String(args.plan_id) : undefined,
        inline_plan: args?.inline_plan ? String(args.inline_plan) : undefined,
        plan_title: args?.plan_title ? String(args.plan_title) : undefined,
        template: args?.template ? (String(args.template) as any) : undefined,
        goal: args?.goal ? String(args.goal) : undefined,
        source_task_id: args?.source_task_id ? String(args.source_task_id) : undefined,
        agent: String(args?.agent ?? ""),
        repo_path: args?.repo_path ? String(args.repo_path) : undefined,
        test_command: args?.test_command ? String(args.test_command) : undefined,
        verify_commands: Array.isArray(args?.verify_commands)
          ? args.verify_commands.map((command) => String(command))
          : undefined,
        timeout_seconds:
          args?.timeout_seconds !== undefined ? Number(args.timeout_seconds) : undefined,
        execution_mode: args?.execution_mode === "assess_only" ? "assess_only" : "execute",
        assessment_id: args?.assessment_id ? String(args.assessment_id) : undefined,
      }),
    );
  },

  run_task_loop: async (args) => {
    return toResult(
      await runTaskLoop({
        repo_path: String(args?.repo_path ?? ""),
        goal: String(args?.goal ?? ""),
        verify_commands: Array.isArray(args?.verify_commands)
          ? args.verify_commands.map((command) => String(command))
          : [],
        agent: args?.agent ? String(args.agent) : undefined,
        template:
          args?.template === "inspect_only" || args?.template === "release_check"
            ? args.template
            : "feature_small",
        max_iterations: args?.max_iterations !== undefined ? Number(args.max_iterations) : undefined,
        task_timeout_seconds:
          args?.task_timeout_seconds !== undefined ? Number(args.task_timeout_seconds) : undefined,
        auto_fix_tests: args?.auto_fix_tests !== undefined ? Boolean(args.auto_fix_tests) : undefined,
        auto_cleanup_artifacts:
          args?.auto_cleanup_artifacts !== undefined
            ? Boolean(args.auto_cleanup_artifacts)
            : undefined,
        stop_on_high_risk:
          args?.stop_on_high_risk !== undefined ? Boolean(args.stop_on_high_risk) : undefined,
        direct_verify: args?.direct_verify !== undefined ? Boolean(args.direct_verify) : undefined,
        direct_verify_commands: Array.isArray(args?.direct_verify_commands)
          ? args.direct_verify_commands.map((command) => String(command))
          : undefined,
        direct_verify_timeout_seconds:
          args?.direct_verify_timeout_seconds !== undefined
            ? Number(args.direct_verify_timeout_seconds)
            : undefined,
        scope_files: Array.isArray(args?.scope_files)
          ? args.scope_files.map((entry) => String(entry))
          : undefined,
        isolation_mode: args?.isolation_mode === "worktree" ? "worktree" : "current_repo",
        worktree_base_branch: args?.worktree_base_branch
          ? String(args.worktree_base_branch)
          : undefined,
        worktree_cleanup:
          args?.worktree_cleanup === "archive" || args?.worktree_cleanup === "delete_ignored_only"
            ? args.worktree_cleanup
            : "keep",
      }),
    );
  },

  recommend_agent_for_task: async (args) => {
    return toResult(
      recommendAgentForTask({
        repo_path: String(args?.repo_path ?? ""),
        goal: String(args?.goal ?? ""),
        scope_files: Array.isArray(args?.scope_files)
          ? args.scope_files.map((entry) => String(entry))
          : undefined,
        template: args?.template ? String(args.template) : undefined,
        risk_hint: args?.risk_hint ? String(args.risk_hint) : undefined,
      }),
    );
  },

  get_task_lineage: async (args) => {
    return toResult(
      getTaskLineage(String(args?.lineage_id ?? ""), {
        max_items: args?.max_items !== undefined ? Number(args.max_items) : undefined,
      }),
    );
  },

  export_task_evidence_pack: async (args) => {
    return toResult(
      exportTaskEvidencePack({
        lineage_id: String(args?.lineage_id ?? ""),
        max_items: args?.max_items !== undefined ? Number(args.max_items) : undefined,
      }),
    );
  },

  get_project_policy: async (args) => {
    return toResult(getProjectPolicyTool(String(args?.repo_path ?? "")));
  },

  get_task_status: async (args) => {
    return toResult(getTaskStatus(String(args?.task_id ?? "")));
  },

  get_result: async (args) => {
    return toResult(getResult(String(args?.task_id ?? "")));
  },

  get_result_json: async (args) => {
    return toResult(getResultJson(String(args?.task_id ?? "")));
  },

  get_diff: async (args) => {
    return toResult(getDiff(String(args?.task_id ?? "")));
  },

  get_test_log: async (args) => {
    return toResult(getTestLog(String(args?.task_id ?? "")));
  },

  list_workspace: async (args) => {
    return toResult(listWorkspace(args?.path ? String(args.path) : undefined));
  },

  read_workspace_file: async (args) => {
    const sessionId = args?.session_id ? String(args.session_id) : undefined;
    return toResult(
      readWorkspaceFile({
        path: String(args?.path ?? ""),
        session_id: sessionId,
      }),
    );
  },

  list_tasks: async (args) => {
    return toResult(
      listTasks({
        status: args?.status ? String(args.status) : undefined,
        repo_path: args?.repo_path ? String(args.repo_path) : undefined,
        active_only: args?.active_only !== undefined ? Boolean(args.active_only) : undefined,
        limit: args?.limit ? Number(args.limit) : undefined,
      }),
    );
  },

  list_agents: async () => {
    return toResult(listAgents());
  },

  health_check: async (args) => {
    return toResult(
      healthCheck(getToolCatalogSnapshot(), {
        detail: args?.detail === "self_diagnostic" ? "self_diagnostic" : "standard",
      }),
    );
  },

  cancel_task: async (args) => {
    return toResult(cancelTask(String(args?.task_id ?? "")));
  },

  kill_task: async (args) => {
    return toResult(killTask(String(args?.task_id ?? "")));
  },

  retry_task: async (args) => {
    return toResult(await retryTask(String(args?.task_id ?? "")));
  },

  get_task_stdout_tail: async (args) => {
    return toResult(
      getTaskStdoutTail(String(args?.task_id ?? ""), args?.lines ? Number(args.lines) : undefined),
    );
  },

  get_task_log_tail: async (args) => {
    return toResult(
      getTaskLogTail(
        String(args?.task_id ?? ""),
        (args?.file as "stdout" | "stderr" | "test" | "verify") || "stdout",
        {
          lines: args?.lines ? Number(args.lines) : undefined,
          redact: args?.redact !== undefined ? Boolean(args.redact) : undefined,
        },
      ),
    );
  },

  get_task_progress: async (args) => {
    return toResult(getTaskProgress(String(args?.task_id ?? "")));
  },

  wait_for_task: async (args) => {
    const waitSeconds = normalizeWaitSeconds(args);
    return toResult(await waitForTask(String(args?.task_id ?? ""), waitSeconds));
  },

  get_task_summary: async (args) => {
    return toResult(
      getTaskSummary(String(args?.task_id ?? ""), {
        view: normalizeSummaryView(args?.view),
        max_items: args?.max_items !== undefined ? Number(args.max_items) : undefined,
      }),
    );
  },

  audit_task: async (args) => {
    return toResult(auditTask(String(args?.task_id ?? "")));
  },

  safe_status: async (args) => {
    return toResult(safeStatus(String(args?.task_id ?? "")));
  },

  safe_result: async (args) => {
    return toResult(
      safeResult(String(args?.task_id ?? ""), {
        max_items: args?.max_items !== undefined ? Number(args.max_items) : undefined,
      }),
    );
  },

  safe_audit: async (args) => {
    return toResult(
      safeAudit(String(args?.task_id ?? ""), {
        max_items: args?.max_items !== undefined ? Number(args.max_items) : undefined,
      }),
    );
  },

  safe_test_summary: async (args) => {
    return toResult(safeTestSummary(String(args?.task_id ?? "")));
  },

  safe_diff_summary: async (args) => {
    return toResult(
      safeDiffSummary(String(args?.task_id ?? ""), {
        max_items: args?.max_items !== undefined ? Number(args.max_items) : undefined,
      }),
    );
  },

  diagnose_task: async (args) => {
    return toResult(
      diagnoseTask({
        task_id: String(args?.task_id ?? ""),
        include_logs: args?.include_logs !== undefined ? Boolean(args.include_logs) : undefined,
      }),
    );
  },

  reconcile_tasks: async (args) => {
    return toResult(
      reconcileTasks({
        mode: args?.mode === "safe_fix" ? "safe_fix" : "report_only",
        max_age_minutes:
          args?.max_age_minutes !== undefined ? Number(args.max_age_minutes) : undefined,
        include_done_candidates:
          args?.include_done_candidates !== undefined
            ? Boolean(args.include_done_candidates)
            : undefined,
      }),
    );
  },

  check_release_gate: async (args) => {
    return toResult(
      await checkReleaseGate({
        repo_path: String(args?.repo_path ?? ""),
        target_stage: String(args?.target_stage ?? "local_ready") as any,
        package_name: args?.package_name ? String(args.package_name) : undefined,
        version: args?.version ? String(args.version) : undefined,
        github_repo: args?.github_repo ? String(args.github_repo) : undefined,
        branch: args?.branch ? String(args.branch) : undefined,
      }),
    );
  },
};

// run_task is conditionally registered (only when enableRunTaskTool === true).
// Exported separately so registry.ts can add it conditionally to the dispatch map.
export const runTaskHandler: ToolHandlerMap["run_task"] = async (args) => {
  const config = getConfig();
  if (config.enableRunTaskTool !== true) {
    throw new Error(
      "run_task is disabled. Set enableRunTaskTool: true in config to enable. Prefer using the local watcher (npm run watch).",
    );
  }
  const taskId = String(args?.task_id ?? "");
  const result = await runTask(taskId);
  return toResult(result);
};
