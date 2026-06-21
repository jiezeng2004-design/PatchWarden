import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getTasksDir, getConfig } from "../config.js";
import { guardReadPath } from "../security/pathGuard.js";
import { redactSensitiveContent } from "../security/contentRedaction.js";

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
  const maxLines = Math.min(lines, 200);

  let stdoutTail = "";
  let stderrTail = "";
  let source = "none";

  // All log files are optional — don't throw if missing
  if (existsSync(stdoutLog)) {
    const raw = readFileSync(stdoutLog, "utf-8");
    stdoutTail = raw.split("\n").slice(-maxLines).join("\n");
    source = "stdout.log";
  }
  if (existsSync(stderrLog)) {
    const raw = readFileSync(stderrLog, "utf-8");
    stderrTail = raw.split("\n").slice(-Math.min(maxLines, 40)).join("\n");
  }

  // Fallback to result.md
  if (!stdoutTail && existsSync(resultFile)) {
    const raw = readFileSync(resultFile, "utf-8");
    const stdoutMatch = raw.match(/## Agent stdout\s*\n+```\s*([\s\S]*?)```/i);
    const stderrMatch = raw.match(/## Agent stderr\s*\n+```\s*([\s\S]*?)```/i);
    if (stdoutMatch) stdoutTail = stdoutMatch[1].split("\n").slice(-maxLines).join("\n");
    if (stderrMatch && !stderrTail) stderrTail = stderrMatch[1].split("\n").slice(-Math.min(maxLines, 40)).join("\n");
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
