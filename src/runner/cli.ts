#!/usr/bin/env node
/**
 * PatchWarden Runner CLI
 *
 * Usage:
 *   node dist/runner/cli.js <task_id>
 *   npm run runner -- <task_id>
 */

import { runTask } from "./runTask.js";
import { loadConfig } from "../config.js";
import { logger } from "../logging.js";

// Load config early
loadConfig();

const taskId = process.argv[2] || process.env.PATCHWARDEN_TASK_ID;

if (!taskId) {
  logger.info("Usage: node dist/runner/cli.js <task_id>");
  logger.info("   or: npm run runner -- <task_id>");
  process.exit(1);
}

logger.info(`[runner] Starting task: ${taskId}`);

const result = await runTask(taskId);

logger.info(`[runner] Task ${result.task_id}: ${result.status}`);
if (result.error) {
  logger.fatal(`[runner] Error: ${result.error}`);
  process.exit(1);
}

logger.info("[runner] Done.");
