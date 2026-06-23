import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createWriteStream, writeFileSync, readFileSync, existsSync, type WriteStream } from "node:fs";

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

  let result;
  try {
    result = spawnSync(options.command, options.args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: options.timeoutMs,
      windowsHide: true,
      maxBuffer: maxStdout + 1024,
      encoding: "utf-8",
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

  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  const timedOut: boolean = Boolean(
    result.signal === "SIGTERM" || result.signal === "SIGKILL" ||
    (result.signal !== null && result.status === null) ||
    (result.error && (result.error as any).code === "ETIMEDOUT")
  );

  if (options.stdoutPath && stdout) {
    try { writeFileSyncAppend(options.stdoutPath, stdout); } catch {}
  }
  if (options.stderrPath && stderr) {
    try { writeFileSyncAppend(options.stderrPath, stderr); } catch {}
  }

  return {
    exitCode: result.status,
    stdout: stdout.length > maxStdout ? stdout.slice(0, maxStdout) : stdout,
    stderr: stderr.length > maxStderr ? stderr.slice(0, maxStderr) : stderr,
    // If timed out, don't report spawnError — it's a timeout, not a spawn failure
    spawnError: timedOut ? null : (result.error ? result.error.message : null),
    timedOut,
    stdoutTruncated: stdout.length > maxStdout,
    stderrTruncated: stderr.length > maxStderr,
  };
}

export async function runSimpleProcess(options: SimpleProcessOptions): Promise<SimpleProcessResult> {
  const maxStdout = options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT;
  const maxStderr = options.maxStderrBytes ?? DEFAULT_MAX_STDERR;
  const deadlineMs = Date.now() + options.timeoutMs;

  let child: ChildProcess;
  try {
    child = spawn(options.command, options.args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
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

  const stdoutStream = options.stdoutPath ? createWriteStream(options.stdoutPath, { flags: "a" }) : null;
  const stderrStream = options.stderrPath ? createWriteStream(options.stderrPath, { flags: "a" }) : null;

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
    stdoutStream?.write(chunk);
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
    stderrStream?.write(chunk);
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
    child.once("exit", (code) => finish(code));
    child.once("error", (error) => {
      spawnError = error.message;
      finish(null);
    });
  });

  clearTimeout(timeoutTimer);
  if (forceTimer) clearTimeout(forceTimer);
  stdoutStream?.destroy();
  stderrStream?.destroy();

  return {
    exitCode,
    stdout: stdoutBuf.toString("utf-8"),
    stderr: stderrBuf.toString("utf-8"),
    spawnError,
    timedOut,
    stdoutTruncated,
    stderrTruncated,
  };
}

function gracefulKill(child: ChildProcess): void {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch {}
}

function forceKill(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") {
      const result = spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        timeout: 5000,
        windowsHide: true,
      });
      if (result.status !== 0) child.kill("SIGKILL");
    } else {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    try { child.kill("SIGKILL"); } catch {}
  }
}

function writeFileSyncAppend(path: string, content: string): void {
  const existing = existsSync(path) ? readFileSync(path, "utf-8") : "";
  writeFileSync(path, existing + content, "utf-8");
}
