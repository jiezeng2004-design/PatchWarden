import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { getTasksDir, getConfig } from "../config.js";
import { guardReadPath } from "../security/pathGuard.js";
import type { TaskStatus } from "./listTasks.js";

export function cancelTask(taskId: string) {
  const config = getConfig();
  const tasksDir = getTasksDir(config);
  const taskDir = join(tasksDir, taskId);
  const statusFile = join(taskDir, "status.json");

  guardReadPath(statusFile, config.workspaceRoot, config.tasksDir);

  if (!existsSync(statusFile)) {
    throw new Error(`Task not found: "${taskId}"`);
  }

  const data = JSON.parse(readFileSync(statusFile, "utf-8"));
  const currentStatus: TaskStatus = data.status;

  if (currentStatus === "done" || currentStatus === "failed" || currentStatus === "canceled") {
    return {
      task_id: taskId,
      previous_status: currentStatus,
      new_status: currentStatus,
      message: `Task is already ${currentStatus}. No action taken.`,
    };
  }

  const now = new Date().toISOString();

  if (currentStatus === "pending") {
    data.status = "canceled";
    data.canceled_at = now;
    data.cancel_reason = "Canceled by user request.";
    data.updated_at = now;
    writeFileSync(statusFile, JSON.stringify(data, null, 2), "utf-8");

    return {
      task_id: taskId,
      previous_status: "pending",
      new_status: "canceled",
      message: "Pending task canceled. It will not be executed by watcher.",
    };
  }

  // running → try to kill child process
  const childPid = data.child_pid;
  let killed = false;
  let killError = "";
  if (childPid && typeof childPid === "number") {
    try {
      if (process.platform === "win32") {
        try {
          execSync(`taskkill /PID ${childPid} /T /F`, { stdio: "ignore", timeout: 5000 });
          killed = true;
        } catch (e) {
          killError = e instanceof Error ? e.message : String(e);
        }
      } else {
        // Unix: SIGTERM
        process.kill(childPid, "SIGTERM");
        killed = true;
      }
    } catch (e) {
      killError = e instanceof Error ? e.message : String(e);
    }
  }

  data.cancel_requested = true;
  data.cancel_requested_at = now;
  data.updated_at = now;
  if (killed) {
    data.status = "canceled";
    data.canceled_at = now;
    data.cancel_reason = "Terminated by user request.";
  }
  writeFileSync(statusFile, JSON.stringify(data, null, 2), "utf-8");

  return {
    task_id: taskId,
    previous_status: "running",
    new_status: killed ? "canceled" : "running",
    cancel_requested: true,
    child_terminated: killed,
    message: killed
      ? "Running task terminated and marked canceled."
      : "Cancel requested. Child PID not available or could not be killed. Task may still complete.",
  };
}
