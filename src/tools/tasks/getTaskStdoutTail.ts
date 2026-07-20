import { existsSync } from "node:fs";
import { join } from "node:path";
import { getTasksDir, getConfig } from "../../config.js";
import { guardReadPath } from "../../security/pathGuard.js";
import { redactSensitiveContent } from "../../security/contentRedaction.js";
import { readTextFilePrefixSync, readTextFileTailLinesSync } from "../../utils/boundedFile.js";

export function getTaskStdoutTail(taskId: string, lines = 80) {
  const config = getConfig();
  const tasksDir = getTasksDir(config);
  const taskDir = join(tasksDir, taskId);
  const statusFile = join(taskDir, "status.json");

  // First verify the task exists
  guardReadPath(statusFile, config.workspaceRoot, config.tasksDir);
  if (!existsSync(statusFile)) {
    throw new Error(`Task not found: "${taskId}"`);
  }

  const stdoutLog = join(taskDir, "stdout.log");
  const stderrLog = join(taskDir, "stderr.log");
  const resultFile = join(taskDir, "result.md");
  const maxLines = Number.isFinite(lines)
    ? Math.max(1, Math.min(200, Math.trunc(lines)))
    : 80;
  const stderrLines = Math.min(maxLines, 40);

  let stdoutTail = "";
  let stderrTail = "";
  let source = "none";

  // All log files are optional — don't throw if missing
  if (existsSync(stdoutLog)) {
    stdoutTail = readTextFileTailLinesSync(stdoutLog, maxLines, config.maxReadFileBytes);
    source = "stdout.log";
  }
  if (existsSync(stderrLog)) {
    stderrTail = readTextFileTailLinesSync(stderrLog, stderrLines, config.maxReadFileBytes);
  }

  // Fallback to result.md
  if (!stdoutTail && existsSync(resultFile)) {
    const raw = readTextFilePrefixSync(resultFile, config.maxReadFileBytes).content;
    const stdoutMatch = raw.match(/## Agent stdout\s*\n+```\s*([\s\S]*?)```/i);
    const stderrMatch = raw.match(/## Agent stderr\s*\n+```\s*([\s\S]*?)```/i);
    if (stdoutMatch) stdoutTail = stdoutMatch[1].split("\n").slice(-maxLines).join("\n");
    if (stderrMatch && !stderrTail) stderrTail = stderrMatch[1].split("\n").slice(-stderrLines).join("\n");
    if (source === "none") source = "result.md";
  }

  const stdoutRedacted = redactSensitiveContent(stdoutTail || "(no output yet — task may be pending or not started)");
  const stderrRedacted = redactSensitiveContent(stderrTail || "(no stderr)");

  return {
    task_id: taskId,
    lines: stdoutTail ? stdoutTail.split("\n").length : 0,
    stdout_tail: stdoutRedacted.content,
    stderr_tail: stderrRedacted.content,
    source,
    redacted: stdoutRedacted.redacted || stderrRedacted.redacted,
    redaction_categories: [...new Set([...stdoutRedacted.redaction_categories, ...stderrRedacted.redaction_categories])],
  };
}
