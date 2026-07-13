/**
 * Control Center routes — mutating task actions (POST /api/tasks/:id/*).
 *
 * These handlers are invoked only after the server router has validated the
 * control token. They cover reconcile, on-demand audit_task, opening the task
 * folder in the host file explorer, and hiding a stale task from the
 * dashboard. None of them delete task files; they annotate or launch external
 * viewers.
 */
import { existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { type ServerResponse } from "node:http";
import { type TaskEntry } from "../../tools/listTasks.js";
import type { AcceptanceStatus } from "../../tools/createTask.js";
import { auditTask } from "../../tools/auditTask.js";
import { getTasksDir } from "../../config.js";
import {
  classifyStaleTask,
  isValidTaskId,
  readHiddenStaleIds,
  readWatcherStatusSafe,
  recordEvent,
  TERMINAL_TASK_STATUSES,
  writeHiddenStaleIds,
} from "../runtime.js";
import { config, errorMessage, readJsonFileSafe, sendJson } from "../shared.js";

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
    const taskDir = join(tasksDir, taskId);
    if (!existsSync(taskDir) || !statSync(taskDir).isDirectory()) {
      sendJson(res, 404, { error: "Task not found" });
      return;
    }

    const statusPath = join(taskDir, "status.json");
    const runtimePath = join(taskDir, "runtime.json");
    const statusData = readJsonFileSafe<Record<string, unknown>>(statusPath) ?? {};
    const runtimeData = readJsonFileSafe<Record<string, unknown>>(runtimePath) ?? {};

    const watcher = readWatcherStatusSafe();
    const VALID_ACCEPTANCE = ["pending", "accepted", "rejected", "needs_fix", "blocked"];
    const taskStatus = String(statusData.status || "pending");
    const taskAcceptanceStatus = taskStatus === "done_by_agent"
      ? (typeof statusData.acceptance_status === "string" && VALID_ACCEPTANCE.includes(statusData.acceptance_status) ? (statusData.acceptance_status as AcceptanceStatus) : "pending" as AcceptanceStatus)
      : null;
    const taskEntry: TaskEntry = {
      task_id: taskId,
      plan_id: String(statusData.plan_id || ""),
      title: "",
      agent: String(statusData.agent || ""),
      status: taskStatus as TaskEntry["status"],
      phase: String(runtimeData.phase || statusData.phase || "queued") as TaskEntry["phase"],
      acceptance_status: taskAcceptanceStatus,
      created_at: String(statusData.created_at || ""),
      updated_at: String(statusData.updated_at || ""),
      workspace_root: String(statusData.workspace_root || config.workspaceRoot),
      repo_path: String(statusData.repo_path || "."),
      resolved_repo_path: String(statusData.resolved_repo_path || statusData.repo_path || config.workspaceRoot),
      test_command: String(statusData.test_command || ""),
      verify_commands: Array.isArray(statusData.verify_commands) ? (statusData.verify_commands as string[]) : [],
      error: statusData.error ? String(statusData.error) : null,
      last_heartbeat_at: String(runtimeData.last_heartbeat_at || statusData.last_heartbeat_at || statusData.updated_at || ""),
      current_command: runtimeData.current_command === undefined ? null : String(runtimeData.current_command || "") || null,
      timeout_seconds: Number(statusData.timeout_seconds) || config.defaultTaskTimeoutSeconds,
      pending_reason: null,
      watcher_status: watcher.status,
    };

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
      writeFileSync(join(taskDir, "reconcile.json"), JSON.stringify(reconcileRecord, null, 2), "utf-8");
    } catch (writeErr) {
      sendJson(res, 500, { error: `Failed to write reconcile record: ${errorMessage(writeErr)}` });
      return;
    }

    // Annotate status.json with reconcile metadata (do not mutate status enum).
    if (safe) {
      const annotated = {
        ...statusData,
        reconcile_state: decision === "marked_archived" ? "archived" : "stale",
        reconciled_at: reconciledAt,
      };
      try {
        writeFileSync(statusPath, JSON.stringify(annotated, null, 2), "utf-8");
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
    const taskDir = join(tasksDir, taskId);
    if (!existsSync(taskDir) || !statSync(taskDir).isDirectory()) {
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
    const taskDir = join(tasksDir, taskId);
    if (!existsSync(taskDir) || !statSync(taskDir).isDirectory()) {
      sendJson(res, 404, { error: "Task not found" });
      return;
    }
    let cmd: string;
    if (process.platform === "win32") {
      cmd = "explorer.exe";
    } else if (process.platform === "darwin") {
      cmd = "open";
    } else {
      cmd = "xdg-open";
    }
    try {
      const child = spawn(cmd, [taskDir], { detached: true, stdio: "ignore" });
      child.on("error", () => { /* ignore spawn errors */ });
      child.unref();
    } catch {
      /* ignore */
    }
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
