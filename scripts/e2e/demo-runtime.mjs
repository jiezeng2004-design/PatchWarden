#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const runtimeRoot = resolve(process.env.PATCHWARDEN_RUNTIME_ROOT || join(import.meta.dirname, "..", "..", "release", "desktop", "win-unpacked", "resources", "core"));
const configPath = resolve(process.env.PATCHWARDEN_CONFIG || join(process.env.LOCALAPPDATA || "", "PatchWarden", "patchwarden.config.json"));
const fixture = resolve(process.env.PATCHWARDEN_DEMO_FIXTURE || join(process.env.PATCHWARDEN_WORKSPACE || "D:/ai_agent/patchwarden_program", "patchwarden-demo-fixture"));
const evidencePath = resolve(process.env.PATCHWARDEN_DEMO_EVIDENCE || join(process.env.PATCHWARDEN_WORKSPACE || "D:/ai_agent/patchwarden_program", ".patchwarden", "demo-runtime-evidence.json"));
const mode = process.argv[2] || "core-prepare";
const profile = mode === "direct" ? "chatgpt_direct" : "chatgpt_core";

function decode(result) {
  if (result?.isError) {
    const message = result.content?.find((item) => item.type === "text")?.text || "MCP tool error";
    throw new Error(message);
  }
  const text = result?.content?.find((item) => item.type === "text")?.text;
  if (typeof text !== "string") return result;
  try { return JSON.parse(text); } catch { return { text }; }
}

async function connect() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(runtimeRoot, "dist", "index.js")],
    cwd: runtimeRoot,
    env: {
      ...process.env,
      PATCHWARDEN_CONFIG: configPath,
      PATCHWARDEN_TOOL_PROFILE: profile,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "patchwarden-demo-e2e", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

async function call(client, name, args = {}) {
  return decode(await client.callTool({ name, arguments: args }));
}

async function waitForTask(client, taskId) {
  for (;;) {
    const result = await call(client, "wait_for_task", { task_id: taskId, wait_seconds: 30 });
    if (!result?.continuation_required) return result;
  }
}

function saveEvidence(value) {
  mkdirSync(resolve(evidencePath, ".."), { recursive: true });
  writeFileSync(evidencePath, JSON.stringify(value, null, 2), "utf8");
}

function loadEvidence() {
  return JSON.parse(readFileSync(evidencePath, "utf8"));
}

async function runCorePrepare(client) {
  const health = await call(client, "health_check", { detail: "self_diagnostic" });
  const agents = await call(client, "list_agents");
  const ordinary = await call(client, "create_task", {
    template: "inspect_only",
    goal: "Read the Demo fixture README and package.json, run the configured tests, and return a short verification summary. Do not modify files.",
    repo_path: "patchwarden-demo-fixture",
    agent: "codex",
    verify_commands: ["npm test", "npm run lint"],
    timeout_seconds: 180,
  });
  const ordinarySummary = await waitForTask(client, ordinary.task_id);
  const ordinaryAudit = await call(client, "audit_task", { task_id: ordinary.task_id });
  const assessmentArgs = {
    execution_mode: "assess_only",
    template: "inspect_only",
    goal: "Read the Demo fixture README and package.json, run npm test and npm run lint, and return a short verification summary. Do not modify files.",
    repo_path: "patchwarden-demo-fixture",
    agent: "codex",
    verify_commands: ["npm test", "npm run lint"],
    timeout_seconds: 180,
  };
  const assessmentBeforeRestart = await call(client, "create_task", assessmentArgs);
  const assessmentPolicyChange = await call(client, "create_task", assessmentArgs);
  saveEvidence({
    created_at: new Date().toISOString(),
    profile,
    runtime_root: runtimeRoot,
    config_path: configPath,
    fixture,
    health,
    agents,
    ordinary_task_id: ordinary.task_id,
    ordinary_summary: ordinarySummary,
    ordinary_audit: ordinaryAudit,
    assessment_before_restart: assessmentBeforeRestart,
    assessment_policy_change: assessmentPolicyChange,
  });
  console.log(JSON.stringify({ ordinary_task_id: ordinary.task_id, assessment_before_restart: assessmentBeforeRestart, assessment_policy_change: assessmentPolicyChange }, null, 2));
}

async function runCoreExecute(client) {
  const evidence = loadEvidence();
  const first = evidence.assessment_before_restart;
  const second = evidence.assessment_policy_change;
  const execute = await call(client, "create_task", { execution_mode: "execute", assessment_id: first.assessment_id });
  const summary = await waitForTask(client, execute.task_id);
  const audit = await call(client, "audit_task", { task_id: execute.task_id });
  const policyDir = join(fixture, ".patchwarden");
  mkdirSync(policyDir, { recursive: true });
  writeFileSync(join(policyDir, "project-policy.json"), JSON.stringify({ allowed_commands: ["node --check main.js"] }, null, 2), "utf8");
  let stale = null;
  try {
    stale = await call(client, "create_task", { execution_mode: "execute", assessment_id: second.assessment_id });
  } catch (error) {
    stale = { error: error instanceof Error ? error.message : String(error) };
  }
  saveEvidence({ ...evidence, execute_task_id: execute.task_id, execute_summary: summary, execute_audit: audit, stale_after_policy_change: stale });
  console.log(JSON.stringify({ execute_task_id: execute.task_id, execute_summary: summary, execute_audit: audit, stale_after_policy_change: stale }, null, 2));
}

async function runDirect(client) {
  const health = await call(client, "health_check", { detail: "self_diagnostic" });
  const session = await call(client, "create_direct_session", { repo_path: "patchwarden-demo-fixture", title: "PatchWarden Demo Direct verification" });
  const file = await call(client, "read_workspace_file", { session_id: session.session_id, path: "main.js" });
  const verification = await call(client, "run_direct_verification_bundle", {
    session_id: session.session_id,
    commands: ["npm test", "npm run lint", "node --check main.js"],
    timeout_seconds: 120,
  });
  const finalized = await call(client, "finalize_direct_session", { session_id: session.session_id });
  const audit = await call(client, "audit_session", { session_id: session.session_id });
  saveEvidence({ direct_health: health, direct_session_id: session.session_id, direct_file: { sha256: file.sha256, bytes: file.bytes }, direct_verification: verification, direct_finalized: finalized, direct_audit: audit });
  console.log(JSON.stringify({ direct_session_id: session.session_id, direct_verification: verification, direct_audit: audit }, null, 2));
}

async function runStatus(client) {
  const health = await call(client, "health_check", { detail: "self_diagnostic" });
  const agents = await call(client, "list_agents");
  const tasks = await call(client, "list_tasks", { active_only: true, limit: 50 });
  console.log(JSON.stringify({ health, agents, active_tasks: tasks }, null, 2));
}

const client = await connect();
try {
  if (mode === "core-prepare") await runCorePrepare(client);
  else if (mode === "core-execute") await runCoreExecute(client);
  else if (mode === "direct") await runDirect(client);
  else if (mode === "status") await runStatus(client);
  else throw new Error(`Unsupported demo mode: ${mode}`);
} finally {
  await client.close();
}
