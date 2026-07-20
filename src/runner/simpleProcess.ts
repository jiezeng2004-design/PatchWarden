import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  allowedEnvironmentValues,
  buildChildEnvironment,
  prepareShellFreeCommand,
  redactProcessOutput,
  resolveTrustedExecutable,
  SecureProcessLogCapture,
} from "./processSecurity.js";

const GRACEFUL_KILL_MS = 2000;

export interface SimpleProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  stdoutPath?: string;
  stderrPath?: string;
  environmentVariableNames?: string[];
  blockedEnvironmentVariableNames?: string[];
  maxLogBytes?: number;
}

export interface SimpleProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  spawnError: string | null;
  timedOut: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

const DEFAULT_MAX_STDOUT = 524288;
const DEFAULT_MAX_STDERR = 131072;

export function runSimpleProcessSync(options: SimpleProcessOptions): SimpleProcessResult {
  const maxStdout = options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT;
  const maxStderr = options.maxStderrBytes ?? DEFAULT_MAX_STDERR;
  const exactRedactionValues = allowedEnvironmentValues(options.environmentVariableNames);
  const logCapture = new SecureProcessLogCapture(
    [options.stdoutPath, options.stderrPath],
    options.maxLogBytes,
  );

  let result;
  try {
    const env = buildChildEnvironment({
      cwd: options.cwd,
      allowedNames: options.environmentVariableNames,
      blockedNames: options.blockedEnvironmentVariableNames,
    });
    const prepared = prepareShellFreeCommand(options.command, options.args, options.cwd, { pathValue: env.PATH });
    const command = resolveTrustedExecutable(prepared.command, options.cwd, { pathValue: env.PATH });
    result = spawnSync(command, prepared.args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: options.timeoutMs,
      windowsHide: true,
      maxBuffer: maxStdout + 1024,
      encoding: "utf-8",
      env,
    });
  } catch (error) {
    return {
      exitCode: null,
      stdout: "",
      stderr: "",
      spawnError: error instanceof Error ? error.message : String(error),
      timedOut: false,
      stdoutTruncated: false,
      stderrTruncated: false,
    };
  }

  const rawStdout = result.stdout || "";
  const rawStderr = result.stderr || "";
  const stdout = redactProcessOutput(rawStdout, exactRedactionValues);
  const stderr = redactProcessOutput(rawStderr, exactRedactionValues);
  const timedOut: boolean = Boolean(
    result.signal === "SIGTERM" || result.signal === "SIGKILL" ||
    (result.signal !== null && result.status === null) ||
    (result.error && errorCode(result.error) === "ETIMEDOUT")
  );

  logCapture.append(options.stdoutPath, rawStdout);
  logCapture.append(options.stderrPath, rawStderr);
  logCapture.flush(exactRedactionValues);

  return {
    exitCode: result.status,
    stdout: stdout.length > maxStdout ? stdout.slice(0, maxStdout) : stdout,
    stderr: stderr.length > maxStderr ? stderr.slice(0, maxStderr) : stderr,
    // If timed out, don't report spawnError — it's a timeout, not a spawn failure
    spawnError: timedOut ? null : (result.error ? result.error.message : null),
    timedOut,
    stdoutTruncated: rawStdout.length > maxStdout || stdout.length > maxStdout,
    stderrTruncated: rawStderr.length > maxStderr || stderr.length > maxStderr,
  };
}

export async function runSimpleProcess(options: SimpleProcessOptions): Promise<SimpleProcessResult> {
  const maxStdout = options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT;
  const maxStderr = options.maxStderrBytes ?? DEFAULT_MAX_STDERR;
  const exactRedactionValues = allowedEnvironmentValues(options.environmentVariableNames);
  const logCapture = new SecureProcessLogCapture(
    [options.stdoutPath, options.stderrPath],
    options.maxLogBytes,
  );

  let child: ChildProcess;
  try {
    const env = buildChildEnvironment({
      cwd: options.cwd,
      allowedNames: options.environmentVariableNames,
      blockedNames: options.blockedEnvironmentVariableNames,
    });
    const prepared = prepareShellFreeCommand(options.command, options.args, options.cwd, { pathValue: env.PATH });
    const command = resolveTrustedExecutable(prepared.command, options.cwd, { pathValue: env.PATH });
    child = spawn(command, prepared.args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
      env,
    });
  } catch (error) {
    return {
      exitCode: null,
      stdout: "",
      stderr: "",
      spawnError: error instanceof Error ? error.message : String(error),
      timedOut: false,
      stdoutTruncated: false,
      stderrTruncated: false,
    };
  }

  let stdoutBuf = Buffer.alloc(0);
  let stderrBuf = Buffer.alloc(0);
  let stdoutTruncated = false;
  let stderrTruncated = false;
  let spawnError: string | null = null;
  let timedOut = false;
  let forceTimer: ReturnType<typeof setTimeout> | null = null;
  let terminationStarted = false;

  const requestTermination = (reason: "timeout" | "force", force: boolean) => {
    if (terminationStarted) return;
    terminationStarted = true;
    if (reason === "timeout") timedOut = true;
    if (force) {
      forceKill(child);
    } else {
      gracefulKill(child);
      forceTimer = setTimeout(() => forceKill(child), GRACEFUL_KILL_MS);
    }
  };

  child.stdout?.on("data", (chunk: Buffer) => {
    logCapture.append(options.stdoutPath, chunk);
    if (stdoutBuf.length < maxStdout) {
      const remaining = maxStdout - stdoutBuf.length;
      if (chunk.length <= remaining) {
        stdoutBuf = Buffer.concat([stdoutBuf, chunk]);
      } else {
        stdoutBuf = Buffer.concat([stdoutBuf, chunk.slice(0, remaining)]);
        stdoutTruncated = true;
      }
    } else {
      stdoutTruncated = true;
    }
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    logCapture.append(options.stderrPath, chunk);
    if (stderrBuf.length < maxStderr) {
      const remaining = maxStderr - stderrBuf.length;
      if (chunk.length <= remaining) {
        stderrBuf = Buffer.concat([stderrBuf, chunk]);
      } else {
        stderrBuf = Buffer.concat([stderrBuf, chunk.slice(0, remaining)]);
        stderrTruncated = true;
      }
    } else {
      stderrTruncated = true;
    }
  });

  const timeoutTimer = setTimeout(() => requestTermination("timeout", true), options.timeoutMs);

  const exitCode = await new Promise<number | null>((resolveExit) => {
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      resolveExit(code);
    };
    child.once("close", (code) => finish(code));
    child.once("error", (error) => {
      spawnError = error.message;
      finish(null);
    });
  });

  clearTimeout(timeoutTimer);
  if (forceTimer) clearTimeout(forceTimer);
  logCapture.flush(exactRedactionValues);
  const stdout = redactProcessOutput(stdoutBuf.toString("utf-8"), exactRedactionValues);
  const stderr = redactProcessOutput(stderrBuf.toString("utf-8"), exactRedactionValues);

  return {
    exitCode,
    stdout: stdout.length > maxStdout ? stdout.slice(0, maxStdout) : stdout,
    stderr: stderr.length > maxStderr ? stderr.slice(0, maxStderr) : stderr,
    spawnError,
    timedOut,
    stdoutTruncated: stdoutTruncated || stdout.length > maxStdout,
    stderrTruncated: stderrTruncated || stderr.length > maxStderr,
  };
}

function gracefulKill(child: ChildProcess): void {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch {} // cleanup failure is safe to ignore
}

function forceKill(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") {
      const systemRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
      const taskkill = resolveTrustedExecutable(`${systemRoot}\\System32\\taskkill.exe`, process.cwd());
      const result = spawnSync(taskkill, ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        timeout: 5000,
        windowsHide: true,
        env: buildChildEnvironment({ cwd: process.cwd() }),
      });
      if (result.status !== 0) child.kill("SIGKILL");
    } else {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    try { child.kill("SIGKILL"); } catch {} // cleanup failure is safe to ignore
  }
}

function errorCode(error: unknown): string | null {
  return error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code || "")
    : null;
}
