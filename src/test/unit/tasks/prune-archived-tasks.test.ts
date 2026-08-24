import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { reloadConfig, type PatchWardenConfig } from "../../../config.js";
import {
  pruneArchivedTasks,
  startArchivedTaskCleanupScheduler,
  type ArchivedTaskCleanupReceipt,
} from "../../../tools/tasks/pruneArchivedTasks.js";

const NOW = new Date("2026-07-27T12:00:00.000Z");
const OLD = "2026-06-01T12:00:00.000Z";
const RECENT = "2026-07-20T12:00:00.000Z";

describe("archived task retention", () => {
  let root: string;
  let config: PatchWardenConfig;
  let previousConfigPath: string | undefined;
  const outsideRoots: string[] = [];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pw-archived-retention-"));
    previousConfigPath = process.env.PATCHWARDEN_CONFIG;
    const configPath = join(root, "config.json");
    writeFileSync(configPath, JSON.stringify({
      workspaceRoot: root,
      agents: {},
      taskArchiveRetentionDays: 30,
      taskArchiveCleanupIntervalHours: 24,
      taskArchiveCleanupMaxBatch: 100,
    }), "utf-8");
    process.env.PATCHWARDEN_CONFIG = configPath;
    config = reloadConfig(configPath);
  });

  afterEach(() => {
    if (previousConfigPath === undefined) delete process.env.PATCHWARDEN_CONFIG;
    else process.env.PATCHWARDEN_CONFIG = previousConfigPath;
    rmSync(root, { recursive: true, force: true });
    for (const outside of outsideRoots.splice(0)) rmSync(outside, { recursive: true, force: true });
  });

  it("deletes only expired archived terminal tasks and writes bounded receipts", () => {
    writeTask("task-expired", "failed", { history_state: "archived", archived_at: OLD });
    writeTask("task-recent", "failed", { history_state: "archived", archived_at: RECENT });
    writeTask("task-active", "failed", { history_state: "active", archived_at: OLD });
    writeTask("task-running", "running", { history_state: "archived", archived_at: OLD });

    const result = pruneArchivedTasks({ config, now: NOW });

    assert.equal(result.ok, true);
    assert.deepEqual(result.deleted.map((item) => item.task_id), ["task-expired"]);
    assert.equal(existsSync(taskDir("task-expired")), false);
    assert.equal(existsSync(taskDir("task-recent")), true);
    assert.equal(existsSync(taskDir("task-active")), true);
    assert.equal(existsSync(taskDir("task-running")), true);
    assert.ok(result.skipped.some((item) => item.task_id === "task-recent" && item.reason === "within_retention_window"));
    assert.ok(result.skipped.some((item) => item.task_id === "task-active" && item.reason === "not_archived"));
    assert.ok(result.skipped.some((item) => item.task_id === "task-running" && item.reason === "not_terminal"));

    const receiptPath = join(root, ".patchwarden", "history-cleanup", "latest.json");
    const receipt = JSON.parse(readFileSync(receiptPath, "utf-8")) as ArchivedTaskCleanupReceipt;
    assert.equal(receipt.deleted_count, 1);
    assert.equal(receipt.completed_at !== null, true);
    const logPath = join(root, ".patchwarden", "history-cleanup", "history-cleanup.log");
    assert.equal(existsSync(logPath), true);
    assert.ok(readFileSync(logPath, "utf-8").length <= 1024 * 1024);
  });

  it("uses legacy timestamps conservatively and bounds each cleanup batch", () => {
    writeTask("task-old-a", "failed", { history_state: "archived", archived_at: "2026-05-01T00:00:00.000Z" });
    writeTask("task-old-b", "failed", { history_state: "archived", archived_at: "2026-05-02T00:00:00.000Z" });
    writeTask("task-old-c", "failed", { history_state: undefined, reconcile_state: "archived", updated_at: "2026-05-03T00:00:00.000Z" });

    const first = pruneArchivedTasks({ config, now: NOW, maxBatch: 2 });
    assert.equal(first.candidate_count, 3);
    assert.equal(first.deleted_count, 2);
    assert.equal(first.deferred_count, 1);
    assert.equal(existsSync(taskDir("task-old-c")), true);

    const second = pruneArchivedTasks({ config, now: NOW, maxBatch: 2 });
    assert.deepEqual(second.deleted.map((item) => item.task_id), ["task-old-c"]);
    assert.equal(second.deleted[0]?.age_source, "updated_at");
  });

  it("fails closed before deletion when any candidate tree contains a junction", () => {
    writeTask("task-safe-expired", "failed", { history_state: "archived", archived_at: OLD });
    writeTask("task-linked-expired", "failed", { history_state: "archived", archived_at: OLD });
    const outside = mkdtempSync(join(tmpdir(), "pw-archived-retention-outside-"));
    outsideRoots.push(outside);
    writeFileSync(join(outside, "keep.txt"), "outside", "utf-8");
    symlinkSync(outside, join(taskDir("task-linked-expired"), "unsafe"), process.platform === "win32" ? "junction" : "dir");

    const result = pruneArchivedTasks({ config, now: NOW });

    assert.equal(result.ok, false);
    assert.equal(result.deleted_count, 0);
    assert.equal(existsSync(taskDir("task-safe-expired")), true);
    assert.equal(existsSync(join(outside, "keep.txt")), true);
    assert.ok(result.errors.some((item) => item.task_id === "task-linked-expired" && /link/.test(item.reason)));
  });

  it("fails closed before deletion when the receipt directory is a junction", () => {
    writeTask("task-safe-expired", "failed", { history_state: "archived", archived_at: OLD });
    const outside = mkdtempSync(join(tmpdir(), "pw-archived-receipt-outside-"));
    outsideRoots.push(outside);
    const receiptRoot = join(root, ".patchwarden", "history-cleanup");
    symlinkSync(outside, receiptRoot, process.platform === "win32" ? "junction" : "dir");

    assert.throws(() => pruneArchivedTasks({ config, now: NOW }), /receipt directory.*link/);
    assert.equal(existsSync(taskDir("task-safe-expired")), true);
    assert.deepEqual(readdirSync(outside), []);
  });

  it("rejects an external .patchwarden junction before creating a cleanup receipt", () => {
    const outside = mkdtempSync(join(tmpdir(), "pw-archived-ancestor-outside-"));
    outsideRoots.push(outside);
    symlinkSync(outside, join(root, ".patchwarden"), process.platform === "win32" ? "junction" : "dir");

    assert.throws(() => pruneArchivedTasks({ config, now: NOW }), /receipt directory.*link|tasks directory.*link/);
    assert.deepEqual(readdirSync(outside), []);
    assert.equal(existsSync(join(outside, "history-cleanup")), false);
  });

  it("writes an empty in-workspace receipt when the tasks directory is absent", () => {
    const result = pruneArchivedTasks({ config, now: NOW });

    assert.equal(result.ok, true);
    assert.equal(result.scanned, 0);
    assert.equal(result.deleted_count, 0);
    assert.equal(existsSync(join(root, ".patchwarden", "history-cleanup", "latest.json")), true);
  });

  it("stops after the first deletion failure and preserves later candidates", () => {
    writeTask("task-delete-a", "failed", { history_state: "archived", archived_at: "2026-05-01T00:00:00.000Z" });
    writeTask("task-delete-b", "failed", { history_state: "archived", archived_at: "2026-05-02T00:00:00.000Z" });
    writeTask("task-delete-c", "failed", { history_state: "archived", archived_at: "2026-05-03T00:00:00.000Z" });
    let calls = 0;

    const result = pruneArchivedTasks({
      config,
      now: NOW,
      removePath(path) {
        calls += 1;
        if (calls === 2) throw new Error("simulated removal failure");
        rmSync(path, { recursive: true, force: false });
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.deleted_count, 1);
    assert.equal(calls, 2);
    assert.equal(existsSync(taskDir("task-delete-a")), false);
    assert.equal(existsSync(taskDir("task-delete-b")), true);
    assert.equal(existsSync(taskDir("task-delete-c")), true);
  });

  it("defers startup cleanup so server bootstrap is never blocked, repeats on schedule, and stops cleanly", async () => {
    let runs = 0;
    const scheduler = startArchivedTaskCleanupScheduler({
      config,
      intervalMs: 25,
      initialDelayMs: 0,
      runCleanup() {
        runs += 1;
        return emptyReceipt();
      },
    });
    assert.equal(runs, 0, "scheduler construction must not run synchronous cleanup");
    const startupDeadline = Date.now() + 500;
    while (runs < 1 && Date.now() < startupDeadline) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
    assert.ok(runs >= 1, "startup cleanup must run asynchronously");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 75));
    assert.ok(runs >= 2, "scheduled cleanup must repeat");
    scheduler.stop();
    const stoppedAt = runs;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    assert.equal(runs, stoppedAt, "stop must clear the interval");
    assert.equal(scheduler.runNow(), false, "stopped scheduler must not run manually");
  });

  it("runs the production cleanup path in a worker without blocking the caller", async () => {
    const startedAt = Date.now();
    const scheduler = startArchivedTaskCleanupScheduler({
      config,
      initialDelayMs: 0,
      intervalMs: 60_000,
    });
    assert.ok(Date.now() - startedAt < 100, "worker scheduling must return before cleanup runs");

    const receiptPath = join(root, ".patchwarden", "history-cleanup", "latest.json");
    const receiptLogPath = join(root, ".patchwarden", "history-cleanup", "history-cleanup.log");
    const deadline = Date.now() + 5_000;
    while ((!existsSync(receiptPath) || !existsSync(receiptLogPath)) && Date.now() < deadline) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    scheduler.stop();
    assert.equal(existsSync(receiptPath), true, "worker cleanup must produce its bounded receipt");
  });

  it("rejects a tasks root that could delete the workspace itself", () => {
    const unsafe = { ...config, tasksDir: "." };
    assert.throws(() => pruneArchivedTasks({ config: unsafe, now: NOW }), /child of workspaceRoot/);
  });

  function taskDir(taskId: string): string {
    return join(root, ".patchwarden", "tasks", taskId);
  }

  function writeTask(taskId: string, status: string, extra: Record<string, unknown>): void {
    const dir = taskDir(taskId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "status.json"), JSON.stringify({
      task_id: taskId,
      status,
      phase: status,
      history_state: "active",
      created_at: OLD,
      updated_at: OLD,
      repo_path: ".",
      ...extra,
    }, null, 2), "utf-8");
    writeFileSync(join(dir, "result.md"), "bounded evidence", "utf-8");
  }
});

function emptyReceipt(): ArchivedTaskCleanupReceipt {
  return {
    schema_version: "1",
    ok: true,
    started_at: NOW.toISOString(),
    completed_at: NOW.toISOString(),
    retention_days: 30,
    cutoff: new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    max_batch: 100,
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
    receipt_path: ".patchwarden/history-cleanup/latest.json",
  };
}
