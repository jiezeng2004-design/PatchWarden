import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { reloadConfig } from "../../config.js";
import { createTask, type CreateTaskOutput, type AssessOnlyOutput } from "../../tools/createTask.js";
import { savePlan } from "../../tools/savePlan.js";
import { PatchWardenError } from "../../errors.js";

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

describe("createTask", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pw-createtask-"));
  });

  afterEach(() => {
    if (prevConfigEnv === undefined) delete process.env.PATCHWARDEN_CONFIG;
    else process.env.PATCHWARDEN_CONFIG = prevConfigEnv;
    reloadConfig();
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ── 1. inline_plan source ──────────────────────────────────────

  it("creates a task from inline_plan, writes status.json, and allocates a task directory", async () => {
    writeConfig(tempDir);
    mkdirSync(join(tempDir, "my-repo"), { recursive: true });
    writeFreshHeartbeat(tempDir);

    const result = await createTask({
      inline_plan: "## Goal\nAdd a hello-world print statement to main.ts.",
      agent: "codex",
      repo_path: "my-repo",
    });

    const out = result as CreateTaskOutput;
    assert.ok(out.task_id.startsWith("task_"), `task_id should start with "task_", got: ${out.task_id}`);
    assert.equal(out.status, "pending");
    assert.equal(out.plan_source, "inline");
    assert.equal(out.agent, "codex");
    assert.equal(out.execution_blocked, false);
    assert.ok(existsSync(out.path), "task directory should exist");
    assert.ok(existsSync(join(out.path, "status.json")), "status.json should exist");

    const status = JSON.parse(readFileSync(join(out.path, "status.json"), "utf-8"));
    assert.equal(status.task_id, out.task_id);
    assert.equal(status.status, "pending");
    assert.equal(status.phase, "queued");
    assert.equal(status.agent, "codex");
    assert.equal(status.plan_source, "inline");
    assert.equal(status.repo_path, "my-repo");
  });

  // ── 2. template source ─────────────────────────────────────────

  it("creates a task from a built-in template (feature_small)", async () => {
    writeConfig(tempDir);
    mkdirSync(join(tempDir, "my-repo"), { recursive: true });
    writeFreshHeartbeat(tempDir);

    const result = await createTask({
      template: "feature_small",
      goal: "Add a utility function for string truncation.",
      agent: "codex",
      repo_path: "my-repo",
    });

    const out = result as CreateTaskOutput;
    assert.ok(out.task_id.startsWith("task_"));
    assert.equal(out.plan_source, "template");
    assert.equal(out.template, "feature_small");
    assert.ok(existsSync(join(out.path, "status.json")));

    const status = JSON.parse(readFileSync(join(out.path, "status.json"), "utf-8"));
    assert.equal(status.template, "feature_small");
    assert.equal(status.plan_source, "template");
  });

  // ── 3. plan_id source ──────────────────────────────────────────

  it("creates a task from a previously saved plan_id", async () => {
    writeConfig(tempDir);
    mkdirSync(join(tempDir, "my-repo"), { recursive: true });
    writeFreshHeartbeat(tempDir);

    const saved = savePlan({
      title: "Pre-saved plan",
      content: "## Goal\nDo something safe and repo-local.",
    });
    const result = await createTask({
      plan_id: saved.plan_id,
      agent: "codex",
      repo_path: "my-repo",
    });

    const out = result as CreateTaskOutput;
    assert.equal(out.plan_id, saved.plan_id);
    assert.equal(out.plan_source, "saved");
    assert.ok(existsSync(join(out.path, "status.json")));

    const status = JSON.parse(readFileSync(join(out.path, "status.json"), "utf-8"));
    assert.equal(status.plan_id, saved.plan_id);
    assert.equal(status.plan_source, "saved");
  });

  // ── 4. assess_only mode ────────────────────────────────────────

  it("returns a risk assessment instead of creating a task in assess_only mode", async () => {
    writeConfig(tempDir);
    mkdirSync(join(tempDir, "my-repo"), { recursive: true });

    const result = await createTask({
      inline_plan: "## Goal\nAdd a print statement to main.ts.",
      agent: "codex",
      repo_path: "my-repo",
      execution_mode: "assess_only",
    });

    const out = result as AssessOnlyOutput;
    assert.ok(out.assessment_id, "assessment_id should be present");
    assert.ok(out.assessment_short_id, "assessment_short_id should be present");
    assert.equal(out.decision, "allow");
    assert.equal(out.risk_level, "low");
    assert.ok(out.next_tool_call, "next_tool_call should be present for allow decision");
    assert.equal(out.next_tool_call!.name, "create_task");
    assert.equal(out.next_tool_call!.arguments.execution_mode, "execute");
    assert.equal(out.next_tool_call!.arguments.assessment_id, out.assessment_id);

    // No task directory should be created in assess_only mode
    assert.equal("task_id" in out, false, "assess_only output should not contain task_id");
    const tasksDir = join(tempDir, ".patchwarden", "tasks");
    if (existsSync(tasksDir)) {
      const taskEntries = readdirSync(tasksDir).filter((name) => name.startsWith("task_"));
      assert.equal(taskEntries.length, 0, "no task directory should be created in assess_only mode");
    }
  });

  // ── 5. agent not configured ────────────────────────────────────

  it("throws PatchWardenError (agent_not_configured) when the agent is not registered", async () => {
    writeConfig(tempDir);
    mkdirSync(join(tempDir, "my-repo"), { recursive: true });

    await assert.rejects(
      () =>
        createTask({
          inline_plan: "## Goal\nDo something.",
          agent: "ghost-agent",
          repo_path: "my-repo",
        }),
      (err: unknown) => {
        assert.ok(err instanceof PatchWardenError, "should throw PatchWardenError");
        assert.equal((err as PatchWardenError).reason, "agent_not_configured");
        return true;
      }
    );
  });

  // ── 6. repo_path escapes workspace ─────────────────────────────

  it("throws workspace_path_escape when repo_path is outside workspaceRoot", async () => {
    writeConfig(tempDir);
    mkdirSync(join(tempDir, "my-repo"), { recursive: true });

    await assert.rejects(
      () =>
        createTask({
          inline_plan: "## Goal\nDo something.",
          agent: "codex",
          repo_path: "../outside-workspace",
        }),
      (err: unknown) => {
        assert.ok(err instanceof PatchWardenError, "should throw PatchWardenError");
        assert.equal((err as PatchWardenError).reason, "workspace_path_escape");
        return true;
      }
    );
  });

  // ── 7. watcher not running ─────────────────────────────────────

  it("returns execution_blocked: true when watcher is not running", async () => {
    writeConfig(tempDir);
    mkdirSync(join(tempDir, "my-repo"), { recursive: true });
    // No watcher heartbeat file → watcher status is "missing"

    const result = await createTask({
      inline_plan: "## Goal\nDo something.",
      agent: "codex",
      repo_path: "my-repo",
    });

    const out = result as CreateTaskOutput;
    assert.equal(out.execution_blocked, true);
    assert.equal(out.watcher.available, false);
    assert.equal(out.watcher.status, "missing");
    assert.equal(out.next_tool_call.name, "health_check");
    // Task is still created (queued) despite being blocked
    assert.ok(existsSync(join(out.path, "status.json")));
  });
});
