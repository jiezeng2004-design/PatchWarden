import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getConfig, getTasksDir, type PatchWardenConfig } from "../../config.js";
import { isWatcherOwningTask } from "../../watcherStatus.js";
import { mutateTaskStatus } from "../../runner/taskStatusStore.js";
import { atomicWriteFileSync, atomicWriteJsonFileSync } from "../../utils/atomicFile.js";
import { appendBoundedTextFileSync } from "../../utils/boundedFile.js";
import { isTerminalTaskStatus } from "./taskStates.js";

export type TaskHistoryState = "active" | "archived";

export interface TaskHistoryMutationOutput {
  archived: string[];
  restored: string[];
  unchanged: string[];
  rejected: Array<{ task_id: string; reason: string }>;
  manifest_path: string | null;
}

const MAX_BATCH_SIZE = 100;
const HISTORY_LOG_NAME = "history-recovery.log";

export function readTaskHistoryState(status: Record<string, unknown>): TaskHistoryState {
  if (status.history_state === "active" || status.history_state === "archived") {
    return status.history_state;
  }
  return status.reconcile_state === "archived" ? "archived" : "active";
}

export function archiveTasks(
  taskIds: readonly string[],
  config: PatchWardenConfig = getConfig(),
): TaskHistoryMutationOutput {
  const ids = normalizeTaskIds(taskIds);
  const output = emptyMutationOutput();
  const changedAt = new Date().toISOString();
  for (const taskId of ids) {
    const taskDir = resolve(getTasksDir(config), taskId);
    const statusFile = join(taskDir, "status.json");
    if (!existsSync(statusFile)) {
      output.rejected.push({ task_id: taskId, reason: "task_not_found" });
      continue;
    }
    if (isWatcherOwningTask(taskDir, config).owned) {
      output.rejected.push({ task_id: taskId, reason: "active_watcher_ownership" });
      continue;
    }
    try {
      const result = mutateTaskStatus<{ changed: boolean; reason?: string }>(statusFile, (current) => {
        if (readTaskHistoryState(current) === "archived") {
          return { result: { changed: false, reason: "already_archived" } };
        }
        if (!isTerminalTaskStatus(String(current.status || ""))) {
          return { result: { changed: false, reason: "task_not_terminal" } };
        }
        if (isWatcherOwningTask(taskDir, config).owned) {
          return { result: { changed: false, reason: "active_watcher_ownership" } };
        }
        backUpStatus(statusFile, taskDir, "archive", changedAt);
        const next = {
          ...current,
          history_state: "archived",
          archived_at: changedAt,
          archived_by: "control_center",
          updated_at: changedAt,
        };
        return { next, result: { changed: true } };
      });
      if (!result.changed) {
        if (result.reason === "already_archived") output.unchanged.push(taskId);
        else output.rejected.push({ task_id: taskId, reason: result.reason || "archive_rejected" });
        continue;
      }
      output.archived.push(taskId);
      atomicWriteJsonFileSync(join(taskDir, "history.json"), {
        task_id: taskId,
        history_state: "archived",
        changed_at: changedAt,
        changed_by: "control_center",
        destructive: false,
      });
    } catch (error) {
      output.rejected.push({
        task_id: taskId,
        reason: error instanceof Error ? error.message : "archive_failed",
      });
    }
  }
  output.manifest_path = writeHistoryManifest(config, "archive", changedAt, output);
  return output;
}

export function restoreTask(
  taskId: string,
  config: PatchWardenConfig = getConfig(),
): TaskHistoryMutationOutput {
  const [id] = normalizeTaskIds([taskId]);
  const output = emptyMutationOutput();
  const changedAt = new Date().toISOString();
  const taskDir = resolve(getTasksDir(config), id);
  const statusFile = join(taskDir, "status.json");
  if (!existsSync(statusFile)) {
    output.rejected.push({ task_id: id, reason: "task_not_found" });
    return output;
  }
  try {
    const result = mutateTaskStatus<{ changed: boolean; reason?: string }>(statusFile, (current) => {
      if (readTaskHistoryState(current) !== "archived") {
        return { result: { changed: false, reason: "not_archived" } };
      }
      backUpStatus(statusFile, taskDir, "restore", changedAt);
      const next = {
        ...current,
        history_state: "active",
        reconcile_state: current.reconcile_state === "archived" ? "restored" : current.reconcile_state,
        restored_at: changedAt,
        restored_by: "control_center",
        updated_at: changedAt,
      };
      return { next, result: { changed: true } };
    });
    if (result.changed) {
      output.restored.push(id);
      atomicWriteJsonFileSync(join(taskDir, "history.json"), {
        task_id: id,
        history_state: "active",
        changed_at: changedAt,
        changed_by: "control_center",
        destructive: false,
      });
    } else {
      output.unchanged.push(id);
    }
  } catch (error) {
    output.rejected.push({
      task_id: id,
      reason: error instanceof Error ? error.message : "restore_failed",
    });
  }
  output.manifest_path = writeHistoryManifest(config, "restore", changedAt, output);
  return output;
}

function normalizeTaskIds(taskIds: readonly string[]): string[] {
  if (!Array.isArray(taskIds) || taskIds.length === 0 || taskIds.length > MAX_BATCH_SIZE) {
    throw new Error(`task_ids must contain between 1 and ${MAX_BATCH_SIZE} entries.`);
  }
  const ids = [...new Set(taskIds.map((value) => String(value || "")))];
  if (ids.some((taskId) => !/^task[-_]/u.test(taskId) || !isValidTaskIdSegment(taskId))) {
    throw new Error("task_ids contains an invalid task id.");
  }
  return ids;
}

export function isValidTaskIdSegment(taskId: string): boolean {
  return /^[\p{L}\p{N}]/u.test(taskId)
    && taskId.length <= 240
    && !taskId.includes("..")
    && !/[\\/:*?"<>|\u0000-\u001f]/u.test(taskId)
    && !/[. ]$/u.test(taskId);
}

function backUpStatus(statusFile: string, taskDir: string, action: string, changedAt: string): void {
  const primaryBackup = join(taskDir, "status.json.bak");
  const content = readFileSync(statusFile, "utf-8");
  if (!existsSync(primaryBackup)) {
    atomicWriteFileSync(primaryBackup, content);
    return;
  }
  const timestamp = changedAt.replace(/[^0-9]/g, "").slice(0, 14);
  let suffix = 0;
  let backupPath = join(taskDir, `status.json.${action}.${timestamp}.bak`);
  while (existsSync(backupPath)) {
    suffix += 1;
    backupPath = join(taskDir, `status.json.${action}.${timestamp}.${suffix}.bak`);
  }
  atomicWriteFileSync(backupPath, content);
}

function emptyMutationOutput(): TaskHistoryMutationOutput {
  return { archived: [], restored: [], unchanged: [], rejected: [], manifest_path: null };
}

function writeHistoryManifest(
  config: PatchWardenConfig,
  action: "archive" | "restore",
  changedAt: string,
  output: TaskHistoryMutationOutput,
): string | null {
  if (output.archived.length + output.restored.length === 0) return null;
  const root = dirname(getTasksDir(config));
  const manifestDir = join(root, "history-manifests");
  mkdirSync(manifestDir, { recursive: true });
  const timestamp = changedAt.replace(/[^0-9]/g, "").slice(0, 14);
  let suffix = 0;
  let manifestPath = join(manifestDir, `${action}-${timestamp}.json`);
  while (existsSync(manifestPath)) {
    suffix += 1;
    manifestPath = join(manifestDir, `${action}-${timestamp}-${suffix}.json`);
  }
  const record = {
    action,
    changed_at: changedAt,
    archived: output.archived,
    restored: output.restored,
    unchanged: output.unchanged,
    rejected: output.rejected,
    destructive: false,
  };
  atomicWriteJsonFileSync(manifestPath, record);
  try {
    appendBoundedTextFileSync(join(root, HISTORY_LOG_NAME), `${JSON.stringify(record)}\n`);
  } catch {
    // Per-task status and manifest remain the authoritative audit evidence.
  }
  return manifestPath;
}
