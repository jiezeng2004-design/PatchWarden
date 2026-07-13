import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { reloadConfig } from "../../config.js";
import { getTaskSummary } from "../../tools/getTaskSummary.js";

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

describe("getTaskSummary", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pw-getsummary-"));
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

  // ── compact mode ──
  it("returns compact summary in compact mode", () => {
    writeTaskStatus("task-compact-001", baseStatus("task-compact-001", {
      status: "done",
      phase: "completed",
      verify_status: "passed",
    }));

    const result = getTaskSummary("task-compact-001", { view: "compact" });

    assert.equal(result.view, "compact");
    assert.equal(result.task_id, "task-compact-001");
    assert.equal(result.status, "done");
    assert.equal(result.terminal, true);
    // compact-only fields
    assert.equal(typeof result.changed_files_total, "number");
    assert.equal(typeof result.release_artifacts_count, "number");
    assert.ok(result.artifact_hygiene);
    assert.ok("max_items" in result.artifact_hygiene);
  });

  // ── full / standard mode ──
  it("returns full summary in standard mode", () => {
    writeTaskStatus("task-full-001", baseStatus("task-full-001", {
      status: "done",
      phase: "completed",
      verify_status: "passed",
    }));

    const result = getTaskSummary("task-full-001");

    // standard mode has no `view` field
    assert.equal((result as unknown as { view?: string }).view, undefined);
    assert.equal(result.task_id, "task-full-001");
    assert.equal(result.status, "done");
    assert.equal(result.terminal, true);
    // full-mode-only fields
    assert.ok("log_tails" in result);
    assert.ok("artifacts" in result);
    assert.ok("failed_command_detail" in result);
    assert.ok("acceptance_reviewed_at" in result);
  });

  // ── task not found ──
  it("throws when task does not exist", () => {
    assert.throws(
      () => getTaskSummary("non-existent-task"),
      /(File not found|Task not found)/
    );
  });

  // ── terminal: done ──
  it("returns terminal summary for done task with passed verification", () => {
    writeTaskStatus("task-done-001", baseStatus("task-done-001", {
      status: "done",
      phase: "completed",
      verify_status: "passed",
    }));

    const result = getTaskSummary("task-done-001");

    assert.equal(result.terminal, true);
    assert.equal(result.status, "done");
    assert.equal(result.verify_status, "passed");
    // done + verify passed → ready_for_review
    assert.equal(result.acceptance_status, "ready_for_review");
  });

  // ── terminal: failed ──
  it("returns terminal summary for failed task", () => {
    writeTaskStatus("task-failed-001", baseStatus("task-failed-001", {
      status: "failed",
      phase: "failed",
      error: "Agent exited with code 1",
    }));

    const result = getTaskSummary("task-failed-001");

    assert.equal(result.terminal, true);
    assert.equal(result.status, "failed");
    assert.equal(result.acceptance_status, "failed");
    assert.ok(result.errors.includes("Agent exited with code 1"));
  });

  // ── running (non-terminal) ──
  it("returns non-terminal summary for running task", () => {
    writeTaskStatus("task-running-001", baseStatus("task-running-001", {
      status: "running",
      phase: "executing_agent",
      started_at: "2026-07-12T10:00:00Z",
      finished_at: undefined,
    }));

    const result = getTaskSummary("task-running-001");

    assert.equal(result.terminal, false);
    assert.equal(result.status, "running");
    assert.equal(result.phase, "executing_agent");
    assert.equal(result.acceptance_status, "pending");
  });
});
