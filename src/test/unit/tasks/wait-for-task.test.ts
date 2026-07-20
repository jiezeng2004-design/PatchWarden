import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { reloadConfig } from "../../../config.js";
import { waitForTask } from "../../../tools/tasks/waitForTask.js";

let tempDir: string;
let tasksDir: string;
let prevConfigEnv: string | undefined;

function writeConfig(): void {
  const configPath = join(tempDir, "patchwarden.config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      workspaceRoot: tempDir,
      tasksDir: ".patchwarden/tasks",
      plansDir: ".patchwarden/plans",
      assessmentsDir: ".patchwarden/assessments",
      directSessionsDir: ".patchwarden/direct-sessions",
      agents: { codex: { command: "codex", args: ["exec", "{prompt}"] } },
      allowedTestCommands: ["npm test"],
    }),
    "utf-8"
  );
  prevConfigEnv = process.env.PATCHWARDEN_CONFIG;
  process.env.PATCHWARDEN_CONFIG = configPath;
  reloadConfig();
}

function writeTaskStatus(taskId: string, status: Record<string, unknown>): string {
  const taskDir = join(tasksDir, taskId);
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "status.json"), JSON.stringify(status, null, 2), "utf-8");
  return taskDir;
}

function baseStatus(taskId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    task_id: taskId,
    plan_id: "plan-001",
    agent: "codex",
    workspace_root: tempDir,
    repo_path: "repo",
    resolved_repo_path: join(tempDir, "repo"),
    created_at: "2026-07-12T10:00:00Z",
    started_at: "2026-07-12T10:00:05Z",
    finished_at: "2026-07-12T10:05:00Z",
    updated_at: "2026-07-12T10:05:00Z",
    timeout_seconds: 900,
    error: null,
    ...overrides,
  };
}

describe("waitForTask", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pw-waitfortask-"));
    tasksDir = join(tempDir, ".patchwarden", "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeConfig();
  });

  afterEach(() => {
    if (prevConfigEnv === undefined) delete process.env.PATCHWARDEN_CONFIG;
    else process.env.PATCHWARDEN_CONFIG = prevConfigEnv;
    reloadConfig();
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ── already terminal: done ──
  it("returns immediately when task is already done", async () => {
    writeTaskStatus("task-done-001", baseStatus("task-done-001", {
      status: "done",
      phase: "completed",
      verify_status: "passed",
    }));

    const result = await waitForTask("task-done-001", 5);

    assert.equal(result.task_id, "task-done-001");
    assert.equal(result.status, "done");
    assert.equal(result.terminal, true);
    assert.equal(result.timed_out, false);
    assert.equal(result.continuation_required, false);
    // terminal → includes compact summary, next tool is audit_task
    assert.ok(result.summary);
    assert.equal(result.next_tool_call.name, "audit_task");
    assert.equal(result.progress_summary, undefined);
  });

  // ── already terminal: failed ──
  it("returns immediately when task is already failed", async () => {
    writeTaskStatus("task-failed-001", baseStatus("task-failed-001", {
      status: "failed",
      phase: "failed",
      error: "Agent exited with code 1",
    }));

    const result = await waitForTask("task-failed-001", 5);

    assert.equal(result.terminal, true);
    assert.equal(result.status, "failed");
    assert.equal(result.timed_out, false);
    assert.equal(result.continuation_required, false);
    assert.ok(result.summary);
    assert.equal(result.next_tool_call.name, "audit_task");
  });

  // ── running + timeout → continuation_required ──
  it("returns continuation_required when running task times out", async () => {
    writeTaskStatus("task-running-001", baseStatus("task-running-001", {
      status: "running",
      phase: "executing_agent",
      finished_at: undefined,
    }));

    const result = await waitForTask("task-running-001", 1);

    assert.equal(result.task_id, "task-running-001");
    assert.equal(result.status, "running");
    assert.equal(result.terminal, false);
    assert.equal(result.timed_out, true);
    assert.equal(result.continuation_required, true);
    // non-terminal → includes progress_summary, next tool is wait_for_task
    assert.ok(result.progress_summary);
    assert.equal(result.next_tool_call.name, "wait_for_task");
    assert.equal(result.summary, undefined);
    // waited approximately 1 second
    assert.ok(result.waited_ms >= 900 && result.waited_ms <= 3000);
  });

  // ── canceled (terminal) ──
  it("returns terminal result for canceled task", async () => {
    writeTaskStatus("task-canceled-001", baseStatus("task-canceled-001", {
      status: "canceled",
      phase: "canceled",
    }));

    const result = await waitForTask("task-canceled-001", 5);

    assert.equal(result.terminal, true);
    assert.equal(result.status, "canceled");
    assert.equal(result.timed_out, false);
    assert.equal(result.continuation_required, false);
    assert.ok(result.summary);
    assert.equal(result.next_tool_call.name, "audit_task");
  });

  // ── task not found ──
  it("throws when task does not exist", async () => {
    await assert.rejects(
      () => waitForTask("non-existent-task", 1),
      /(File not found|Task not found)/
    );
  });

  // ── invalid wait_seconds ──
  it("throws when wait_seconds is out of range", async () => {
    writeTaskStatus("task-validate-001", baseStatus("task-validate-001", {
      status: "done",
      phase: "completed",
    }));

    await assert.rejects(
      () => waitForTask("task-validate-001", 0),
      /wait_seconds must be an integer from 1 to 30/
    );
    await assert.rejects(
      () => waitForTask("task-validate-001", 31),
      /wait_seconds must be an integer from 1 to 30/
    );
  });
});
