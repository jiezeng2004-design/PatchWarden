/**
 * Dispatch handlers for Goal Session tools (v0.8.0+).
 *
 * Covers goal lifecycle, subgoal management, Spec Kit import,
 * worktree merge/discard, and goal reporting.
 */

import { createGoal, listGoals, readGoal, readGoalStatus } from "../../goal/goalStore.js";
import { suggestNextSubgoal } from "../../goal/goalGraph.js";
import { exportHandoff } from "../../goal/handoffExport.js";
import { acceptSubgoal, rejectSubgoal, summarizeGoalProgress } from "../../goal/goalProgress.js";
import { exportGoalReport } from "../../goal/goalReport.js";
import { importSpecKitTasks, parseSpecKitJson } from "../../goal/specKitImport.js";
import { createSubgoalTask } from "../goals/goalSubgoalTask.js";
import { mergeWorktreeTool } from "../workspace/mergeWorktree.js";
import { discardWorktreeTool } from "../workspace/discardWorktree.js";
import type { ToolHandlerMap } from "./types.js";
import { toResult } from "./types.js";
import { parseOptionalTaskTemplate } from "./validation.js";

export const goalHandlers: ToolHandlerMap = {
  create_goal: async (args) => {
    return toResult(
      createGoal(
        String(args?.repo_path ?? ""),
        String(args?.title ?? ""),
        String(args?.goal_description ?? ""),
      ),
    );
  },

  list_goals: async () => {
    return toResult({ goals: listGoals() });
  },

  read_goal: async (args) => {
    return toResult(readGoal(String(args?.goal_id ?? "")));
  },

  create_subgoal_task: async (args) => {
    return toResult(
      await createSubgoalTask({
        goal_id: String(args?.goal_id ?? ""),
        subgoal_title: String(args?.subgoal_title ?? ""),
        depends_on: Array.isArray(args?.depends_on) ? args.depends_on.map(String) : undefined,
        plan_id: args?.plan_id ? String(args.plan_id) : undefined,
        inline_plan: args?.inline_plan ? String(args.inline_plan) : undefined,
        plan_title: args?.plan_title ? String(args.plan_title) : undefined,
        template: parseOptionalTaskTemplate(args?.template),
        goal: args?.goal ? String(args.goal) : undefined,
        agent: args?.agent ? String(args.agent) : undefined,
        repo_path: String(args?.repo_path ?? ""),
        test_command: args?.test_command ? String(args.test_command) : undefined,
        verify_commands: Array.isArray(args?.verify_commands)
          ? args.verify_commands.map(String)
          : undefined,
        timeout_seconds: args?.timeout_seconds ? Number(args.timeout_seconds) : undefined,
        scope: Array.isArray(args?.scope) ? args.scope.map(String) : undefined,
        forbidden: Array.isArray(args?.forbidden) ? args.forbidden.map(String) : undefined,
        verification: Array.isArray(args?.verification) ? args.verification.map(String) : undefined,
        done_evidence: Array.isArray(args?.done_evidence) ? args.done_evidence.map(String) : undefined,
        isolate_worktree:
          args?.isolate_worktree === undefined ? undefined : Boolean(args.isolate_worktree),
      }),
    );
  },

  accept_subgoal: async (args) => {
    return toResult(
      acceptSubgoal(String(args?.goal_id ?? ""), String(args?.subgoal_id ?? "")),
    );
  },

  reject_subgoal: async (args) => {
    return toResult(
      rejectSubgoal(
        String(args?.goal_id ?? ""),
        String(args?.subgoal_id ?? ""),
        String(args?.reason ?? ""),
      ),
    );
  },

  suggest_next_subgoal: async (args) => {
    const goalStatus = readGoalStatus(String(args?.goal_id ?? ""));
    return toResult(suggestNextSubgoal(goalStatus));
  },

  summarize_goal_progress: async (args) => {
    return toResult(summarizeGoalProgress(String(args?.goal_id ?? "")));
  },

  export_handoff: async (args) => {
    const goalId = String(args?.goal_id ?? "");
    const goalStatus = readGoalStatus(goalId);
    return toResult(exportHandoff(goalId, goalStatus));
  },

  export_goal_report: async (args) => {
    const goalId = String(args?.goal_id ?? "");
    return toResult(exportGoalReport(goalId));
  },

  import_speckit_tasks: async (args) => {
    const goalId = String(args?.goal_id ?? "");
    const jsonText = String(args?.spec_kit_json ?? "");
    const input = parseSpecKitJson(jsonText);
    return toResult(importSpecKitTasks(goalId, input));
  },

  merge_worktree: async (args) => {
    return toResult(
      mergeWorktreeTool({
        worktree_id: String(args?.worktree_id ?? ""),
        repo_path: String(args?.repo_path ?? ""),
      }),
    );
  },

  discard_worktree: async (args) => {
    return toResult(
      discardWorktreeTool({
        worktree_id: String(args?.worktree_id ?? ""),
        repo_path: String(args?.repo_path ?? ""),
      }),
    );
  },
};
