import { getTaskFile, GetTaskFileOutput } from "./getTaskFile.js";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { getConfig, getTasksDir } from "../config.js";
import { guardPath } from "../security/pathGuard.js";
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
  if (!existsSync(preferred) && !existsSync(fallback)) {
    return getTaskFile(taskId, "diff.patch");
  }
  const filePath = existsSync(preferred) ? preferred : fallback;
  guardPath(filePath, config.workspaceRoot, config.tasksDir);
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
    available: true,
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
      patch_mode: evidence.patch_mode || (evidence.diff_available ? "hash_only" : "no_changes"),
      unavailable_reason: evidence.unavailable_reason || null,
      message: evidence.diff_available ? "Task diff available" : "No task file changes detected",
    } as GetTaskFileOutput;
  } catch {
    return diff;
  }
}

export function getTestLog(taskId: string, options?: { tailLines?: number; maxBytes?: number }): GetTaskFileOutput {
  const maxBytes = options?.maxBytes ?? 0;
  const tailLines = options?.tailLines ?? 0;
  if (tailLines > 0 || maxBytes > 0) {
    return getTaskFileTail(taskId, "test.log", { tailLines, maxBytes });
  }
  return getTaskFile(taskId, "test.log");
}

/**
 * Read the tail of a task log file with automatic redaction.
 * Supports test.log, stdout.log, stderr.log, verify.log.
 */
export function getTaskLogTail(
  taskId: string,
  file: "stdout" | "stderr" | "test" | "verify",
  options?: { lines?: number; redact?: boolean }
) {
  const config = getConfig();
  const taskDir = resolve(getTasksDir(config), taskId);
  const filename = file === "stdout" ? "stdout.log"
    : file === "stderr" ? "stderr.log"
    : file === "test" ? "test.log"
    : "verify.log";
  const filePath = join(taskDir, filename);
  guardPath(filePath, config.workspaceRoot, config.tasksDir);

  const maxLines = Math.min(options?.lines ?? 80, 200);
  const applyRedact = options?.redact !== false; // default true

  if (!existsSync(filePath)) {
    return { ...getTaskFile(taskId, filename), file, lines: 0, total_bytes: 0 };
  }

  const stat = statSync(filePath);
  const totalBytes = stat.size;
  const raw = readFileSync(filePath, "utf-8");
  const tail = raw.split("\n").slice(-maxLines).join("\n");
  const content = applyRedact ? redactSensitiveContent(tail) : { content: tail, redacted: false, redaction_categories: [] as string[] };

  return {
    task_id: taskId,
    file,
    filename,
    content: content.content,
    available: true,
    lines: tail.split("\n").length,
    total_bytes: totalBytes,
    truncated: totalBytes > Buffer.byteLength(tail, "utf-8"),
    redacted: content.redacted,
    redaction_categories: content.redaction_categories,
  };
}

function getTaskFileTail(
  taskId: string,
  filename: string,
  options: { tailLines: number; maxBytes: number }
): GetTaskFileOutput {
  const config = getConfig();
  const taskDir = resolve(getTasksDir(config), taskId);
  const filePath = join(taskDir, filename);
  guardPath(filePath, config.workspaceRoot, config.tasksDir);

  if (!existsSync(filePath)) {
    return getTaskFile(taskId, filename);
  }

  const stat = statSync(filePath);
  const raw = readFileSync(filePath, "utf-8");
  let content = raw;
  if (options.tailLines > 0) {
    content = raw.split("\n").slice(-options.tailLines).join("\n");
  }
  if (options.maxBytes > 0 && Buffer.byteLength(content, "utf-8") > options.maxBytes) {
    content = content.slice(0, options.maxBytes);
  }
  const redaction = redactSensitiveContent(content);
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
