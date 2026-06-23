import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getConfig } from "../config.js";
import { guardDirectCommand } from "../security/commandGuard.js";
import { redactSensitiveContent } from "../security/contentRedaction.js";
import { runSimpleProcess } from "../runner/simpleProcess.js";
import { getDirectSessionDir } from "./directSessionStore.js";
import type { DirectSessionVerificationRun } from "./directSessionStore.js";

const MAX_TAIL_CHARS = 10_000;
const DEFAULT_TIMEOUT_SECONDS = 120;

export interface RunDirectVerificationInput {
  command: string;
  resolvedRepoPath: string;
  sessionId: string;
  timeoutSeconds?: number;
}

export interface RunDirectVerificationResult {
  run: DirectSessionVerificationRun;
  log_path: string;
}

export async function runDirectVerification(
  input: RunDirectVerificationInput
): Promise<RunDirectVerificationResult> {
  const config = getConfig();
  const allowedCommand = guardDirectCommand(
    input.command,
    config,
    input.resolvedRepoPath
  );

  const timeoutSeconds = input.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  const timeoutMs = timeoutSeconds * 1000;

  // Parse command into command + args
  const parts = parseCommand(allowedCommand);
  if (!parts) {
    throw new Error(`Failed to parse command: "${allowedCommand}"`);
  }

  const sessionDir = getDirectSessionDir(input.sessionId);
  const logPath = join(sessionDir, "verification.log");

  const startedAt = new Date().toISOString();
  const result = await runSimpleProcess({
    command: parts.command,
    args: parts.args,
    cwd: input.resolvedRepoPath,
    timeoutMs,
    stdoutPath: logPath,
    stderrPath: logPath,
  });
  const finishedAt = new Date().toISOString();

  // Redact and truncate output
  const stdoutRedacted = redactSensitiveContent(result.stdout || "");
  const stderrRedacted = redactSensitiveContent(result.stderr || "");

  const stdoutTail = truncateTail(stdoutRedacted.content, MAX_TAIL_CHARS);
  const stderrTail = truncateTail(stderrRedacted.content, MAX_TAIL_CHARS);

  const passed = result.exitCode === 0 && !result.timedOut;

  const run: DirectSessionVerificationRun = {
    command: allowedCommand,
    exit_code: result.exitCode,
    passed,
    timed_out: result.timedOut,
    stdout_tail: stdoutTail,
    stderr_tail: stderrTail,
    started_at: startedAt,
    finished_at: finishedAt,
    log_path: logPath,
  };

  // Write verification.json
  const verificationJson = {
    command: allowedCommand,
    exit_code: result.exitCode,
    passed,
    timed_out: result.timedOut,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: new Date(finishedAt).getTime() - new Date(startedAt).getTime(),
    stdout_truncated: result.stdoutTruncated,
    stderr_truncated: result.stderrTruncated,
    redacted: stdoutRedacted.redacted || stderrRedacted.redacted,
    redaction_categories: [
      ...new Set([
        ...stdoutRedacted.redaction_categories,
        ...stderrRedacted.redaction_categories,
      ]),
    ],
    spawn_error: result.spawnError,
  };

  writeFileSync(
    join(sessionDir, "verification.json"),
    JSON.stringify(verificationJson, null, 2),
    "utf-8"
  );

  return { run, log_path: logPath };
}

// ── Helpers ────────────────────────────────────────────────────────

function parseCommand(
  command: string
): { command: string; args: string[] } | null {
  const trimmed = command.trim();
  if (!trimmed) return null;

  // Simple split by spaces - sufficient for allowlisted commands like "npm test"
  const parts = trimmed.split(/\s+/);

  // On Windows, npm/npx are batch files (.cmd) and spawn() cannot find them
  // without shell resolution. Wrap with cmd.exe /c for those commands.
  if (process.platform === "win32" && (parts[0] === "npm" || parts[0] === "npx")) {
    return {
      command: "cmd",
      args: ["/c", ...parts],
    };
  }

  return {
    command: parts[0],
    args: parts.slice(1),
  };
}

function truncateTail(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  return "...(truncated)\n" + content.slice(content.length - maxChars);
}
