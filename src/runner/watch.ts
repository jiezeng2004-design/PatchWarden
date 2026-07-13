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

import { readdirSync, readFileSync, existsSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { loadConfig, getConfig, getTasksDir, resolveWorkspaceRoot } from "../config.js";
import { guardWorkspacePath } from "../security/pathGuard.js";
import { guardAgentCommand, guardTestCommand } from "../security/commandGuard.js";
import { validateAssessmentFreshness } from "../assessments/assessmentStore.js";
import { captureRepoSnapshot } from "./changeCapture.js";
import { runTask } from "./runTask.js";
import { logger } from "../logging.js";

// ── Bootstrap ─────────────────────────────────────────────────────

loadConfig();
const config = getConfig();
const tasksDir = getTasksDir(config);
const wsRoot = resolveWorkspaceRoot(config);

const POLL_INTERVAL_MS = 4000;
const WATCHER_HEARTBEAT_FILE = join(dirname(tasksDir), "watcher-heartbeat.json");
const WATCHER_STARTED_AT = new Date().toISOString();
const WATCHER_INSTANCE_ID = process.env.PATCHWARDEN_WATCHER_INSTANCE_ID || `standalone-${process.pid}-${Date.now()}`;
const WATCHER_LAUNCHER_PID = Number.isInteger(Number(process.env.PATCHWARDEN_WATCHER_LAUNCHER_PID))
  ? Number(process.env.PATCHWARDEN_WATCHER_LAUNCHER_PID)
  : null;
mkdirSync(dirname(WATCHER_HEARTBEAT_FILE), { recursive: true });

logger.info(`[watcher] Workspace: ${wsRoot}`);
logger.info(`[watcher] Tasks:    ${tasksDir}`);
logger.info(`[watcher] Polling every ${POLL_INTERVAL_MS / 1000}s`);
logger.info(`[watcher] Press Ctrl+C to stop`);

// Track executed tasks to prevent re-execution
const executedTasks = new Set<string>();

// ── Main loop ─────────────────────────────────────────────────────

async function tick() {
  try {
    const heartbeatTemporary = `${WATCHER_HEARTBEAT_FILE}.${WATCHER_INSTANCE_ID}.tmp`;
    writeFileSync(heartbeatTemporary, JSON.stringify({
      status: "running",
      pid: process.pid,
      started_at: WATCHER_STARTED_AT,
      last_heartbeat_at: new Date().toISOString(),
      instance_id: WATCHER_INSTANCE_ID,
      launcher_pid: WATCHER_LAUNCHER_PID,
    }, null, 2), "utf-8");
    renameSync(heartbeatTemporary, WATCHER_HEARTBEAT_FILE);
    // Ensure tasks directory exists
    if (!existsSync(tasksDir)) return;

    const entries = readdirSync(tasksDir, { withFileTypes: true });
    const taskDirs = entries.filter((e) => e.isDirectory());

    for (const entry of taskDirs) {
      const taskId = entry.name;

      // Skip already-executed tasks
      if (executedTasks.has(taskId)) continue;

      const taskDir = resolve(tasksDir, taskId);
      const statusFile = join(taskDir, "status.json");

      if (!existsSync(statusFile)) continue;

      let statusData: any;
      try {
        statusData = JSON.parse(readFileSync(statusFile, "utf-8"));
      } catch {
        continue; // corrupted status, skip
      }

      if (statusData.status !== "pending") continue;

      // ── Pre-flight safety checks ──
      try {
        // Check repo_path
        const resolvedRepoPath = guardWorkspacePath(statusData.resolved_repo_path || statusData.repo_path || wsRoot, wsRoot);

        // Check agent
        guardAgentCommand(statusData.agent, config);

        // Check test_command
        if (statusData.test_command) {
          guardTestCommand(statusData.test_command, config, resolvedRepoPath);
        }
        if (Array.isArray(statusData.verify_commands)) {
          for (const command of statusData.verify_commands) {
            guardTestCommand(String(command), config, resolvedRepoPath);
          }
        }

        // Assessment freshness revalidation
        if (statusData.assessment_id) {
          const preExecSnapshot = await captureRepoSnapshot(resolvedRepoPath);
          const validation = validateAssessmentFreshness(String(statusData.assessment_id), preExecSnapshot);
          if (!validation.valid) {
            throw new Error(`assessment validation failed: ${validation.failure_reason}`);
          }
        }
      } catch (err) {
        const errMsg = `[watcher] Safety check failed for ${taskId}: ${err instanceof Error ? err.message : String(err)}`;
        logger.error(errMsg);

        // Write error and mark as failed so it doesn't get re-picked
        try {
          writeFileSync(join(taskDir, "error.log"), errMsg, "utf-8");
          const data = JSON.parse(readFileSync(statusFile, "utf-8"));
          data.status = "failed";
          data.error = errMsg;
          data.updated_at = new Date().toISOString();
          writeFileSync(statusFile, JSON.stringify(data, null, 2), "utf-8");
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
        const result = await runTask(taskId);
        logger.info(`[watcher] ${taskId} → ${result.status}`);
      } catch (err) {
        logger.error(`[watcher] ${taskId} → error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    logger.error(`[watcher] Tick error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Start ─────────────────────────────────────────────────────────

logger.info("[watcher] Started");
setInterval(tick, POLL_INTERVAL_MS);

// Run first tick immediately
tick();

// Graceful shutdown
process.on("SIGINT", () => {
  logger.info("[watcher] Stopped");
  process.exit(0);
});
process.on("SIGTERM", () => {
  logger.info("[watcher] Stopped");
  process.exit(0);
});
