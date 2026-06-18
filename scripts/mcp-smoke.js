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
    "create_task",
    "get_diff",
    "get_plan",
    "get_result",
    "get_task_status",
    "get_test_log",
    "list_workspace",
    "read_workspace_file",
    "save_plan",
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

  const plan = await parseToolJson("save_plan", {
    title: "MCP smoke",
    content: "# Smoke\n\nVerify MCP tool calls.",
  });
  const readPlan = await parseToolJson("get_plan", { plan_id: plan.plan_id });
  if (!readPlan.content.includes("Verify MCP tool calls.")) {
    throw new Error("saved plan content was not readable");
  }
  ok("save_plan and get_plan work");

  const task = await parseToolJson("create_task", {
    plan_id: plan.plan_id,
    agent: "codex",
    test_command: "npm test",
  });
  const status = await parseToolJson("get_task_status", { task_id: task.task_id });
  if (status.status !== "pending") {
    throw new Error(`expected pending task, got ${status.status}`);
  }
  ok("create_task and get_task_status work");

  const file = await parseToolJson("read_workspace_file", { path: "hello.txt" });
  if (!file.content.includes("hello from mcp smoke")) {
    throw new Error("workspace file content mismatch");
  }
  ok("read_workspace_file reads normal files");

  await expectToolError(client, "read_workspace_file", { path: ".env" }, "sensitive file");
  await expectToolError(
    client,
    "read_workspace_file",
    { path: "../outside.txt" },
    "path escape"
  );
  ok("sensitive file and path escape checks reject access");

  await client.close();

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
  for (const fileName of ["result.md", "git.diff", "test.log"]) {
    if (!existsSync(join(task.path, fileName))) {
      throw new Error(`runner did not create ${fileName}`);
    }
  }
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
