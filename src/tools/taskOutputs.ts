import { getTaskFile, GetTaskFileOutput } from "./getTaskFile.js";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { getConfig, getTasksDir } from "../config.js";
import { guardReadPath } from "../security/pathGuard.js";
import { redactSensitiveContent } from "../security/contentRedaction.js";

export function getResult(taskId: string): GetTaskFileOutput {
  return getTaskFile(taskId, "result.md");
}

export function getResultJson(taskId: string): GetTaskFileOutput {
  return getTaskFile(taskId, "result.json");
}

export function getDiff(taskId: string): GetTaskFileOutput {
  const config = getConfig();
  const taskDir = resolve(getTasksDir(config), taskId);
  const preferred = join(taskDir, "diff.patch");
  const fallback = join(taskDir, "git.diff");
  const filePath = existsSync(preferred) ? preferred : fallback;
  guardReadPath(filePath, config.workspaceRoot, config.tasksDir);
  const size = statSync(filePath).size;
  const raw = readFileSync(filePath, "utf-8");
  const patchHead = raw.slice(0, config.maxReadFileBytes);
  const rawReturnedBytes = Buffer.byteLength(patchHead, "utf-8");
  const redaction = redactSensitiveContent(patchHead);
  const content = redaction.content;
  const diff = {
    task_id: taskId,
    filename: existsSync(preferred) ? "diff.patch" : "git.diff",
    content,
    path: filePath,
    truncated: size > rawReturnedBytes,
    total_bytes: size,
    returned_bytes: Buffer.byteLength(content, "utf-8"),
    patch_head: content,
    diff_patch_path: filePath,
    redacted: redaction.redacted,
    redaction_categories: redaction.redaction_categories,
  } as GetTaskFileOutput;
  try {
    const evidence = JSON.parse(getTaskFile(taskId, "changed-files.json").content);
    return {
      ...diff,
      changed_files: evidence.changed_files || [],
      diff_available: Boolean(evidence.diff_available),
      workspace_dirty_before: Boolean(evidence.workspace_dirty_before),
      workspace_dirty_after: Boolean(evidence.workspace_dirty_after),
      diff_truncated: Boolean(evidence.diff_truncated || (diff as any).truncated),
      diff_size_bytes: Number(evidence.diff_size_bytes || size),
      additions: Number(evidence.additions || 0),
      deletions: Number(evidence.deletions || 0),
      file_stats: evidence.file_stats || [],
      message: evidence.diff_available ? "Task diff available" : "No task file changes detected",
    } as GetTaskFileOutput;
  } catch {
    return diff;
  }
}

export function getTestLog(taskId: string): GetTaskFileOutput {
  return getTaskFile(taskId, "test.log");
}
