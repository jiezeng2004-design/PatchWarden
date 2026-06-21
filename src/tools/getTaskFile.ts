import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { getTasksDir, getConfig } from "../config.js";
import { guardPath } from "../security/pathGuard.js";
import { guardSensitivePath } from "../security/sensitiveGuard.js";
import { redactSensitiveContent } from "../security/contentRedaction.js";
import { getTaskStatus } from "./getTaskStatus.js";

export interface GetTaskFileOutput {
  task_id: string;
  filename: string;
  content: string;
  path: string;
  available: boolean;
  reason?: "task_not_terminal" | "artifact_missing";
  task_status?: string;
  phase?: string;
  pending_reason?: string | null;
  watcher?: unknown;
  next_action?: string;
  next_tool_call?: { name: string; arguments: Record<string, unknown> };
  redacted?: boolean;
  redaction_categories?: string[];
}

export const TASK_READ_ONLY_FILES = [
  "result.md",
  "result.json",
  "git.diff",
  "diff.patch",
  "test.log",
  "verify.log",
  "verify.json",
  "status.json",
  "plan.md",
  "error.log",
  "stdout.log",
  "stderr.log",
  "progress.md",
  "changed-files.json",
  "file-stats.json",
  "rollback-plan.json",
  "rollback_scope_violation_plan.md",
];

/**
 * Read a task output file: result.md, git.diff, test.log, etc.
 */
export function getTaskFile(taskId: string, filename: string): GetTaskFileOutput {
  const config = getConfig();
  const tasksDir = getTasksDir(config);

  // Only allow known filenames
  if (!TASK_READ_ONLY_FILES.includes(filename)) {
    throw new Error(`File "${filename}" is not allowed. Allowed: ${TASK_READ_ONLY_FILES.join(", ")}`);
  }

  const taskDir = resolve(tasksDir, taskId);
  const filePath = join(taskDir, filename);

  guardPath(filePath, config.workspaceRoot, config.tasksDir);
  guardSensitivePath(filePath);

  if (!existsSync(filePath)) {
    const status = getTaskStatus(taskId);
    const terminal = !["pending", "running"].includes(status.status);
    const watcherBlocked = status.status === "pending" && !status.watcher.available;
    return {
      task_id: taskId,
      filename,
      content: "",
      path: filePath,
      available: false,
      reason: terminal ? "artifact_missing" : "task_not_terminal",
      task_status: status.status,
      phase: status.phase,
      pending_reason: status.pending_reason,
      watcher: status.watcher,
      next_action: terminal
        ? `The task is terminal but ${filename} is missing. Review get_task_summary and audit_task warnings.`
        : watcherBlocked
          ? "The task is queued but the watcher is unavailable. Call health_check and restart the owned watcher."
          : "The task is still running or queued. Call wait_for_task or get_task_status before reading this artifact.",
      next_tool_call: terminal
        ? { name: "get_task_summary", arguments: { task_id: taskId } }
        : watcherBlocked
          ? { name: "health_check", arguments: { detail: "standard" } }
          : { name: "wait_for_task", arguments: { task_id: taskId, timeout_seconds: 25 } },
      redacted: false,
      redaction_categories: [],
    };
  }

  const stat = statSync(filePath);
  if (stat.size > config.maxReadFileBytes) {
    throw new Error(
      `File "${filename}" is ${stat.size} bytes, exceeds max of ${config.maxReadFileBytes} bytes.`
    );
  }

  const redaction = redactSensitiveContent(readFileSync(filePath, "utf-8"));
  return {
    task_id: taskId,
    filename,
    content: redaction.content,
    path: filePath,
    available: true,
    redacted: redaction.redacted,
    redaction_categories: redaction.redaction_categories,
  };
}
