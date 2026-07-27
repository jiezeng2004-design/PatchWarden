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
import { classifyAgentFailure, classifyAgentFailureDetails, runTask } from "../../../runner/runTask.js";
import { cancelTask } from "../../../tools/tasks/cancelTask.js";
import { auditTask } from "../../../tools/diagnostics/auditTask.js";
import { acceptSubgoal } from "../../../goal/goalProgress.js";
import { createGoal, readGoalStatus, writeGoalStatus } from "../../../goal/goalStore.js";
import { addSubgoal, linkTaskToSubgoal, updateSubgoalStatus } from "../../../goal/goalStatus.js";
import { safeResult, safeTestSummary } from "../../../tools/diagnostics/safeViews.js";
import { getTaskSummary } from "../../../tools/tasks/getTaskSummary.js";

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
      allowedTestCommands: ["node --check main.js"],
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

    assert.equal(results.filter((result) => result.status === "done_by_agent").length, 1, JSON.stringify(results));
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

  it("moves a queued subgoal to needs_fix when its pending task is canceled", () => {
    const { goal_id: goalId } = createGoal("repo", "Canceled queued task", "fixture", root);
    const initial = readGoalStatus(goalId, root);
    const added = addSubgoal(initial, "Queued work");
    const queued = updateSubgoalStatus(
      linkTaskToSubgoal(added.goalStatus, added.subgoalId, "task-canceled-subgoal"),
      added.subgoalId,
      "queued",
    );
    writeGoalStatus(goalId, queued, root);
    writeGoalTask("task-canceled-subgoal", "fixture", goalId, added.subgoalId);

    const canceled = cancelTask("task-canceled-subgoal");

    assert.equal(canceled.new_status, "canceled");
    const subgoal = readGoalStatus(goalId, root).subgoals[0];
    assert.equal(subgoal.status, "needs_fix");
    assert.equal(subgoal.last_task_status, "canceled");
    assert.equal(subgoal.last_task_id, "task-canceled-subgoal");
  });

  it("converges a running agent to the timeout terminal state", { timeout: 20_000 }, async () => {
    const hangScript = `require("node:fs").appendFileSync(${JSON.stringify(marker)}, "run\\n"); setInterval(() => {}, 1000);`;
    writeAgentConfig(hangScript);
    reloadConfig(configPath);
    const taskDir = writePendingTask("task-agent-timeout", 1);

    const startedAt = Date.now();
    const result = await runTask("task-agent-timeout");

    assert.equal(result.status, "timeout", result.error || "missing error");
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

  it("classifies provider readiness failures without exposing provider details", () => {
    assert.equal(classifyAgentFailure("Error: Insufficient balance. Manage billing."), "provider_insufficient_balance");
    assert.equal(classifyAgentFailure("Authentication failed: invalid API key"), "provider_authentication_failed");
    assert.equal(classifyAgentFailure("403 permission denied"), "provider_permission_denied");
    assert.equal(classifyAgentFailure("429 rate limit exceeded"), "provider_rate_limited");
    assert.equal(classifyAgentFailure("Unexpected server error (HTTP 500)"), "provider_server_error");
    assert.equal(classifyAgentFailure("service overloaded"), "provider_unavailable");
    assert.equal(classifyAgentFailure("upstream timeout"), "provider_timeout");
    assert.equal(classifyAgentFailure("Unknown option --bad"), "cli_configuration_error");
    assert.equal(classifyAgentFailure("ERR_UNKNOWN_FILE_EXTENSION .exe"), "cli_configuration_error");
    assert.equal(classifyAgentFailure("model not found"), "model_not_found");
    assert.equal(classifyAgentFailure("invalid argument for --model: contains spaces"), "invalid_model_argument");
    assert.equal(classifyAgentFailure("There's an issue with the selected model. It may not exist or you may not have access to it."), "model_not_found");
    assert.equal(classifyAgentFailure("fetch failed ECONNRESET"), "network_error");
    assert.equal(classifyAgentFailure("failed to launch child process"), "agent_process_error");
    assert.equal(classifyAgentFailure("ordinary non-zero exit"), "unknown");
    assert.deepEqual(classifyAgentFailureDetails("Unexpected server error err_agnes_ABC-123"), {
      failure_category: "provider_server_error",
      provider_error_reference: "err_agnes_ABC-123",
    });
    assert.equal(classifyAgentFailureDetails("Unexpected server error error-reference-secret").provider_error_reference, null);
  });

  it("classifies provider failures written only to Agent stdout", async () => {
    writeAgentConfig(`process.stdout.write("There's an issue with the selected model. It may not exist or you may not have access to it."); process.exit(1);`);
    reloadConfig(configPath);
    const taskDir = writePendingTask("task-provider-stdout");

    const result = await runTask("task-provider-stdout");
    const status = JSON.parse(readFileSync(join(taskDir, "status.json"), "utf-8"));

    assert.equal(result.status, "failed");
    assert.equal(status.agent_failure_category, "model_not_found");
    assert.match(result.error || "", /model_not_found/);
  });

  it("preserves configured verification evidence when the Agent fails before verification", async () => {
    writeAgentConfig(`process.stderr.write("Unexpected server error HTTP 503 err_agnes_SAFE123"); process.exit(1);`);
    reloadConfig(configPath);
    const taskDir = writePendingTask("task-provider-before-verify");
    const statusPath = join(taskDir, "status.json");
    const pending = JSON.parse(readFileSync(statusPath, "utf-8"));
    pending.verify_commands = ["node --check main.js"];
    writeFileSync(statusPath, JSON.stringify(pending), "utf-8");

    await runTask("task-provider-before-verify");
    const status = JSON.parse(readFileSync(statusPath, "utf-8"));
    const result = JSON.parse(readFileSync(join(taskDir, "result.json"), "utf-8"));
    const verify = JSON.parse(readFileSync(join(taskDir, "verify.json"), "utf-8"));
    const summary = getTaskSummary("task-provider-before-verify");
    const safeTests = safeTestSummary("task-provider-before-verify");
    const safe = safeResult("task-provider-before-verify");
    const audit = auditTask("task-provider-before-verify");

    assert.equal(status.failure_category, "provider_server_error");
    assert.equal(status.agent_failure_category, "provider_server_error");
    assert.equal(status.provider_error_reference, "err_agnes_SAFE123");
    assert.equal(verify.status, "not_run");
    assert.equal(verify.reason, "agent_failed_before_verification");
    assert.deepEqual(verify.configured_commands, ["node --check main.js"]);
    assert.deepEqual(verify.requested_commands, ["node --check main.js"]);
    assert.deepEqual(verify.commands, []);
    assert.deepEqual(result.verify_commands, ["node --check main.js"]);
    assert.deepEqual(result.executed_verify_commands, []);
    assert.deepEqual(summary.verify_commands, ["node --check main.js"]);
    assert.deepEqual(summary.executed_verify_commands, []);
    assert.deepEqual(safeTests.configured_commands, ["node --check main.js"]);
    assert.deepEqual(safeTests.executed_verify_commands, []);
    assert.equal(safe.verification.reason, "agent_failed_before_verification");
    assert.equal(safe.failure_category, "provider_server_error");
    assert.equal(safe.provider_error_reference, "err_agnes_SAFE123");
    assert.equal(audit.failure_category, "provider_server_error");
    assert.equal(audit.provider_error_reference, "err_agnes_SAFE123");
  });

  it("completes two queued subgoals with two deterministic Agents in serial", { timeout: 30_000 }, async () => {
    writeFileSync(join(repo, "main.js"), "const ready = true;\n", "utf-8");
    const agentScript = "process.exit(0)";
    writeFileSync(configPath, JSON.stringify({
      workspaceRoot: root,
      plansDir: ".patchwarden/plans",
      tasksDir: ".patchwarden/tasks",
      agents: {
        alpha: { command: process.execPath, args: ["-e", agentScript, "{prompt}"] },
        beta: { command: process.execPath, args: ["-e", agentScript, "{prompt}"] },
      },
      allowedTestCommands: ["node --check main.js"],
      defaultTaskTimeoutSeconds: 10,
      maxTaskTimeoutSeconds: 30,
    }), "utf-8");
    reloadConfig(configPath);

    const { goal_id: goalId } = createGoal("repo", "Two Agent Goal", "serial fixture", root);
    let goal = readGoalStatus(goalId, root);
    const first = addSubgoal(goal, "Alpha work");
    goal = updateSubgoalStatus(linkTaskToSubgoal(first.goalStatus, first.subgoalId, "task-agent-alpha"), first.subgoalId, "queued");
    const second = addSubgoal(goal, "Beta work", [first.subgoalId]);
    goal = updateSubgoalStatus(linkTaskToSubgoal(second.goalStatus, second.subgoalId, "task-agent-beta"), second.subgoalId, "queued");
    writeGoalStatus(goalId, goal, root);

    writeGoalTask("task-agent-alpha", "alpha", goalId, first.subgoalId);
    writeGoalTask("task-agent-beta", "beta", goalId, second.subgoalId);

    const firstResult = await runTask("task-agent-alpha");
    assert.equal(firstResult.status, "done_by_agent", firstResult.error || "missing error");
    assert.equal(readGoalStatus(goalId, root).subgoals[0].status, "done_by_agent");
    assert.equal(auditTask("task-agent-alpha").acceptance.status, "accepted");
    acceptSubgoal(goalId, first.subgoalId, root);

    const secondResult = await runTask("task-agent-beta");
    assert.equal(secondResult.status, "done_by_agent");
    assert.equal(auditTask("task-agent-beta").acceptance.status, "accepted");
    acceptSubgoal(goalId, second.subgoalId, root);

    const completed = readGoalStatus(goalId, root);
    assert.equal(completed.status, "completed");
    assert.deepEqual(completed.subgoals.map((subgoal) => subgoal.status), ["accepted", "accepted"]);
    assert.deepEqual(completed.subgoals.map((subgoal) => subgoal.last_task_status), ["done_by_agent", "done_by_agent"]);
  });

  function writeGoalTask(taskId: string, agent: string, goalId: string, subgoalId: string): void {
    const taskDir = join(root, ".patchwarden", "tasks", taskId);
    mkdirSync(taskDir, { recursive: true });
    const now = new Date().toISOString();
    writeFileSync(join(taskDir, "status.json"), JSON.stringify({
      task_id: taskId,
      plan_id: "plan-claim",
      agent,
      repo_path: "repo",
      resolved_repo_path: repo,
      workspace_root: root,
      status: "pending",
      phase: "queued",
      timeout_seconds: 10,
      test_command: "node --check main.js",
      verify_commands: ["node --check main.js"],
      change_policy: "repo_scoped_changes",
      goal_id: goalId,
      subgoal_id: subgoalId,
      created_at: now,
      updated_at: now,
    }), "utf-8");
  }
});
