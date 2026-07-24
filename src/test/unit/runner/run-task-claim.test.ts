import { strict as assert } from "node:assert";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, it } from "node:test";
import { reloadConfig } from "../../../config.js";
import { runTask } from "../../../runner/runTask.js";
import { cancelTask } from "../../../tools/tasks/cancelTask.js";

describe("runTask claim", () => {
  let root: string;
  let repo: string;
  let marker: string;
  let configPath: string;
  let previousConfig: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pw-run-task-claim-"));
    repo = join(root, "repo");
    marker = join(repo, "agent-runs.txt");
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "main.txt"), "before\n", "utf-8");

    const script = `require("node:fs").appendFileSync(${JSON.stringify(marker)}, "run\\n"); setTimeout(() => process.exit(0), 200);`;
    configPath = join(root, "patchwarden.config.json");
    writeAgentConfig(script);
    const planDir = join(root, ".patchwarden", "plans", "plan-claim");
    mkdirSync(planDir, { recursive: true });
    writeFileSync(join(planDir, "plan.md"), "Run the fixture once.\n", "utf-8");

    previousConfig = process.env.PATCHWARDEN_CONFIG;
    process.env.PATCHWARDEN_CONFIG = configPath;
    reloadConfig(configPath);
  });

  function writeAgentConfig(script: string): void {
    writeFileSync(configPath, JSON.stringify({
      workspaceRoot: root,
      plansDir: ".patchwarden/plans",
      tasksDir: ".patchwarden/tasks",
      agents: {
        fixture: { command: process.execPath, args: ["-e", script, "{prompt}"] },
      },
      allowedTestCommands: [],
      defaultTaskTimeoutSeconds: 10,
      maxTaskTimeoutSeconds: 30,
    }), "utf-8");
  }

  afterEach(() => {
    if (previousConfig === undefined) delete process.env.PATCHWARDEN_CONFIG;
    else process.env.PATCHWARDEN_CONFIG = previousConfig;
    reloadConfig(previousConfig);
    rmSync(root, { recursive: true, force: true });
  });

  function writePendingTask(taskId: string, timeoutSeconds = 10): string {
    const taskDir = join(root, ".patchwarden", "tasks", taskId);
    mkdirSync(taskDir, { recursive: true });
    const now = new Date().toISOString();
    writeFileSync(join(taskDir, "status.json"), JSON.stringify({
      task_id: taskId,
      plan_id: "plan-claim",
      agent: "fixture",
      repo_path: "repo",
      resolved_repo_path: repo,
      workspace_root: root,
      status: "pending",
      phase: "queued",
      timeout_seconds: timeoutSeconds,
      test_command: "",
      verify_commands: [],
      change_policy: "repo_scoped_changes",
      created_at: now,
      updated_at: now,
    }), "utf-8");
    return taskDir;
  }

  it("executes a pending task once when two runners race", { timeout: 20_000 }, async () => {
    const taskDir = writePendingTask("task-claim-race");
    const first = runTask("task-claim-race");
    const second = runTask("task-claim-race");
    const results = await Promise.all([first, second]);

    assert.equal(results.filter((result) => result.status === "done_by_agent").length, 1);
    assert.equal(results.filter((result) => result.error?.includes("only pending tasks")).length, 1);
    assert.equal(readFileSync(marker, "utf-8"), "run\n");
    assert.equal(JSON.parse(readFileSync(join(taskDir, "status.json"), "utf-8")).status, "done_by_agent");

    const replay = await runTask("task-claim-race");
    assert.equal(replay.status, "done_by_agent");
    assert.match(replay.error || "", /only pending tasks/);
    assert.equal(readFileSync(marker, "utf-8"), "run\n");
  });

  it("does not execute a task canceled before claim", async () => {
    const taskDir = writePendingTask("task-canceled-before-claim");
    const canceled = cancelTask("task-canceled-before-claim");
    assert.equal(canceled.new_status, "canceled");

    const result = await runTask("task-canceled-before-claim");
    assert.equal(result.status, "canceled");
    assert.match(result.error || "", /only pending tasks/);
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(join(taskDir, "result.json")), false);
  });

  it("converges a running agent to the timeout terminal state", { timeout: 20_000 }, async () => {
    const hangScript = `require("node:fs").appendFileSync(${JSON.stringify(marker)}, "run\\n"); setInterval(() => {}, 1000);`;
    writeAgentConfig(hangScript);
    reloadConfig(configPath);
    const taskDir = writePendingTask("task-agent-timeout", 1);

    const startedAt = Date.now();
    const result = await runTask("task-agent-timeout");

    assert.equal(result.status, "timeout");
    assert.ok(Date.now() - startedAt < 18_000, "timeout cleanup must remain bounded");
    const status = JSON.parse(readFileSync(join(taskDir, "status.json"), "utf-8"));
    assert.equal(status.status, "timeout");
    assert.equal(status.phase, "timeout");
    assert.equal(existsSync(join(taskDir, "result.json")), true);
    assert.equal(existsSync(join(taskDir, "verify.json")), true);
    assert.equal(existsSync(join(taskDir, "test.log")), true);
  });

  it("converges a running cancellation within the grace period", { timeout: 20_000 }, async () => {
    const hangScript = `require("node:fs").appendFileSync(${JSON.stringify(marker)}, "run\\n"); setInterval(() => {}, 1000);`;
    writeAgentConfig(hangScript);
    reloadConfig(configPath);
    const taskDir = writePendingTask("task-agent-cancel", 20);
    const running = runTask("task-agent-cancel");
    const deadline = Date.now() + 5_000;
    while (!existsSync(marker) && Date.now() < deadline) await sleep(25);
    assert.equal(existsSync(marker), true, "agent did not start before cancellation");

    const requested = cancelTask("task-agent-cancel");
    assert.equal(requested.cancel_requested, true);
    const result = await running;

    assert.equal(result.status, "canceled");
    const status = JSON.parse(readFileSync(join(taskDir, "status.json"), "utf-8"));
    assert.equal(status.status, "canceled");
    assert.equal(status.phase, "canceled");
  });
});
