import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { getConfig, getTasksDir, type PatchWardenConfig } from "../../config.js";
import { logger } from "../../logging.js";
import { isWatcherOwningTask } from "../../watcherStatus.js";
import { atomicWriteJsonFileSync } from "../../utils/atomicFile.js";
import { appendBoundedTextFileSync } from "../../utils/boundedFile.js";
import { withFileLockSync } from "../../utils/lockedJsonFile.js";
import { readTaskStatusFile } from "../../runner/taskStatusStore.js";
import { isTerminalTaskStatus } from "./taskStates.js";
import { isValidTaskIdSegment, readTaskHistoryState } from "./taskHistory.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const RECEIPT_LOG_MAX_BYTES = 1024 * 1024;
const RECEIPT_LIST_LIMIT = 100;

export interface ArchivedTaskCleanupCandidate {
  task_id: string;
  archived_at: string;
  age_source: "archived_at" | "updated_at" | "status_modified_time";
  bytes: number;
}

export interface ArchivedTaskCleanupReceipt {
  schema_version: "1";
  ok: boolean;
  started_at: string;
  completed_at: string | null;
  retention_days: number;
  cutoff: string;
  max_batch: number;
  scanned: number;
  candidate_count: number;
  deferred_count: number;
  candidate_bytes: number;
  deleted_count: number;
  deleted_bytes: number;
  candidates: ArchivedTaskCleanupCandidate[];
  deleted: ArchivedTaskCleanupCandidate[];
  skipped: Array<{ task_id: string; reason: string }>;
  errors: Array<{ task_id: string | null; reason: string }>;
  receipt_path: string;
}

export interface PruneArchivedTasksOptions {
  config?: PatchWardenConfig;
  now?: Date | string | number;
  retentionDays?: number;
  maxBatch?: number;
  removePath?: (path: string) => void;
}

export interface ArchivedTaskCleanupScheduler {
  runNow: () => ArchivedTaskCleanupReceipt | null;
  stop: () => void;
}

export interface ArchivedTaskCleanupSchedulerOptions {
  config?: PatchWardenConfig;
  intervalMs?: number;
  runCleanup?: () => ArchivedTaskCleanupReceipt;
}

export function pruneArchivedTasks(options: PruneArchivedTasksOptions = {}): ArchivedTaskCleanupReceipt {
  const config = options.config || getConfig();
  const retentionDays = positiveInteger(options.retentionDays ?? config.taskArchiveRetentionDays ?? 30, "retentionDays");
  const maxBatch = boundedBatch(options.maxBatch ?? config.taskArchiveCleanupMaxBatch ?? 100);
  const now = validDate(options.now ?? new Date());
  const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);
  const tasksRoot = resolve(getTasksDir(config));
  const workspaceRoot = resolve(config.workspaceRoot);
  const receiptRoot = resolve(dirname(tasksRoot), "history-cleanup");
  const receiptPath = join(receiptRoot, "latest.json");
  const receiptLogPath = join(receiptRoot, "history-cleanup.log");
  const receipt: ArchivedTaskCleanupReceipt = {
    schema_version: "1",
    ok: true,
    started_at: now.toISOString(),
    completed_at: null,
    retention_days: retentionDays,
    cutoff: cutoff.toISOString(),
    max_batch: maxBatch,
    scanned: 0,
    candidate_count: 0,
    deferred_count: 0,
    candidate_bytes: 0,
    deleted_count: 0,
    deleted_bytes: 0,
    candidates: [],
    deleted: [],
    skipped: [],
    errors: [],
    receipt_path: relative(workspaceRoot, receiptPath).replace(/\\/g, "/"),
  };

  // Validate every existing ancestor before mkdirSync can follow a junction
  // outside the workspace.  In particular, `.patchwarden` may exist while
  // `tasks` and `history-cleanup` do not.
  assertCleanupRoots(workspaceRoot, tasksRoot, receiptRoot);
  mkdirSync(receiptRoot, { recursive: true, mode: 0o700 });
  assertExistingDirectoryComponents(workspaceRoot, receiptRoot, "receipt directory");
  assertSafeDirectory(workspaceRoot, receiptRoot, "receipt directory");
  assertSafeReceiptFile(receiptPath, "cleanup receipt");
  assertSafeReceiptFile(receiptLogPath, "cleanup receipt log");
  writeReceipt(receiptPath, receipt);

  if (!existsSync(tasksRoot)) return finishReceipt(receiptPath, receipt);

  let entries;
  try {
    entries = readdirSync(tasksRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    receipt.ok = false;
    receipt.errors.push({ task_id: null, reason: `tasks_directory_unreadable: ${errorMessage(error)}` });
    return finishReceipt(receiptPath, receipt);
  }

  const discovered: ArchivedTaskCleanupCandidate[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      receipt.ok = false;
      receipt.errors.push({ task_id: safeId(entry.name), reason: "unsafe_task_link" });
      continue;
    }
    if (!entry.isDirectory()) continue;
    if (!/^task[-_]/u.test(entry.name) || !isValidTaskIdSegment(entry.name)) {
      pushBounded(receipt.skipped, { task_id: safeId(entry.name), reason: "unrecognized_task_directory" });
      continue;
    }
    receipt.scanned += 1;
    const taskDir = join(tasksRoot, entry.name);
    try {
      assertSafeTaskDirectory(tasksRoot, taskDir);
      const evaluation = evaluateTask(taskDir, entry.name, cutoff, config);
      if (!evaluation.candidate) {
        pushBounded(receipt.skipped, { task_id: entry.name, reason: evaluation.reason });
        continue;
      }
      const inspected = inspectTree(taskDir);
      discovered.push({ ...evaluation.candidate, bytes: inspected });
    } catch (error) {
      receipt.ok = false;
      receipt.errors.push({ task_id: entry.name, reason: errorMessage(error) });
    }
  }

  discovered.sort((a, b) => a.archived_at.localeCompare(b.archived_at) || a.task_id.localeCompare(b.task_id));
  receipt.candidate_count = discovered.length;
  receipt.candidate_bytes = discovered.reduce((total, candidate) => total + candidate.bytes, 0);
  receipt.deferred_count = Math.max(0, discovered.length - maxBatch);
  receipt.candidates = discovered.slice(0, maxBatch);

  if (!receipt.ok) return finishReceipt(receiptPath, receipt);

  for (const candidate of receipt.candidates) {
    const taskDir = join(tasksRoot, candidate.task_id);
    const statusFile = join(taskDir, "status.json");
    try {
      const deleted = withFileLockSync(statusFile, () => {
        assertSafeTaskDirectory(tasksRoot, taskDir);
        const current = evaluateTask(taskDir, candidate.task_id, cutoff, config);
        if (!current.candidate) return false;
        inspectTree(taskDir);
        (options.removePath || defaultRemovePath)(taskDir);
        if (existsSync(taskDir)) throw new Error("task_directory_still_exists_after_delete");
        return true;
      });
      if (!deleted) {
        pushBounded(receipt.skipped, { task_id: candidate.task_id, reason: "state_changed_before_delete" });
        continue;
      }
      receipt.deleted.push(candidate);
      receipt.deleted_count += 1;
      receipt.deleted_bytes += candidate.bytes;
    } catch (error) {
      receipt.ok = false;
      receipt.errors.push({ task_id: candidate.task_id, reason: `delete_failed: ${errorMessage(error)}` });
      break;
    }
  }

  return finishReceipt(receiptPath, receipt);
}

export function startArchivedTaskCleanupScheduler(
  options: ArchivedTaskCleanupSchedulerOptions = {},
): ArchivedTaskCleanupScheduler {
  const config = options.config || getConfig();
  const intervalMs = options.intervalMs
    ?? positiveInteger(config.taskArchiveCleanupIntervalHours ?? 24, "taskArchiveCleanupIntervalHours") * HOUR_MS;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) throw new Error("intervalMs must be a positive integer");
  let running = false;
  let stopped = false;
  const runCleanup = options.runCleanup || (() => pruneArchivedTasks({ config }));
  const runNow = (): ArchivedTaskCleanupReceipt | null => {
    if (running || stopped) return null;
    running = true;
    try {
      const result = runCleanup();
      const context = {
        ok: result.ok,
        deleted_count: result.deleted_count,
        deleted_bytes: result.deleted_bytes,
        candidate_count: result.candidate_count,
        deferred_count: result.deferred_count,
      };
      if (result.ok) logger.info("[task-history] Archived task cleanup completed", context);
      else logger.warn("[task-history] Archived task cleanup stopped fail-closed", context);
      return result;
    } catch (error) {
      logger.warn("[task-history] Archived task cleanup failed", { error: errorMessage(error) });
      return null;
    } finally {
      running = false;
    }
  };
  runNow();
  const timer = setInterval(runNow, intervalMs);
  timer.unref();
  return {
    runNow,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

function evaluateTask(
  taskDir: string,
  taskId: string,
  cutoff: Date,
  config: PatchWardenConfig,
): { candidate: Omit<ArchivedTaskCleanupCandidate, "bytes"> | null; reason: string } {
  const statusFile = join(taskDir, "status.json");
  if (!existsSync(statusFile)) return { candidate: null, reason: "status_missing" };
  const statusStats = lstatSync(statusFile);
  if (!statusStats.isFile() || statusStats.isSymbolicLink()) throw new Error("unsafe_status_file");
  const status = readTaskStatusFile(statusFile);
  if (String(status.task_id || taskId) !== taskId) return { candidate: null, reason: "task_id_mismatch" };
  if (readTaskHistoryState(status) !== "archived") return { candidate: null, reason: "not_archived" };
  if (!isTerminalTaskStatus(String(status.status || ""))) return { candidate: null, reason: "not_terminal" };
  if (isWatcherOwningTask(taskDir, config).owned) return { candidate: null, reason: "active_watcher_ownership" };
  const age = archivedDate(status, statusStats.mtime);
  if (age.date.getTime() >= cutoff.getTime()) return { candidate: null, reason: "within_retention_window" };
  return {
    candidate: {
      task_id: taskId,
      archived_at: age.date.toISOString(),
      age_source: age.source,
    },
    reason: "expired_archived_task",
  };
}

function archivedDate(
  status: Record<string, unknown>,
  modifiedAt: Date,
): { date: Date; source: ArchivedTaskCleanupCandidate["age_source"] } {
  for (const [field, source] of [
    ["archived_at", "archived_at"],
    ["updated_at", "updated_at"],
  ] as const) {
    if (typeof status[field] !== "string") continue;
    const date = new Date(status[field]);
    if (!Number.isNaN(date.getTime())) return { date, source };
  }
  return { date: modifiedAt, source: "status_modified_time" };
}

function assertCleanupRoots(workspaceRoot: string, tasksRoot: string, receiptRoot: string): void {
  if (!isStrictlyWithin(workspaceRoot, tasksRoot)) throw new Error("tasksDir must be a child of workspaceRoot for cleanup");
  if (!isStrictlyWithin(workspaceRoot, receiptRoot)) throw new Error("cleanup receipt directory escapes workspaceRoot");
  assertExistingDirectoryComponents(workspaceRoot, tasksRoot, "tasks directory");
  assertExistingDirectoryComponents(workspaceRoot, receiptRoot, "receipt directory");
  if (existsSync(tasksRoot)) assertSafeDirectory(workspaceRoot, tasksRoot, "tasks directory");
}

function assertSafeDirectory(root: string, target: string, label: string): void {
  if (!isStrictlyWithin(root, target)) throw new Error(`${label} escapes allowed root`);
  const stats = lstatSync(target);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error(`${label} is a link or not a directory`);
  const realRoot = realpathSync.native(root);
  const realTarget = realpathSync.native(target);
  if (!isWithinOrEqual(realRoot, realTarget)) throw new Error(`${label} resolves outside allowed root`);
}

function assertSafeTaskDirectory(tasksRoot: string, taskDir: string): void {
  if (!isStrictlyWithin(tasksRoot, taskDir) || dirname(resolve(taskDir)) !== resolve(tasksRoot)) {
    throw new Error("task_directory_escapes_tasks_root");
  }
  const stats = lstatSync(taskDir);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("unsafe_task_directory");
  const realRoot = realpathSync.native(tasksRoot);
  const realTask = realpathSync.native(taskDir);
  if (!isStrictlyWithin(realRoot, realTask)) throw new Error("task_directory_resolves_outside_tasks_root");
}

function assertExistingDirectoryComponents(root: string, target: string, label: string): void {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  if (!isWithinOrEqual(resolvedRoot, resolvedTarget)) throw new Error(`${label} escapes allowed root`);

  const rootStats = lstatSync(resolvedRoot);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error("workspace root is a link or not a directory");
  }
  const realRoot = realpathSync.native(resolvedRoot);
  let current = resolvedRoot;
  const rel = relative(resolvedRoot, resolvedTarget);
  for (const segment of rel.split(/[\\/]/).filter(Boolean)) {
    current = join(current, segment);
    let stats;
    try {
      stats = lstatSync(current);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return;
      throw new Error(`${label} component is unreadable: ${errorMessage(error)}`);
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error(`${label} contains a link or non-directory component`);
    }
    let realCurrent: string;
    try {
      realCurrent = realpathSync.native(current);
    } catch (error) {
      throw new Error(`${label} component cannot be resolved: ${errorMessage(error)}`);
    }
    if (!isWithinOrEqual(realRoot, realCurrent)) {
      throw new Error(`${label} component resolves outside allowed root`);
    }
  }
}

function assertSafeReceiptFile(path: string, label: string): void {
  if (!existsSync(path)) return;
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`${label} is a link or not a file`);
}

function inspectTree(path: string): number {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) throw new Error("task_tree_contains_link");
  if (!stats.isDirectory()) return stats.size;
  let bytes = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error("task_tree_contains_link");
    bytes += inspectTree(join(path, entry.name));
  }
  return bytes;
}

function finishReceipt(receiptPath: string, receipt: ArchivedTaskCleanupReceipt): ArchivedTaskCleanupReceipt {
  receipt.completed_at = new Date().toISOString();
  writeReceipt(receiptPath, receipt);
  try {
    assertSafeReceiptFile(join(dirname(receiptPath), "history-cleanup.log"), "cleanup receipt log");
    appendBoundedTextFileSync(
      join(dirname(receiptPath), "history-cleanup.log"),
      `${JSON.stringify(receipt)}\n`,
      RECEIPT_LOG_MAX_BYTES,
    );
  } catch {
    // latest.json remains the authoritative bounded receipt.
  }
  return receipt;
}

function writeReceipt(path: string, receipt: ArchivedTaskCleanupReceipt): void {
  assertSafeReceiptFile(path, "cleanup receipt");
  atomicWriteJsonFileSync(path, {
    ...receipt,
    candidates: receipt.candidates.slice(0, RECEIPT_LIST_LIMIT),
    deleted: receipt.deleted.slice(0, RECEIPT_LIST_LIMIT),
    skipped: receipt.skipped.slice(0, RECEIPT_LIST_LIMIT),
    errors: receipt.errors.slice(0, RECEIPT_LIST_LIMIT),
  });
}

function defaultRemovePath(path: string): void {
  rmSync(path, { recursive: true, force: false, maxRetries: 3, retryDelay: 100 });
}

function isStrictlyWithin(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel);
}

function isWithinOrEqual(root: string, target: string): boolean {
  return resolve(root) === resolve(target) || isStrictlyWithin(root, target);
}

function validDate(value: Date | string | number): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("now must be a valid date");
  return date;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}

function boundedBatch(value: number): number {
  const batch = positiveInteger(value, "maxBatch");
  if (batch > 100) throw new Error("maxBatch must not exceed 100");
  return batch;
}

function pushBounded<T>(items: T[], value: T): void {
  if (items.length < RECEIPT_LIST_LIMIT) items.push(value);
}

function safeId(value: string): string {
  return value.slice(0, 240).replace(/[\u0000-\u001f]/g, "?");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
