import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getTasksDir, getConfig } from "../config.js";
import { guardReadPath } from "../security/pathGuard.js";
import { createTask } from "./createTask.js";

export function retryTask(taskId: string) {
  const config = getConfig();
  const tasksDir = getTasksDir(config);
  const taskDir = join(tasksDir, taskId);
  const statusFile = join(taskDir, "status.json");

  guardReadPath(statusFile, config.workspaceRoot, config.tasksDir);

  if (!existsSync(statusFile)) {
    throw new Error(`Task not found: "${taskId}"`);
  }

  const data = JSON.parse(readFileSync(statusFile, "utf-8"));

  if (!data.plan_id || !data.agent) {
    throw new Error(`Task "${taskId}" is missing plan_id or agent. Cannot retry.`);
  }

  // Create a new task with the same parameters
  const newTask = createTask({
    plan_id: data.plan_id,
    agent: data.agent,
    repo_path: data.repo_path,
    test_command: data.test_command,
    verify_commands: data.verify_commands,
    timeout_seconds: data.timeout_seconds,
  });

  // Record retry relationship in the new task
  const newStatusFile = join(newTask.path, "status.json");
  const newData = JSON.parse(readFileSync(newStatusFile, "utf-8"));
  newData.retry_of = taskId;
  newData.retry_count = (data.retry_count || 0) + 1;
  writeFileSync(newStatusFile, JSON.stringify(newData, null, 2), "utf-8");

  return {
    original_task_id: taskId,
    new_task_id: newTask.task_id,
    plan_id: newTask.plan_id,
    agent: newTask.agent,
    status: newTask.status,
    message: `New task created from retry of ${taskId}. Original task is unchanged.`,
  };
}
