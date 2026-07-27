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
import { reloadConfig } from "../../../config.js";
import { createTask, type CreateTaskOutput, type AssessOnlyOutput } from "../../../tools/tasks/createTask.js";
import { savePlan } from "../../../tools/goals/savePlan.js";
import { PatchWardenError } from "../../../errors.js";

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

  it("persists retry provenance in the initial pending status record", async () => {
    writeConfig(tempDir);
    mkdirSync(join(tempDir, "my-repo"), { recursive: true });
    writeFreshHeartbeat(tempDir);
    const saved = savePlan({
      title: "Retry provenance plan",
      content: "## Goal\nRetry a repo-local task.",
    });

    const result = await createTask({
      plan_id: saved.plan_id,
      agent: "codex",
      repo_path: "my-repo",
      retry_metadata: {
        retry_of: "task_original",
        retry_count: 3,
        plan_source: "template",
        template: "feature_small",
        change_policy: "repo_scoped_changes",
      },
    }) as CreateTaskOutput;

    const status = JSON.parse(readFileSync(join(result.path, "status.json"), "utf-8"));
    assert.equal(status.status, "pending");
    assert.equal(status.retry_of, "task_original");
    assert.equal(status.retry_count, 3);
    assert.equal(status.plan_source, "template");
    assert.equal(status.template, "feature_small");
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

  it("refreshes Agent configuration before freezing an Assessment snapshot", async () => {
    writeConfig(tempDir);
    mkdirSync(join(tempDir, "my-repo"), { recursive: true });
    const configPath = join(tempDir, "patchwarden.config.json");
    const updated = JSON.parse(readFileSync(configPath, "utf-8"));
    updated.agents.codex = {
      command: "codex-updated",
      args: ["exec", "{prompt}"],
      adapter: "codex",
      default_model: "openai/model-after-refresh",
    };
    writeFileSync(configPath, JSON.stringify(updated), "utf-8");

    const assessed = await createTask({
      inline_plan: "## Goal\nInspect the refreshed Agent configuration.",
      agent: "codex",
      repo_path: "my-repo",
      execution_mode: "assess_only",
    }) as AssessOnlyOutput;
    const assessmentPath = join(
      tempDir,
      ".patchwarden",
      "assessments",
      assessed.assessment_id,
      "assessment.json",
    );
    const assessment = JSON.parse(readFileSync(assessmentPath, "utf-8"));
    assert.equal(assessment.model_selection.configured_default_model, "openai/model-after-refresh");
    assert.equal(assessment.model_selection.effective_model, "openai/model-after-refresh");

    const executed = await createTask({
      execution_mode: "execute",
      assessment_id: assessed.assessment_id,
    }) as CreateTaskOutput;
    assert.equal(executed.model_selection.effective_model, "openai/model-after-refresh");
  });

  it("reuses the original task for the same request_id and reports requested_model conflicts", async () => {
    writeConfig(tempDir);
    mkdirSync(join(tempDir, "my-repo"), { recursive: true });
    const input = {
      inline_plan: "## Goal\nCreate one idempotent task.",
      agent: "codex",
      requested_model: "openai/model-a",
      repo_path: "my-repo",
      request_id: "create_req_model_001",
    } as const;

    const first = await createTask(input);
    const reused = await createTask(input);
    assert.equal(reused.task_id, first.task_id);
    assert.equal(reused.reused_request, true);
    assert.equal(first.model_selection.requested_model, "openai/model-a");

    await assert.rejects(
      () => createTask({ ...input, requested_model: "openai/model-b" }),
      (error: unknown) => {
        assert.ok(error instanceof PatchWardenError);
        assert.equal(error.reason, "request_id_parameter_mismatch");
        assert.deepEqual(error.details.changed_fields, ["requested_model"]);
        return true;
      },
    );
    const taskEntries = readdirSync(join(tempDir, ".patchwarden", "tasks")).filter((name) => name.startsWith("task_"));
    assert.deepEqual(taskEntries, [first.task_id]);
  });

  it("coalesces concurrent identical create_task requests without a duplicate task", async () => {
    writeConfig(tempDir);
    mkdirSync(join(tempDir, "my-repo"), { recursive: true });
    const input = {
      inline_plan: "## Goal\nCreate exactly one concurrent task.",
      agent: "codex",
      requested_model: "openai/model-a",
      repo_path: "my-repo",
      request_id: "create_req_concurrent_001",
    } as const;

    const [first, second] = await Promise.all([createTask(input), createTask(input)]);
    assert.equal(first.task_id, second.task_id);
    assert.equal([first.reused_request, second.reused_request].filter(Boolean).length, 1);
    const taskEntries = readdirSync(join(tempDir, ".patchwarden", "tasks")).filter((name) => name.startsWith("task_"));
    assert.deepEqual(taskEntries, [first.task_id]);
  });

  it("requires an explicit Agent when requested_model is present", async () => {
    writeConfig(tempDir);
    mkdirSync(join(tempDir, "my-repo"), { recursive: true });
    for (const agent of [undefined, "auto"] as const) {
      await assert.rejects(
        () => createTask({
          inline_plan: "## Goal\nDo not auto-route this model.",
          ...(agent === undefined ? {} : { agent }),
          requested_model: "openai/model-a",
          repo_path: "my-repo",
        }),
        (error: unknown) => error instanceof PatchWardenError
          && error.reason === "requested_model_requires_explicit_agent",
      );
    }
  });

  it("locks requested_model into the two-phase assessment snapshot", async () => {
    writeConfig(tempDir);
    mkdirSync(join(tempDir, "my-repo"), { recursive: true });
    const assessment = await createTask({
      inline_plan: "## Goal\nKeep one model across assessment and execution.",
      agent: "codex",
      requested_model: "openai/model-a",
      repo_path: "my-repo",
      execution_mode: "assess_only",
    });

    await assert.rejects(
      () => createTask({
        execution_mode: "execute",
        assessment_id: assessment.assessment_id,
        requested_model: "openai/model-b",
      }),
      (error: unknown) => error instanceof PatchWardenError
        && error.reason === "assessment_parameter_mismatch"
        && error.details.field === "requested_model",
    );
    const executed = await createTask({
      execution_mode: "execute",
      assessment_id: assessment.assessment_id,
    });
    assert.equal(executed.model_selection.requested_model, "openai/model-a");
    assert.equal(executed.model_selection.effective_model, "openai/model-a");
  });
});
