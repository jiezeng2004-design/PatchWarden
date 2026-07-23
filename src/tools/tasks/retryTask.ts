import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getTasksDir, getConfig } from "../../config.js";
import { guardReadPath } from "../../security/pathGuard.js";
import { createTask } from "./createTask.js";
import type { ChangePolicy } from "../taskTemplates.js";

export async function retryTask(taskId: string) {
  const config = getConfig();
  const tasksDir = getTasksDir(config);
  const taskDir = join(tasksDir, taskId);
  const statusFile = join(taskDir, "status.json");

  guardReadPath(statusFile, config.workspaceRoot, config.tasksDir);

  if (!existsSync(statusFile)) {
    throw new Error(`Task not found: "${taskId}"`);
  }

  const parsed: unknown = JSON.parse(readFileSync(statusFile, "utf-8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Task "${taskId}" has an invalid status record.`);
  }
  const data = parsed as Record<string, unknown>;

  if (typeof data.plan_id !== "string" || !data.plan_id ||
      typeof data.agent !== "string" || !data.agent) {
    throw new Error(`Task "${taskId}" is missing plan_id or agent. Cannot retry.`);
  }

  const priorRetryCount = typeof data.retry_count === "number" &&
    Number.isSafeInteger(data.retry_count) && data.retry_count >= 0
    ? data.retry_count
    : 0;
  const planSource = data.plan_source === "inline" || data.plan_source === "template"
    ? data.plan_source
    : "saved";
  const changePolicy: ChangePolicy = data.change_policy === "no_changes"
    ? "no_changes"
    : "repo_scoped_changes";

  // Create a new task with the same parameters
  const newTask = await createTask({
    plan_id: data.plan_id,
    agent: data.agent,
    repo_path: typeof data.repo_path === "string" ? data.repo_path : undefined,
    test_command: typeof data.test_command === "string" ? data.test_command : undefined,
    verify_commands: Array.isArray(data.verify_commands)
      ? data.verify_commands.filter((value): value is string => typeof value === "string")
      : undefined,
    timeout_seconds: typeof data.timeout_seconds === "number" ? data.timeout_seconds : undefined,
    retry_metadata: {
      retry_of: taskId,
      retry_count: priorRetryCount + 1,
      plan_source: planSource,
      template: typeof data.template === "string" ? data.template : null,
      change_policy: changePolicy,
    },
  });

  return {
    original_task_id: taskId,
    new_task_id: newTask.task_id,
    plan_id: newTask.plan_id,
    agent: newTask.agent,
    status: newTask.status,
    message: `New task created from retry of ${taskId}. Original task is unchanged.`,
  };
}
