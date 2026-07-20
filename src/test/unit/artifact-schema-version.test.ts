import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { reloadConfig } from "../../config.js";
import { ARTIFACT_SCHEMA_VERSION, TOOL_SCHEMA_EPOCH } from "../../version.js";
import { createTask, type CreateTaskOutput } from "../../tools/tasks/createTask.js";
import { getTaskStatus } from "../../tools/tasks/getTaskStatus.js";
import { getTaskSummary } from "../../tools/tasks/getTaskSummary.js";
import {
  safeResult,
  safeTestSummary,
  safeDiffSummary,
} from "../../tools/diagnostics/safeViews.js";

// ── Helpers ───────────────────────────────────────────────────────

let tempDir: string;
let prevConfigEnv: string | undefined;

function writeConfig(workspaceRoot: string): void {
  const configPath = join(tempDir, "patchwarden.config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      workspaceRoot,
      tasksDir: ".patchwarden/tasks",
      plansDir: ".patchwarden/plans",
      assessmentsDir: ".patchwarden/assessments",
      directSessionsDir: ".patchwarden/direct-sessions",
      agents: {
        codex: { command: "codex", args: ["exec", "{prompt}"] },
      },
      allowedTestCommands: ["npm test", "npm run build"],
      defaultTaskTimeoutSeconds: 60,
      maxTaskTimeoutSeconds: 300,
      watcherStaleSeconds: 30,
    }),
    "utf-8"
  );
  prevConfigEnv = process.env.PATCHWARDEN_CONFIG;
  process.env.PATCHWARDEN_CONFIG = configPath;
  reloadConfig();
}

/** Write a fresh watcher heartbeat so readWatcherStatus reports healthy. */
function writeFreshHeartbeat(workspaceRoot: string): void {
  const heartbeatPath = join(workspaceRoot, ".patchwarden", "watcher-heartbeat.json");
  mkdirSync(dirname(heartbeatPath), { recursive: true });
  writeFileSync(
    heartbeatPath,
    JSON.stringify({
      status: "running",
      pid: process.pid,
      last_heartbeat_at: new Date().toISOString(),
      instance_id: "test-instance",
    }),
    "utf-8"
  );
}

/** Write a minimal set of task artifacts (NEW format with schema_version). */
function writeNewFormatArtifacts(taskId: string, taskDir: string, repoPath: string): void {
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(
    join(taskDir, "status.json"),
    JSON.stringify(
      {
        schema_version: ARTIFACT_SCHEMA_VERSION,
        task_id: taskId,
        status: "done_by_agent",
        phase: "done_by_agent",
        repo_path: "repo",
        resolved_repo_path: repoPath,
        agent: "codex",
        verify_status: "passed",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        last_heartbeat_at: new Date().toISOString(),
        current_command: null,
        error: null,
        acceptance_status: null,
      },
      null,
      2
    ),
    "utf-8"
  );
  writeFileSync(
    join(taskDir, "result.json"),
    JSON.stringify(
      {
        schema_version: ARTIFACT_SCHEMA_VERSION,
        task_id: taskId,
        status: "done_by_agent",
        summary: "Completed with schema_version.",
        changed_files: [],
        verify_status: "passed",
        warnings: [],
      },
      null,
      2
    ),
    "utf-8"
  );
  writeFileSync(
    join(taskDir, "verify.json"),
    JSON.stringify({ status: "passed", commands: [] }, null, 2),
    "utf-8"
  );
  writeFileSync(
    join(taskDir, "changed-files.json"),
    JSON.stringify(
      {
        schema_version: ARTIFACT_SCHEMA_VERSION,
        changed_files: [],
        additions: 0,
        deletions: 0,
        diff_available: false,
        diff_truncated: false,
        artifact_hygiene: { counts: {} },
      },
      null,
      2
    ),
    "utf-8"
  );
}

/** Write a minimal set of task artifacts (LEGACY format WITHOUT schema_version). */
function writeLegacyArtifacts(taskId: string, taskDir: string, repoPath: string): void {
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(
    join(taskDir, "status.json"),
    JSON.stringify(
      {
        // NOTE: no schema_version — simulates pre-v1.6.0 artifact
        task_id: taskId,
        status: "done_by_agent",
        phase: "done_by_agent",
        repo_path: "repo",
        resolved_repo_path: repoPath,
        agent: "codex",
        verify_status: "passed",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        last_heartbeat_at: new Date().toISOString(),
        current_command: null,
        error: null,
        acceptance_status: null,
      },
      null,
      2
    ),
    "utf-8"
  );
  writeFileSync(
    join(taskDir, "result.json"),
    JSON.stringify(
      {
        // NOTE: no schema_version
        task_id: taskId,
        status: "done_by_agent",
        summary: "Legacy artifact without schema_version.",
        changed_files: [],
        verify_status: "passed",
        warnings: [],
      },
      null,
      2
    ),
    "utf-8"
  );
  writeFileSync(
    join(taskDir, "verify.json"),
    JSON.stringify({ status: "passed", commands: [] }, null, 2),
    "utf-8"
  );
  writeFileSync(
    join(taskDir, "changed-files.json"),
    JSON.stringify(
      {
        // NOTE: no schema_version
        changed_files: [],
        additions: 0,
        deletions: 0,
        diff_available: false,
        diff_truncated: false,
        artifact_hygiene: { counts: {} },
      },
      null,
      2
    ),
    "utf-8"
  );
}

// ── Tests ─────────────────────────────────────────────────────────

describe("artifact schema_version", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pw-artifact-schema-"));
  });

  afterEach(() => {
    if (prevConfigEnv === undefined) delete process.env.PATCHWARDEN_CONFIG;
    else process.env.PATCHWARDEN_CONFIG = prevConfigEnv;
    reloadConfig();
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ── 1. Constant value ──────────────────────────────────────────

  it("ARTIFACT_SCHEMA_VERSION equals TOOL_SCHEMA_EPOCH and is the expected string", () => {
    assert.equal(ARTIFACT_SCHEMA_VERSION, TOOL_SCHEMA_EPOCH);
    assert.equal(typeof ARTIFACT_SCHEMA_VERSION, "string");
    assert.equal(ARTIFACT_SCHEMA_VERSION, "2026-07-19-v15");
  });

  // ── 2. createTask writes status.json with schema_version ───────

  it("createTask writes status.json with schema_version at top level", async () => {
    writeConfig(tempDir);
    mkdirSync(join(tempDir, "my-repo"), { recursive: true });
    writeFreshHeartbeat(tempDir);

    const result = await createTask({
      inline_plan: "## Goal\nVerify schema_version is written to status.json.",
      agent: "codex",
      repo_path: "my-repo",
    });

    const out = result as CreateTaskOutput;
    assert.ok(existsSync(join(out.path, "status.json")), "status.json should exist");

    const status = JSON.parse(readFileSync(join(out.path, "status.json"), "utf-8"));
    assert.equal(status.schema_version, ARTIFACT_SCHEMA_VERSION);
    assert.equal(typeof status.schema_version, "string");
    // Ensure schema_version is a top-level field, not nested
    assert.ok(Object.prototype.hasOwnProperty.call(status, "schema_version"));
    // Ensure existing fields are preserved
    assert.equal(status.task_id, out.task_id);
    assert.equal(status.status, "pending");
  });

  // ── 3. Safe views include schema_version in response ───────────

  it("safeResult/safeTestSummary/safeDiffSummary include schema_version in response", () => {
    writeConfig(tempDir);
    const taskId = "task-schema-new";
    const taskDir = join(tempDir, ".patchwarden", "tasks", taskId);
    const repoPath = join(tempDir, "repo");
    mkdirSync(repoPath, { recursive: true });
    writeNewFormatArtifacts(taskId, taskDir, repoPath);

    const sr = safeResult(taskId) as Record<string, unknown>;
    assert.equal(sr.schema_version, ARTIFACT_SCHEMA_VERSION);

    const sts = safeTestSummary(taskId) as Record<string, unknown>;
    assert.equal(sts.schema_version, ARTIFACT_SCHEMA_VERSION);

    const sds = safeDiffSummary(taskId) as Record<string, unknown>;
    assert.equal(sds.schema_version, ARTIFACT_SCHEMA_VERSION);
  });

  // ── 4. Readers tolerate legacy artifacts without schema_version ─

  it("getTaskStatus/getTaskSummary/safe views tolerate legacy artifacts without schema_version", () => {
    writeConfig(tempDir);
    const taskId = "task-legacy";
    const taskDir = join(tempDir, ".patchwarden", "tasks", taskId);
    const repoPath = join(tempDir, "repo");
    mkdirSync(repoPath, { recursive: true });
    writeLegacyArtifacts(taskId, taskDir, repoPath);

    // getTaskStatus must NOT throw on legacy status.json
    const status = getTaskStatus(taskId);
    assert.equal(status.task_id, taskId);
    assert.equal(status.status, "done_by_agent");
    // getTaskStatus spreads status.json fields; legacy has no schema_version
    assert.equal((status as unknown as Record<string, unknown>).schema_version, undefined);

    // getTaskSummary must NOT throw on legacy artifacts
    const summary = getTaskSummary(taskId);
    assert.equal(summary.task_id, taskId);
    assert.equal(summary.status, "done_by_agent");

    // Safe views must NOT throw on legacy artifacts; they always attach
    // schema_version to their own response (forward-compatible marker).
    const sr = safeResult(taskId) as Record<string, unknown>;
    assert.equal(sr.task_id, taskId);
    assert.equal(sr.schema_version, ARTIFACT_SCHEMA_VERSION);

    const sts = safeTestSummary(taskId) as Record<string, unknown>;
    assert.equal(sts.task_id, taskId);
    assert.equal(sts.schema_version, ARTIFACT_SCHEMA_VERSION);

    const sds = safeDiffSummary(taskId) as Record<string, unknown>;
    assert.equal(sds.task_id, taskId);
    assert.equal(sds.schema_version, ARTIFACT_SCHEMA_VERSION);
  });
});
