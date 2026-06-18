import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { getTasksDir, getConfig } from "../config.js";
import { guardReadPath } from "../security/pathGuard.js";
import { guardSensitivePath } from "../security/sensitiveGuard.js";
import type { TaskStatus } from "./createTask.js";

export interface GetTaskStatusOutput {
  task_id: string;
  plan_id: string;
  agent: string;
  status: TaskStatus;
  created_at: string;
  updated_at: string;
  error: string | null;
}

export function getTaskStatus(taskId: string): GetTaskStatusOutput {
  const config = getConfig();
  const tasksDir = getTasksDir(config);

  const taskDir = resolve(tasksDir, taskId);
  const statusFile = join(taskDir, "status.json");

  guardReadPath(statusFile, config.workspaceRoot, config.tasksDir);
  guardSensitivePath(statusFile);

  if (!existsSync(statusFile)) {
    throw new Error(`Task not found: "${taskId}". Check the task ID or create a task first.`);
  }

  const raw = readFileSync(statusFile, "utf-8");
  return JSON.parse(raw) as GetTaskStatusOutput;
}
