#!/usr/bin/env node
/**
 * PatchWarden Watcher
 *
 * Polls .patchwarden/tasks/ for pending tasks and executes them automatically.
 * This is the recommended way to run tasks — ChatGPT creates tasks,
 * the watcher picks them up and runs them locally.
 *
 * Safety invariants (enforced every tick):
 *  - repo_path must be inside workspace
 *  - agent must be in allowlist
 *  - test_command must be in allowlist (or empty)
 *  - Each task runs at most once (no retry loop)
 *  - No auto commit, no auto push, no file deletion
 *
 * Run: node dist/runner/watch.js
 *   or: npm run watch
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve, join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig, getConfig, getTasksDir, resolveWorkspaceRoot } from "../config.js";
import { guardWorkspacePath } from "../security/pathGuard.js";
import { guardAgentCommand, guardTestCommand } from "../security/commandGuard.js";
import { validateAssessmentFreshness } from "../assessments/assessmentStore.js";
import { captureRepoSnapshot } from "./changeCapture.js";
import { mutateTaskStatus } from "./taskStatusStore.js";
import { logger } from "../logging.js";
import { redactSensitiveContent } from "../security/contentRedaction.js";
import { atomicWriteFileSync } from "../utils/atomicFile.js";
//  Note: `runTask` is imported lazily inside `tick()` via `await import("./runTask.js")`.
//  This keeps `import { acquireWatcherLock }` side-effect-free for unit tests and
//  avoids eagerly pulling in the full tools/dispatch graph at module load.

// ── Bootstrap ─────────────────────────────────────────────────────

loadConfig();
const config = getConfig();
const tasksDir = getTasksDir(config);
const wsRoot = resolveWorkspaceRoot(config);

const POLL_INTERVAL_MS = 4000;
const WATCHER_HEARTBEAT_FILE = join(dirname(tasksDir), "watcher-heartbeat.json");
const WATCHER_LOCK_FILE = join(dirname(tasksDir), "watcher.lock");
const WATCHER_STARTED_AT = new Date().toISOString();
const WATCHER_INSTANCE_ID = process.env.PATCHWARDEN_WATCHER_INSTANCE_ID || `standalone-${process.pid}-${Date.now()}`;
const WATCHER_LAUNCHER_PID = Number.isInteger(Number(process.env.PATCHWARDEN_WATCHER_LAUNCHER_PID))
  ? Number(process.env.PATCHWARDEN_WATCHER_LAUNCHER_PID)
  : null;
// Track executed tasks to prevent re-execution
const executedTasks = new Set<string>();
let consecutiveTickFailures = 0;

// ── Single-instance lock ─────────────────────────────────────────
//  watch.ts is a long-running poller; without a lock, two watchers started
//  against the same workspace would race on the same pending tasks. The lock
//  is best-effort: it detects a live PID via process.kill(pid, 0) and refuses
//  to start when one is found. A dead PID (crashed watcher) is taken over.

export class WatcherAlreadyRunningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WatcherAlreadyRunningError";
  }
}

type WatcherLockFile = {
  pid?: number;
  instance_id?: string;
  started_at?: string;
  launcher_pid?: number | null;
};

function errorCode(error: unknown): string | null {
  return error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code || "")
    : null;
}

function readWatcherLock(lockFilePath: string): WatcherLockFile | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(lockFilePath, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as WatcherLockFile
      : null;
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but the current user cannot signal it.
    return errorCode(error) === "EPERM";
  }
}

function runningWatcherError(lockData: WatcherLockFile | null): WatcherAlreadyRunningError {
  return new WatcherAlreadyRunningError(
    `[watcher] Already running (pid=${lockData?.pid ?? "unknown"}, instance=${lockData?.instance_id ?? "unknown"}). Exiting.`,
  );
}

function createWatcherLockExclusive(lockFilePath: string, content: string): void {
  const descriptor = openSync(lockFilePath, "wx", 0o600);
  let writeError: unknown = null;
  try {
    writeFileSync(descriptor, content, "utf-8");
  } catch (error) {
    writeError = error;
  } finally {
    closeSync(descriptor);
  }
  if (writeError) {
    try { unlinkSync(lockFilePath); } catch { /* best effort after a partial write */ }
    throw writeError;
  }
}

/**
 * Acquire the watcher lock at `lockFilePath`. If a lock file exists and its
 * recorded PID is still alive (per `process.kill(pid, 0)`), throws
 * {@link WatcherAlreadyRunningError}. Otherwise overwrites the lock atomically.
 *
 * Exported for unit testing; `lockFilePath` defaults to the module-level
 * {@link WATCHER_LOCK_FILE} but tests pass a temp path.
 */
export function acquireWatcherLock(lockFilePath: string = WATCHER_LOCK_FILE): void {
  const lockContent = JSON.stringify({
    pid: process.pid,
    instance_id: WATCHER_INSTANCE_ID,
    started_at: WATCHER_STARTED_AT,
    launcher_pid: WATCHER_LAUNCHER_PID,
  }, null, 2);
  try {
    createWatcherLockExclusive(lockFilePath, lockContent);
    return;
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }

  const existing = readWatcherLock(lockFilePath);
  if (typeof existing?.pid === "number" && processIsAlive(existing.pid)) {
    throw runningWatcherError(existing);
  }

  try {
    unlinkSync(lockFilePath);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }

  try {
    createWatcherLockExclusive(lockFilePath, lockContent);
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      throw runningWatcherError(readWatcherLock(lockFilePath));
    }
    throw error;
  }
}

export function releaseWatcherLock(
  lockFilePath: string = WATCHER_LOCK_FILE,
  instanceId: string = WATCHER_INSTANCE_ID,
  pid: number = process.pid,
): boolean {
  const existing = readWatcherLock(lockFilePath);
  if (existing?.pid !== pid || existing.instance_id !== instanceId) return false;
  try {
    unlinkSync(lockFilePath);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

export function createNonOverlappingRunner(
  operation: () => Promise<void>,
  onSkipped: () => void = () => undefined,
): () => Promise<boolean> {
  let running = false;
  return async () => {
    if (running) {
      onSkipped();
      return false;
    }
    running = true;
    try {
      await operation();
      return true;
    } finally {
      running = false;
    }
  };
}

// ── Main loop ─────────────────────────────────────────────────────

async function tick() {
  try {
    writeWatcherHeartbeat("running");
    // Ensure tasks directory exists
    if (!existsSync(tasksDir)) {
      consecutiveTickFailures = 0;
      writeWatcherHeartbeat("running");
      return;
    }

    const entries = readdirSync(tasksDir, { withFileTypes: true });
    const taskDirs = entries.filter((e) => e.isDirectory());

    for (const entry of taskDirs) {
      const taskId = entry.name;

      // Skip already-executed tasks
      if (executedTasks.has(taskId)) continue;

      const taskDir = resolve(tasksDir, taskId);
      const statusFile = join(taskDir, "status.json");

      if (!existsSync(statusFile)) continue;

      let statusData: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(readFileSync(statusFile, "utf-8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("status.json must contain an object");
        }
        statusData = parsed as Record<string, unknown>;
      } catch (error) {
        logger.warn("[watcher] Skipping unreadable task status", {
          task_id: taskId,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      if (statusData.status !== "pending") continue;

      // ── Pre-flight safety checks ──
      try {
        // Check repo_path
        const repoPath = typeof statusData.resolved_repo_path === "string"
          ? statusData.resolved_repo_path
          : typeof statusData.repo_path === "string"
            ? statusData.repo_path
            : wsRoot;
        const resolvedRepoPath = guardWorkspacePath(repoPath, wsRoot);

        // Check agent
        guardAgentCommand(typeof statusData.agent === "string" ? statusData.agent : "", config);

        // Check test_command
        if (typeof statusData.test_command === "string" && statusData.test_command) {
          guardTestCommand(statusData.test_command, config, resolvedRepoPath);
        }
        if (Array.isArray(statusData.verify_commands)) {
          for (const command of statusData.verify_commands) {
            guardTestCommand(String(command), config, resolvedRepoPath);
          }
        }

        // Assessment freshness revalidation
        if (typeof statusData.assessment_id === "string" && statusData.assessment_id) {
          const preExecSnapshot = await captureRepoSnapshot(resolvedRepoPath);
          const validation = validateAssessmentFreshness(statusData.assessment_id, preExecSnapshot);
          if (!validation.valid) {
            throw new Error(`assessment validation failed: ${validation.failure_reason}`);
          }
        }
      } catch (err) {
        const errMsg = redactSensitiveContent(
          `[watcher] Safety check failed for ${taskId}: ${err instanceof Error ? err.message : String(err)}`,
        ).content;
        logger.error(errMsg);

        // Write error and mark as failed so it doesn't get re-picked
        try {
          atomicWriteFileSync(join(taskDir, "error.log"), errMsg);
          mutateTaskStatus(statusFile, (current) => {
            if (current.status !== "pending") return { result: undefined };
            const next = {
              ...current,
              status: "failed",
              error: errMsg,
              updated_at: new Date().toISOString(),
            };
            return { next, result: undefined };
          });
        } catch (err) {
          logger.warn("watcher error-log write failed", { error: err instanceof Error ? err.message : String(err) });
        }
        executedTasks.add(taskId);
        continue;
      }

      // ── Execute ──
      logger.info(`[watcher] Executing: ${taskId}`);
      executedTasks.add(taskId);

      try {
        const { runTask } = await import("./runTask.js");
        const result = await runTask(taskId);
        logger.info(`[watcher] ${taskId} → ${result.status}`);
      } catch (err) {
        logger.error(`[watcher] ${taskId} → error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    consecutiveTickFailures = 0;
    writeWatcherHeartbeat("running");
  } catch (err) {
    consecutiveTickFailures += 1;
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`[watcher] Tick error (${consecutiveTickFailures} consecutive): ${message}`);
    try {
      writeWatcherHeartbeat(consecutiveTickFailures >= 3 ? "degraded" : "running", message);
    } catch (heartbeatError) {
      logger.error("[watcher] Failed to persist degraded heartbeat", {
        error: heartbeatError instanceof Error ? heartbeatError.message : String(heartbeatError),
      });
    }
  }
}

function writeWatcherHeartbeat(status: "running" | "degraded", lastError?: string): void {
  atomicWriteFileSync(WATCHER_HEARTBEAT_FILE, JSON.stringify({
    status,
    pid: process.pid,
    started_at: WATCHER_STARTED_AT,
    last_heartbeat_at: new Date().toISOString(),
    instance_id: WATCHER_INSTANCE_ID,
    launcher_pid: WATCHER_LAUNCHER_PID,
    consecutive_failures: consecutiveTickFailures,
    last_error: lastError ? lastError.slice(0, 500) : null,
  }, null, 2));
}

// ── Start (only when executed as a script) ─────────────────────────
//  The bootstrap below has process-wide side effects (mkdir, signal handlers,
//  polling interval, lock acquisition). Guarding it with a main-module check
//  keeps `import { acquireWatcherLock }` safe for unit tests — without it,
//  importing this module would start polling the real tasks dir and register
//  SIGINT/SIGTERM handlers that interfere with the test runner.

const isMainModule = !!process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMainModule) {
  mkdirSync(dirname(WATCHER_HEARTBEAT_FILE), { recursive: true });

  logger.info(`[watcher] Workspace: ${wsRoot}`);
  logger.info(`[watcher] Tasks:    ${tasksDir}`);
  logger.info(`[watcher] Polling every ${POLL_INTERVAL_MS / 1000}s`);
  logger.info(`[watcher] Press Ctrl+C to stop`);

  try {
    acquireWatcherLock(WATCHER_LOCK_FILE);
  } catch (err) {
    if (err instanceof WatcherAlreadyRunningError) {
      logger.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  logger.info("[watcher] Started");
  const scheduledTick = createNonOverlappingRunner(tick, () => {
    logger.warn("[watcher] Previous tick is still running; skipping overlapping poll");
  });
  setInterval(() => { void scheduledTick(); }, POLL_INTERVAL_MS);

  // Run first tick immediately
  void scheduledTick();

  // Graceful shutdown
  function shutdown(): void {
    logger.info("[watcher] Stopped");
    try { releaseWatcherLock(WATCHER_LOCK_FILE); } catch (error) {
      logger.warn("[watcher] Failed to release watcher lock", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    process.exit(0);
  }
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
