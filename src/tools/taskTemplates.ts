import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getConfig, getTasksDir } from "../config.js";
import { PatchWardenError } from "../errors.js";
import { guardReadPath } from "../security/pathGuard.js";

export const TASK_TEMPLATE_NAMES = [
  "inspect_only",
  "feature_small",
  "fix_tests",
  "release_check",
  "rollback_scope_violation",
] as const;

export type TaskTemplateName = typeof TASK_TEMPLATE_NAMES[number];
export type ChangePolicy = "repo_scoped_changes" | "no_changes";

export interface TaskTemplateInput {
  template: TaskTemplateName;
  goal: string;
  source_task_id?: string;
  verify_commands: string[];
}

export interface ExpandedTaskTemplate {
  title: string;
  content: string;
  change_policy: ChangePolicy;
}

export function expandTaskTemplate(input: TaskTemplateInput): ExpandedTaskTemplate {
  const goal = input.goal.trim();
  if (!goal) {
    throw new PatchWardenError(
      "template_goal_required",
      "Template tasks require a non-empty goal.",
      "Pass a concise goal describing the desired inspection or repository-local change."
    );
  }

  const common = [
    `## Goal\n${goal}`,
    "## Safety boundaries",
    "- Work only inside the resolved repository path.",
    "- Leave repository changes uncommitted for review; remote operations are outside this task.",
    "- Keep credentials private and do not modify unrelated files.",
    "- Report exact files inspected or changed and any remaining uncertainty.",
  ];

  switch (input.template) {
    case "inspect_only":
      return {
        title: `Inspect only: ${shortTitle(goal)}`,
        change_policy: "no_changes",
        content: [
          ...common,
          "## Execution contract",
          "- Perform read-only inspection only.",
          "- Do not create, edit, delete, rename, format, or generate repository files.",
          "- Return findings, evidence, and the smallest safe next action.",
        ].join("\n\n"),
      };

    case "feature_small":
      return {
        title: `Small feature: ${shortTitle(goal)}`,
        change_policy: "repo_scoped_changes",
        content: [
          ...common,
          "## Execution contract",
          "- Read the repository instructions, README, and package metadata first.",
          "- Make the smallest coherent implementation; avoid framework, dependency, and directory changes unless required.",
          "- Run only the independently configured verification commands.",
        ].join("\n\n"),
      };

    case "fix_tests":
      if (input.verify_commands.length === 0) {
        throw new PatchWardenError(
          "template_verification_required",
          "The fix_tests template requires at least one allow-listed verify_commands entry.",
          "Pass the failing test or check command in verify_commands."
        );
      }
      return {
        title: `Fix tests: ${shortTitle(goal)}`,
        change_policy: "repo_scoped_changes",
        content: [
          ...common,
          "## Execution contract",
          "- Reproduce the relevant failure before editing when possible.",
          "- Fix the root cause without deleting tests, weakening checks, or changing unrelated behavior.",
          `- PatchWarden will independently run: ${input.verify_commands.join(", ")}.`,
        ].join("\n\n"),
      };

    case "release_check":
      return {
        title: `Release check: ${shortTitle(goal)}`,
        change_policy: "repo_scoped_changes",
        content: [
          ...common,
          "## Execution contract",
          "- Perform local release-readiness checks and inspect package contents and generated artifacts.",
          "- Do not publish, push, create tags/releases, or claim remote completion without live remote evidence.",
          "- Clearly separate local readiness from remote publication state.",
        ].join("\n\n"),
      };

    case "rollback_scope_violation": {
      const evidence = readRollbackEvidence(input.source_task_id);
      return {
        title: `Scope violation review: ${shortTitle(goal)}`,
        change_policy: "no_changes",
        content: [
          ...common,
          "## Execution contract",
          `- Review scope-violation evidence from source task ${input.source_task_id}.`,
          "- Do not perform an automatic rollback, deletion, reset, checkout, or cross-repository edit.",
          "- Produce a file-by-file recovery proposal with backup and verification steps for user approval.",
          "## Source task recovery evidence",
          evidence,
        ].join("\n\n"),
      };
    }
  }
}

function readRollbackEvidence(sourceTaskId?: string): string {
  if (!sourceTaskId?.trim()) {
    throw new PatchWardenError(
      "source_task_required",
      "rollback_scope_violation requires source_task_id.",
      "Pass the task ID that ended with failed_scope_violation."
    );
  }
  const config = getConfig();
  const taskDir = resolve(getTasksDir(config), sourceTaskId);
  const statusFile = join(taskDir, "status.json");
  const rollbackFile = join(taskDir, "rollback_scope_violation_plan.md");
  guardReadPath(statusFile, config.workspaceRoot, config.tasksDir);
  guardReadPath(rollbackFile, config.workspaceRoot, config.tasksDir);
  if (!existsSync(statusFile) || !existsSync(rollbackFile)) {
    throw new PatchWardenError(
      "scope_violation_evidence_missing",
      `Source task "${sourceTaskId}" does not contain scope-violation recovery evidence.`,
      "Use a task that ended with failed_scope_violation and has rollback_scope_violation_plan.md."
    );
  }
  const status = JSON.parse(readFileSync(statusFile, "utf-8"));
  if (status.status !== "failed_scope_violation") {
    throw new PatchWardenError(
      "source_task_not_scope_violation",
      `Source task "${sourceTaskId}" has status "${status.status}", not failed_scope_violation.`,
      "Use the scope-violating task as source_task_id."
    );
  }
  return readFileSync(rollbackFile, "utf-8").slice(0, 20_000);
}

function shortTitle(goal: string): string {
  return goal.replace(/\s+/g, " ").slice(0, 80);
}
