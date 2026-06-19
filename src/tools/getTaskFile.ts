import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { getTasksDir, getConfig } from "../config.js";
import { guardReadPath } from "../security/pathGuard.js";
import { guardSensitivePath } from "../security/sensitiveGuard.js";
import { redactSensitiveContent } from "../security/contentRedaction.js";

export interface GetTaskFileOutput {
  task_id: string;
  filename: string;
  content: string;
  path: string;
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
  "progress.md",
  "changed-files.json",
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

  guardReadPath(filePath, config.workspaceRoot, config.tasksDir);
  guardSensitivePath(filePath);

  if (!existsSync(filePath)) {
    throw new Error(`File "${filename}" not found in task "${taskId}".`);
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
    redacted: redaction.redacted,
    redaction_categories: redaction.redaction_categories,
  };
}
