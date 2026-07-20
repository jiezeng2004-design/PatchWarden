/**
 * Control Center routes — mutating task actions (POST /api/tasks/:id/*).
 *
 * These handlers are invoked only after the server router has validated the
 * control token. They cover reconcile, on-demand audit_task, opening the task
 * folder in the host file explorer, and hiding a stale task from the
 * dashboard. None of them delete task files; they annotate or launch external
 * viewers.
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { type ServerResponse } from "node:http";
import { auditTask } from "../../tools/diagnostics/auditTask.js";
import { getTasksDir } from "../../config.js";
import {
  classifyStaleTask,
  isValidTaskId,
  readHiddenStaleIds,
  reconstructTaskEntry,
  readWatcherStatusSafe,
  recordEvent,
  TERMINAL_TASK_STATUSES,
  writeHiddenStaleIds,
} from "../runtime.js";
import { launchFileManager } from "../fileManager.js";
import { config, errorMessage, guardControlPath, readJsonFileSafe, sendJson } from "../shared.js";
import { atomicWriteJsonFileSync } from "../../utils/atomicFile.js";
import { mutateTaskStatus } from "../../runner/taskStatusStore.js";

/**
 * Reconcile a stale task. Does NOT delete the task. Reads the task files,
 * decides whether it is safe to mark the task as stale/archived, writes a
 * reconcile record, and (when safe) annotates status.json with reconcile
 * metadata. The task status enum is never changed — only metadata is added.
 */
export function handleReconcile(res: ServerResponse, taskId: string): void {
  try {
    if (!isValidTaskId(taskId)) {
      sendJson(res, 400, { error: "Invalid task id" });
      return;
    }
    const tasksDir = getTasksDir(config);
    const taskDir = guardControlPath(join(tasksDir, taskId), config.tasksDir);
    if (!taskDir || !existsSync(taskDir) || !statSync(taskDir).isDirectory()) {
      sendJson(res, 404, { error: "Task not found" });
      return;
    }

    const statusPath = join(taskDir, "status.json");
    const runtimePath = join(taskDir, "runtime.json");
    const statusData = readJsonFileSafe<Record<string, unknown>>(statusPath) ?? {};
    const runtimeData = readJsonFileSafe<Record<string, unknown>>(runtimePath) ?? {};

    const watcher = readWatcherStatusSafe();
    const taskEntry = reconstructTaskEntry(taskId, statusData, runtimeData, watcher);

    const cls = classifyStaleTask(taskEntry, watcher);
    const isTerminal = TERMINAL_TASK_STATUSES.has(taskEntry.status);

    // Safe to mark stale/archived when:
    //  - terminal status  -> archive (already finished)
    //  - stale AND watcher is not actively driving it (no current_command OR watcher not healthy)
    let decision: "marked_stale" | "marked_archived" | "no_action";
    let safe = false;
    if (isTerminal) {
      decision = "marked_archived";
      safe = true;
    } else if (
      cls.is_stale &&
      (taskEntry.current_command === null || taskEntry.current_command === "" || watcher.status !== "healthy")
    ) {
      decision = "marked_stale";
      safe = true;
    } else {
      decision = "no_action";
      safe = false;
    }

    const reconciledAt = new Date().toISOString();
    const reconcileRecord = {
      task_id: taskId,
      reconciled_at: reconciledAt,
      decision,
      safe,
      previous_status: taskEntry.status,
      previous_phase: taskEntry.phase,
      is_stale: cls.is_stale,
      stale_reasons: cls.stale_reasons,
      watcher_status: watcher.status,
      watcher_last_heartbeat_at: watcher.last_heartbeat_at,
      task_last_heartbeat_at: taskEntry.last_heartbeat_at || null,
      task_current_command: taskEntry.current_command,
      notes:
        decision === "no_action"
          ? "Task does not currently qualify for safe reconcile (still actively running or watcher is healthy)."
          : "Task annotated with reconcile metadata; original status preserved. No files were deleted.",
    };

    // Write the reconcile record artifact.
    try {
      atomicWriteJsonFileSync(join(taskDir, "reconcile.json"), reconcileRecord);
    } catch (writeErr) {
      sendJson(res, 500, { error: `Failed to write reconcile record: ${errorMessage(writeErr)}` });
      return;
    }

    // Annotate status.json with reconcile metadata (do not mutate status enum).
    if (safe) {
      const annotation = {
        reconcile_state: decision === "marked_archived" ? "archived" : "stale",
        reconciled_at: reconciledAt,
      };
      try {
        mutateTaskStatus(statusPath, (current) => {
          if (current.status !== taskEntry.status) {
            throw new Error("Task status changed while reconcile was being evaluated; retry.");
          }
          const next = { ...current, ...annotation, updated_at: new Date().toISOString() };
          return { next, result: next };
        });
      } catch (writeErr) {
        sendJson(res, 500, { error: `Failed to annotate status.json: ${errorMessage(writeErr)}` });
        return;
      }
    }

    recordEvent("task.reconciled", {
      task_id: taskId,
      decision,
      safe,
      previous_status: taskEntry.status,
      is_stale: cls.is_stale,
    });
    sendJson(res, 200, reconcileRecord);
  } catch (err) {
    sendJson(res, 500, { error: errorMessage(err) });
  }
}

/**
 * Run audit_task for a task. Only safe to delegate when the task directory
 * exists and the task is in a terminal state (auditing a running task mid-flight
 * would race with the watcher writing artifacts).
 */
export function handleTaskAudit(res: ServerResponse, taskId: string): void {
  try {
    if (!isValidTaskId(taskId)) {
      sendJson(res, 400, { error: "Invalid task id" });
      return;
    }
    const tasksDir = getTasksDir(config);
    const taskDir = guardControlPath(join(tasksDir, taskId), config.tasksDir);
    if (!taskDir || !existsSync(taskDir) || !statSync(taskDir).isDirectory()) {
      sendJson(res, 404, { error: "Task not found" });
      return;
    }
    const statusData = readJsonFileSafe<Record<string, unknown>>(join(taskDir, "status.json"));
    const taskStatus = statusData ? String(statusData.status || "") : "";
    if (!TERMINAL_TASK_STATUSES.has(taskStatus as string)) {
      sendJson(res, 409, {
        error: "Task is not in a terminal state; audit_task can only run safely after completion.",
        status: taskStatus || "unknown",
      });
      return;
    }
    const output = auditTask(taskId);
    recordEvent("task.audited", { task_id: taskId, previous_status: taskStatus });
    sendJson(res, 200, { ok: true, audit: output });
  } catch (err) {
    sendJson(res, 500, { error: errorMessage(err) });
  }
}

export function handleOpenTaskFolder(res: ServerResponse, taskId: string): void {
  try {
    if (!isValidTaskId(taskId)) {
      sendJson(res, 400, { error: "Invalid task id" });
      return;
    }
    const tasksDir = getTasksDir(config);
    const taskDir = guardControlPath(join(tasksDir, taskId), config.tasksDir);
    if (!taskDir || !existsSync(taskDir) || !statSync(taskDir).isDirectory()) {
      sendJson(res, 404, { error: "Task not found" });
      return;
    }
    launchFileManager(taskDir, tasksDir);
    sendJson(res, 200, { ok: true, path: taskDir });
  } catch (err) {
    sendJson(res, 500, { error: errorMessage(err) });
  }
}

/**
 * Hide a stale task from the dashboard's stale-task view. The task itself is
 * NOT deleted or modified — only the control-center's local hidden-stale-ids
 * state file is updated. Requires control token (enforced by the POST router).
 */
export function handleHideStale(res: ServerResponse, taskId: string): void {
  try {
    if (!isValidTaskId(taskId)) {
      sendJson(res, 400, { error: "Invalid task id" });
      return;
    }
    const ids = readHiddenStaleIds();
    if (!ids.includes(taskId)) {
      ids.push(taskId);
      writeHiddenStaleIds(ids);
    }
    recordEvent("task.hide_stale", { task_id: taskId });
    sendJson(res, 200, { ok: true, hidden: taskId });
  } catch (err) {
    sendJson(res, 500, { error: errorMessage(err) });
  }
}
