import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { reloadConfig } from "../../../config.js";
import { getTaskStatus } from "../../../tools/tasks/getTaskStatus.js";

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

function writeTaskRuntime(taskDir: string, runtime: Record<string, unknown>): void {
  writeFileSync(join(taskDir, "runtime.json"), JSON.stringify(runtime, null, 2), "utf-8");
}

describe("getTaskStatus", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pw-getstatus-"));
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

  // ── pending ──
  it("reads pending status task", () => {
    writeTaskStatus("task-pending-001", {
      task_id: "task-pending-001",
      plan_id: "plan-001",
      agent: "codex",
      workspace_root: tempDir,
      repo_path: "repo",
      resolved_repo_path: join(tempDir, "repo"),
      status: "pending",
      phase: "queued",
      created_at: "2026-07-12T10:00:00Z",
      updated_at: "2026-07-12T10:00:01Z",
      timeout_seconds: 900,
      error: null,
    });

    const result = getTaskStatus("task-pending-001");

    assert.equal(result.task_id, "task-pending-001");
    assert.equal(result.status, "pending");
    assert.equal(result.phase, "queued");
    assert.equal(result.agent, "codex");
    assert.equal(result.plan_id, "plan-001");
    assert.equal(result.error, null);
    // No watcher heartbeat → watcher missing → pending task is execution_blocked
    assert.equal(result.execution_blocked, true);
    assert.equal(result.watcher_status, "missing");
    assert.equal(result.pending_reason, "queued_but_watcher_missing");
  });

  // ── running ──
  it("reads running status task and merges runtime.json", () => {
    const taskDir = writeTaskStatus("task-running-001", {
      task_id: "task-running-001",
      plan_id: "plan-001",
      agent: "codex",
      workspace_root: tempDir,
      repo_path: "repo",
      resolved_repo_path: join(tempDir, "repo"),
      status: "running",
      phase: "executing_agent",
      created_at: "2026-07-12T10:00:00Z",
      started_at: "2026-07-12T10:00:05Z",
      updated_at: "2026-07-12T10:00:10Z",
      timeout_seconds: 900,
      error: null,
    });
    writeTaskRuntime(taskDir, {
      phase: "executing_agent",
      last_heartbeat_at: "2026-07-12T10:00:12Z",
      current_command: "codex exec --prompt",
    });

    const result = getTaskStatus("task-running-001");

    assert.equal(result.status, "running");
    assert.equal(result.phase, "executing_agent");
    assert.equal(result.current_command, "codex exec --prompt");
    assert.equal(result.last_heartbeat_at, "2026-07-12T10:00:12Z");
    assert.equal(result.started_at, "2026-07-12T10:00:05Z");
    // running (not pending) → execution_blocked is false
    assert.equal(result.execution_blocked, false);
    assert.equal(result.pending_reason, "agent_running");
  });

  // ── done ──
  it("reads done status task", () => {
    writeTaskStatus("task-done-001", {
      task_id: "task-done-001",
      plan_id: "plan-001",
      agent: "codex",
      workspace_root: tempDir,
      repo_path: "repo",
      resolved_repo_path: join(tempDir, "repo"),
      status: "done",
      phase: "completed",
      created_at: "2026-07-12T10:00:00Z",
      started_at: "2026-07-12T10:00:05Z",
      finished_at: "2026-07-12T10:05:00Z",
      updated_at: "2026-07-12T10:05:00Z",
      timeout_seconds: 900,
      verify_status: "passed",
      error: null,
    });

    const result = getTaskStatus("task-done-001");

    assert.equal(result.status, "done");
    assert.equal(result.phase, "completed");
    assert.equal(result.finished_at, "2026-07-12T10:05:00Z");
    assert.equal(result.verify_status, "passed");
    assert.equal(result.execution_blocked, false);
    assert.equal(result.pending_reason, null);
  });

  // ── failed ──
  it("reads failed status task", () => {
    writeTaskStatus("task-failed-001", {
      task_id: "task-failed-001",
      plan_id: "plan-001",
      agent: "codex",
      workspace_root: tempDir,
      repo_path: "repo",
      resolved_repo_path: join(tempDir, "repo"),
      status: "failed",
      phase: "failed",
      created_at: "2026-07-12T10:00:00Z",
      started_at: "2026-07-12T10:00:05Z",
      finished_at: "2026-07-12T10:05:00Z",
      updated_at: "2026-07-12T10:05:00Z",
      timeout_seconds: 900,
      error: "Agent exited with code 1",
    });

    const result = getTaskStatus("task-failed-001");

    assert.equal(result.status, "failed");
    assert.equal(result.phase, "failed");
    assert.equal(result.error, "Agent exited with code 1");
    assert.equal(result.finished_at, "2026-07-12T10:05:00Z");
    assert.equal(result.execution_blocked, false);
  });

  // ── status.json missing ──
  it("throws when status.json is missing (task not found)", () => {
    // guardReadPath throws "File not found" before the existsSync "Task not found" check
    assert.throws(
      () => getTaskStatus("non-existent-task"),
      /(File not found|Task not found)/
    );
  });

  // ── status.json corrupt ──
  it("throws when status.json is corrupt", () => {
    const taskDir = join(tasksDir, "task-corrupt-001");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "status.json"), "{not valid json", "utf-8");

    assert.throws(
      () => getTaskStatus("task-corrupt-001"),
      SyntaxError
    );
  });
});
