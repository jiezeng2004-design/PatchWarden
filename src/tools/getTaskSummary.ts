import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getConfig, getTasksDir } from "../config.js";
import { guardReadPath } from "../security/pathGuard.js";
import { getTaskStatus } from "./getTaskStatus.js";

const TERMINAL_STATUSES = new Set([
  "done",
  "failed",
  "failed_verification",
  "failed_scope_violation",
  "canceled",
]);

export interface TaskSummaryOutput {
  task_id: string;
  status: string;
  terminal: boolean;
  acceptance_status: "pending" | "ready_for_review" | "needs_review" | "failed";
  phase: string;
  agent: string;
  workspace_root: string;
  repo_path: string;
  resolved_repo_path: string;
  changed_files: unknown[];
  out_of_scope_changes: unknown[];
  workspace_dirty_before: boolean;
  workspace_dirty_after: boolean;
  verify_status: string;
  verify_commands: unknown[];
  last_heartbeat_at: string;
  current_command: string | null;
  elapsed_ms: number;
  summary: string;
  test_summary: string;
  diff_available: boolean;
  diff_truncated: boolean;
  result_available: boolean;
  result_json_available: boolean;
  verify_available: boolean;
  test_log_available: boolean;
  warnings: string[];
  errors: string[];
  artifacts: Record<string, boolean>;
}

export function getTaskSummary(taskId: string): TaskSummaryOutput {
  const config = getConfig();
  const taskDir = resolve(getTasksDir(config), taskId);
  const statusFile = join(taskDir, "status.json");
  guardReadPath(statusFile, config.workspaceRoot, config.tasksDir);
  const status = getTaskStatus(taskId) as any;
  const resultRead = tryReadJson(join(taskDir, "result.json"));
  const verifyRead = tryReadJson(join(taskDir, "verify.json"));
  const result = resultRead.data;
  const verify = verifyRead.data;
  const terminal = TERMINAL_STATUSES.has(String(status.status));
  const outOfScope = asArray(result.out_of_scope_changes ?? status.out_of_scope_changes);
  const verifyStatus = String(verify.status ?? result.verify_status ?? result.verify?.status ?? status.verify_status ?? "not_available");
  const errors = [status.error, ...asArray(result.errors), ...asArray(result.known_issues)]
    .filter((value): value is string => typeof value === "string" && value.trim() !== "");
  const warnings = asArray(result.warnings).filter((value): value is string => typeof value === "string");
  const artifacts = Object.fromEntries([
    "result.md",
    "result.json",
    "diff.patch",
    "git.diff",
    "test.log",
    "verify.log",
    "verify.json",
    "changed-files.json",
    "rollback_scope_violation_plan.md",
  ].map((name) => [name, existsSync(join(taskDir, name))]));

  for (const required of ["result.md", "result.json", "diff.patch", "test.log", "verify.json"]) {
    if (!artifacts[required]) warnings.push(`${required} is missing.`);
  }
  if (resultRead.error) warnings.push(`result.json could not be parsed; using status.json/result.md fallback: ${resultRead.error}`);
  if (verifyRead.error) warnings.push(`verify.json could not be parsed; using status.json fallback: ${verifyRead.error}`);

  let acceptanceStatus: TaskSummaryOutput["acceptance_status"] = "pending";
  if (terminal) {
    if (status.status !== "done" || outOfScope.length > 0 || verifyStatus === "failed") {
      acceptanceStatus = "failed";
    } else if (verifyStatus === "passed") {
      acceptanceStatus = "ready_for_review";
    } else {
      acceptanceStatus = "needs_review";
      warnings.push("No passing verify_commands evidence is available; manual review is required.");
    }
  }

  const startedAt = Date.parse(String(status.started_at || status.created_at || ""));
  const finishedAt = Date.parse(String(status.finished_at || ""));
  const elapsedMs = Number.isFinite(startedAt)
    ? Math.max(0, (Number.isFinite(finishedAt) ? finishedAt : Date.now()) - startedAt)
    : 0;
  const changedFiles = asArray(result.changed_files ?? status.changed_files);

  return {
    task_id: taskId,
    status: String(status.status || "unknown"),
    terminal,
    acceptance_status: acceptanceStatus,
    phase: String(status.phase || "unknown"),
    agent: String(status.agent || result.agent || ""),
    workspace_root: String(status.workspace_root || result.workspace_root || config.workspaceRoot),
    repo_path: String(status.repo_path || result.repo_path || ""),
    resolved_repo_path: String(status.resolved_repo_path || result.resolved_repo_path || ""),
    changed_files: changedFiles,
    out_of_scope_changes: outOfScope,
    workspace_dirty_before: Boolean(status.workspace_dirty_before ?? result.workspace_dirty_before),
    workspace_dirty_after: Boolean(status.workspace_dirty_after ?? status.workspace_dirty ?? result.workspace_dirty_after),
    verify_status: verifyStatus,
    verify_commands: asArray(verify.commands ?? result.verify_commands ?? result.verify?.commands),
    last_heartbeat_at: String(status.last_heartbeat_at || status.updated_at || ""),
    current_command: status.current_command ?? null,
    elapsed_ms: elapsedMs,
    summary: String(result.summary || readResultFallback(join(taskDir, "result.md")) || status.error || `Task is ${status.status || "unknown"}.`),
    test_summary: summarizeTestLog(join(taskDir, "test.log")),
    diff_available: Boolean(
      (status.diff_available ?? (changedFiles.length > 0)) &&
      (artifacts["diff.patch"] || artifacts["git.diff"])
    ),
    diff_truncated: Boolean(status.diff_truncated || result.warnings?.some?.((warning: string) => warning.includes("diff.patch was truncated"))),
    result_available: artifacts["result.md"],
    result_json_available: artifacts["result.json"],
    verify_available: artifacts["verify.json"],
    test_log_available: artifacts["test.log"],
    warnings: [...new Set(warnings)],
    errors: [...new Set(errors)],
    artifacts,
  };
}

function tryReadJson(path: string): { data: Record<string, any>; error?: string } {
  if (!existsSync(path)) return { data: {} };
  try {
    return { data: JSON.parse(readFileSync(path, "utf-8")) };
  } catch (error) {
    return { data: {}, error: error instanceof Error ? error.message : String(error) };
  }
}

function asArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function summarizeTestLog(path: string): string {
  if (!existsSync(path)) return "test.log missing";
  const text = readFileSync(path, "utf-8");
  const exit = text.match(/Exit\s*code:\s*([^\r\n]+)/i)?.[1]?.trim();
  return exit ? `Exit code: ${exit}` : text.trim().slice(0, 500) || "test.log empty";
}

function readResultFallback(path: string): string {
  if (!existsSync(path)) return "";
  const text = readFileSync(path, "utf-8");
  return text.match(/## Summary\s+([\s\S]*?)(?:\n## |\n---|$)/i)?.[1]?.trim().slice(0, 1000) || "";
}
