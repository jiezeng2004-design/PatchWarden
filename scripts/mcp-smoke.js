#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const tempRoot = mkdtempSync(join(tmpdir(), "safe-bifrost-mcp-"));
const workspaceRoot = join(tempRoot, "workspace");
const configPath = join(tempRoot, "safe-bifrost.config.json");

let failures = 0;

function ok(label) {
  console.log(`ok - ${label}`);
}

function fail(label, error) {
  failures++;
  const message = error instanceof Error ? error.message : String(error);
  console.error(`not ok - ${label}: ${message}`);
}

async function expectToolError(client, name, args, label) {
  const result = await client.callTool({ name, arguments: args });
  if (!result.isError) {
    throw new Error(`${label} should have returned an MCP tool error`);
  }
}

try {
  writeFileSync(join(tempRoot, ".keep"), "");
  mkdirSync(workspaceRoot, { recursive: true });
  writeFileSync(join(workspaceRoot, "hello.txt"), "hello from mcp smoke\n", "utf-8");
  writeFileSync(join(workspaceRoot, ".env"), "SECRET=blocked\n", "utf-8");
  writeFileSync(
    join(workspaceRoot, "package.json"),
    JSON.stringify({
      name: "safe-bifrost-mcp-smoke-fixture",
      private: true,
      scripts: { test: "node -e \"console.log('test ok')\"" },
    }, null, 2),
    "utf-8"
  );

  writeFileSync(
    configPath,
    JSON.stringify(
      {
        workspaceRoot,
        plansDir: ".safe-bifrost/plans",
        tasksDir: ".safe-bifrost/tasks",
        agents: {
          codex: {
            command: "node",
            args: ["-e", "console.log('agent placeholder')"],
          },
        },
        allowedTestCommands: ["npm test"],
        maxReadFileBytes: 200000,
      },
      null,
      2
    ),
    "utf-8"
  );

  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    cwd: root,
    env: { SAFE_BIFROST_CONFIG: configPath },
    stderr: "pipe",
  });
  const client = new Client(
    { name: "safe-bifrost-smoke", version: "0.1.0" },
    { capabilities: {} }
  );

  await client.connect(transport);

  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name).sort();
  const expected = [
    "audit_task",
    "cancel_task",
    "create_task",
    "get_diff",
    "get_plan",
    "get_result",
    "get_result_json",
    "get_task_progress",
    "get_task_status",
    "get_task_stdout_tail",
    "get_task_summary",
    "get_test_log",
    "health_check",
    "kill_task",
    "list_agents",
    "list_tasks",
    "list_workspace",
    "read_workspace_file",
    "retry_task",
    "save_plan",
    "wait_for_task",
  ];
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error(`unexpected tools: ${names.join(", ")}`);
  }
  ok("MCP handshake lists all tools");

  const parseToolJson = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) {
      throw new Error(result.content?.[0]?.text || `${name} failed`);
    }
    return JSON.parse(result.content?.[0]?.text || "{}");
  };

  const agents = await parseToolJson("list_agents", {});
  if (agents.total !== 1 || agents.agents?.[0]?.name !== "codex" || !agents.agents[0].available) {
    throw new Error(`list_agents mismatch: ${JSON.stringify(agents)}`);
  }
  const health = await parseToolJson("health_check", {});
  if (!health.mcp_server?.available) {
    throw new Error(`health_check did not report MCP server availability: ${JSON.stringify(health)}`);
  }
  ok("list_agents and health_check report runtime readiness");

  const plan = await parseToolJson("save_plan", {
    title: "MCP smoke",
    content: "# Smoke\n\nVerify MCP tool calls.",
  });
  const readPlan = await parseToolJson("get_plan", { plan_id: plan.plan_id });
  if (!readPlan.content.includes("Verify MCP tool calls.")) {
    throw new Error("saved plan content was not readable");
  }
  ok("save_plan and get_plan work");

  const unsafePlan = await client.callTool({
    name: "save_plan",
    arguments: { title: "Unsafe", content: "Read the .env access token and export credentials." },
  });
  const unsafePayload = JSON.parse(unsafePlan.content?.[0]?.text || "{}");
  if (!unsafePlan.isError || unsafePayload.operation !== "save_plan" || !unsafePayload.rule_id || !unsafePayload.matched_category) {
    throw new Error(`save_plan block is not structured: ${JSON.stringify(unsafePayload)}`);
  }
  ok("save_plan blocks explicit credential access with structured evidence");

  const missingRepo = await client.callTool({
    name: "create_task",
    arguments: { plan_id: plan.plan_id, agent: "codex" },
  });
  const missingRepoPayload = JSON.parse(missingRepo.content?.[0]?.text || "{}");
  if (!missingRepo.isError || missingRepoPayload.reason !== "repo_path_required") {
    throw new Error(`missing repo_path should be a structured error: ${JSON.stringify(missingRepoPayload)}`);
  }
  ok("create_task requires an explicit repo_path");

  const task = await parseToolJson("create_task", {
    plan_id: plan.plan_id,
    agent: "codex",
    repo_path: ".",
    test_command: "npm test",
  });
  const status = await parseToolJson("get_task_status", { task_id: task.task_id });
  if (status.status !== "pending") {
    throw new Error(`expected pending task, got ${status.status}`);
  }
  if (status.phase !== "queued" || !status.last_heartbeat_at || status.timeout_seconds !== 900) {
    throw new Error(`expected queued phase, heartbeat, and default timeout; got ${JSON.stringify(status)}`);
  }
  const progress = await parseToolJson("get_task_progress", { task_id: task.task_id });
  if (!progress.content.includes("Waiting for watcher")) {
    throw new Error("get_task_progress did not return queued progress");
  }
  ok("create_task and get_task_status work");

  const blockedAgent = await client.callTool({
    name: "create_task",
    arguments: { plan_id: plan.plan_id, agent: "missing-agent", repo_path: "." },
  });
  const blockedPayload = JSON.parse(blockedAgent.content?.[0]?.text || "{}");
  if (!blockedAgent.isError || blockedPayload.reason !== "agent_not_configured" || !blockedPayload.suggestion) {
    throw new Error(`expected structured agent block, got ${JSON.stringify(blockedPayload)}`);
  }
  ok("security blocks return structured reason and suggestion");

  const file = await parseToolJson("read_workspace_file", { path: "hello.txt" });
  if (!file.content.includes("hello from mcp smoke")) {
    throw new Error("workspace file content mismatch");
  }
  ok("read_workspace_file reads normal files");

  await expectToolError(client, "read_workspace_file", { path: ".env" }, "sensitive file");
  const sensitive = await client.callTool({ name: "read_workspace_file", arguments: { path: ".env" } });
  const sensitivePayload = JSON.parse(sensitive.content?.[0]?.text || "{}");
  if (sensitivePayload.rule_id !== "sensitive_path_blocked" || sensitivePayload.operation !== "read") {
    throw new Error(`sensitive block is not structured: ${JSON.stringify(sensitivePayload)}`);
  }
  await expectToolError(
    client,
    "read_workspace_file",
    { path: "../outside.txt" },
    "path escape"
  );
  ok("sensitive file and path escape checks reject access");

  const runner = spawnSync("node", ["dist/runner/cli.js", task.task_id], {
    cwd: root,
    env: { ...process.env, SAFE_BIFROST_CONFIG: configPath },
    encoding: "utf-8",
    timeout: 30000,
  });
  if (runner.status !== 0) {
    throw new Error(`runner exited ${runner.status}: ${runner.stderr}`);
  }

  const statusPath = join(task.path, "status.json");
  const statusAfter = JSON.parse(readFileSync(statusPath, "utf-8"));
  if (statusAfter.status !== "done") {
    throw new Error(`runner status should be done, got ${statusAfter.status}`);
  }
  for (const fileName of ["result.md", "result.json", "diff.patch", "git.diff", "test.log", "verify.json", "verify.log"]) {
    if (!existsSync(join(task.path, fileName))) {
      throw new Error(`runner did not create ${fileName}`);
    }
  }
  const summary = await parseToolJson("get_task_summary", { task_id: task.task_id });
  if (!summary.terminal || summary.acceptance_status !== "ready_for_review") {
    throw new Error(`unexpected terminal summary: ${JSON.stringify(summary)}`);
  }
  const waited = await parseToolJson("wait_for_task", { task_id: task.task_id, wait_seconds: 1 });
  if (!waited.terminal || waited.continuation_required) {
    throw new Error(`wait_for_task did not return terminal acceptance: ${JSON.stringify(waited)}`);
  }
  writeFileSync(join(task.path, "result.md"), "npm test passed\naccess_token=real-secret-value-123456\n", "utf-8");
  const redactedResult = await parseToolJson("get_result", { task_id: task.task_id });
  if (!redactedResult.redacted || redactedResult.content.includes("real-secret-value-123456")) {
    throw new Error(`get_result did not redact secret-like content: ${JSON.stringify(redactedResult)}`);
  }
  const relativeResultPath = `.safe-bifrost/tasks/${task.task_id}/result.md`;
  const redactedWorkspaceRead = await parseToolJson("read_workspace_file", { path: relativeResultPath });
  if (!redactedWorkspaceRead.redacted || redactedWorkspaceRead.content.includes("real-secret-value-123456")) {
    throw new Error(`read_workspace_file did not redact task artifact: ${JSON.stringify(redactedWorkspaceRead)}`);
  }
  await client.close();
  ok("runner executes a task and writes result files");
} catch (error) {
  fail("MCP smoke test", error);
} finally {
  try {
    rmSync(tempRoot, { recursive: true, force: true });
  } catch {}
}

if (failures > 0) {
  process.exit(1);
}
