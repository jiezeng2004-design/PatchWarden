import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { reloadConfig, type PatchWardenConfig } from "../../../config.js";
import { listAllTasks, listTasks } from "../../../tools/tasks/listTasks.js";
import { archiveTasks, restoreTask } from "../../../tools/tasks/taskHistory.js";

describe("task history archive", () => {
  let root: string;
  let config: PatchWardenConfig;
  let previousConfigPath: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pw-task-history-"));
    previousConfigPath = process.env.PATCHWARDEN_CONFIG;
    const configPath = join(root, "config.json");
    writeFileSync(configPath, JSON.stringify({ workspaceRoot: root, agents: {} }), "utf-8");
    process.env.PATCHWARDEN_CONFIG = configPath;
    config = reloadConfig(configPath);
  });

  afterEach(() => {
    if (previousConfigPath === undefined) delete process.env.PATCHWARDEN_CONFIG;
    else process.env.PATCHWARDEN_CONFIG = previousConfigPath;
    rmSync(root, { recursive: true, force: true });
  });

  it("archives only terminal tasks, hides them by default, and restores them", () => {
    writeTask("task-terminal-001", "failed");
    writeTask("task-pending-001", "pending");
    const archived = archiveTasks(["task-terminal-001", "task-pending-001"], config);
    assert.deepEqual(archived.archived, ["task-terminal-001"]);
    assert.equal(archived.rejected[0]?.reason, "task_not_terminal");
    assert.equal(existsSync(join(taskDir("task-terminal-001"), "status.json.bak")), true);
    assert.equal(listTasks({ history_state: "active", limit: 100 }).tasks.some((task) => task.task_id === "task-terminal-001"), false);
    assert.equal(listTasks({ history_state: "archived", limit: 100 }).tasks[0]?.history_state, "archived");

    const restored = restoreTask("task-terminal-001", config);
    assert.deepEqual(restored.restored, ["task-terminal-001"]);
    assert.equal(listTasks({ limit: 100 }).tasks.some((task) => task.task_id === "task-terminal-001"), true);
  });

  it("treats legacy reconcile_state archived as archived and bounds batches", () => {
    writeTask("task-legacy-001", "failed", { reconcile_state: "archived" });
    assert.equal(listTasks({ history_state: "archived" }).tasks[0]?.task_id, "task-legacy-001");
    assert.throws(() => archiveTasks(Array.from({ length: 101 }, (_, i) => `task-${i}`), config), /between 1 and 100/);
  });

  it("archives safe legacy Unicode task ids while rejecting path segments", () => {
    const legacyId = "task_1782057109511_念念小伴_release_优化计划";
    writeTask(legacyId, "failed");
    assert.deepEqual(archiveTasks([legacyId], config).archived, [legacyId]);
    assert.throws(() => archiveTasks(["task_../outside"], config), /invalid task id/);
  });

  it("keeps the public list_tasks response bounded while internal consumers can scan all candidates", () => {
    for (let index = 0; index < 125; index += 1) {
      writeTask(`task-page-${String(index).padStart(3, "0")}`, "done_by_agent");
    }

    const publicList = listTasks({ history_state: "active", limit: 250 });
    const completeList = listAllTasks({ history_state: "active" });

    assert.equal(publicList.total, 125);
    assert.equal(publicList.tasks.length, 100);
    assert.equal(publicList.returned, 100);
    assert.equal(completeList.total, 125);
    assert.equal(completeList.tasks.length, 125);
    assert.equal(completeList.returned, 125);
  });

  function taskDir(taskId: string): string {
    return join(root, ".patchwarden", "tasks", taskId);
  }

  function writeTask(taskId: string, status: string, extra: Record<string, unknown> = {}): void {
    const dir = taskDir(taskId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "status.json"), JSON.stringify({
      task_id: taskId,
      plan_id: "plan-test",
      agent: "fake",
      status,
      phase: status === "pending" ? "queued" : status,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      repo_path: ".",
      ...extra,
    }, null, 2), "utf-8");
  }
});
