#!/usr/bin/env node
/**
 * Safe-Bifrost Runner CLI
 *
 * Usage:
 *   node dist/runner/cli.js <task_id>
 *   npm run runner -- <task_id>
 */

import { runTask } from "./runTask.js";
import { loadConfig } from "../config.js";

// Load config early
loadConfig();

const taskId = process.argv[2] || process.env.SAFE_BIFROST_TASK_ID;

if (!taskId) {
  console.error("Usage: node dist/runner/cli.js <task_id>");
  console.error("   or: npm run runner -- <task_id>");
  process.exit(1);
}

console.error(`[runner] Starting task: ${taskId}`);

const result = await runTask(taskId);

console.error(`[runner] Task ${result.task_id}: ${result.status}`);
if (result.error) {
  console.error(`[runner] Error: ${result.error}`);
  process.exit(1);
}

console.error("[runner] Done.");
