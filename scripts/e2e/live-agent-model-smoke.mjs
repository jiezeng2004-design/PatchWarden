#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const liveConfigPath = process.env.PATCHWARDEN_LIVE_CONFIG;
if (!liveConfigPath) throw new Error("PATCHWARDEN_LIVE_CONFIG is required.");

const runtimeRoot = resolve(process.env.PATCHWARDEN_RUNTIME_ROOT || join(process.cwd(), "release", "desktop", "win-unpacked", "resources", "core"));
const workspaceRoot = resolve(process.env.PATCHWARDEN_SMOKE_WORKSPACE || "D:/ai_agent/patchwarden_program");
const repoPath = process.env.PATCHWARDEN_SMOKE_REPO || "patchwarden-demo-fixture";
const repo = resolve(workspaceRoot, repoPath);
if (!existsSync(join(runtimeRoot, "dist", "version.js"))) throw new Error("Packaged PatchWarden runtime is required.");
if (!existsSync(join(repo, "package.json"))) throw new Error("PATCHWARDEN_SMOKE_REPO must identify the demo fixture.");

const coreImport = (path) => import(pathToFileURL(join(runtimeRoot, path)).href);
const { getTasksDir, reloadConfig } = await coreImport("dist/config.js");
const { createTask } = await coreImport("dist/tools/tasks/createTask.js");
const { runTask } = await coreImport("dist/runner/runTask.js");
const { runTaskLoop } = await coreImport("dist/tools/tasks/runTaskLoop.js");
const { waitForTask } = await coreImport("dist/tools/tasks/waitForTask.js");
const { getTaskLineage } = await coreImport("dist/tools/tasks/taskLineage.js");
const { readWatcherStatus } = await coreImport("dist/watcherStatus.js");
const { PATCHWARDEN_VERSION } = await coreImport("dist/version.js");
const { buildAgentRegistration, detectAgents } = await import("../../desktop/dist/agent-detection.js");

const liveConfig = reloadConfig(liveConfigPath);
const requestedAgents = process.env.PATCHWARDEN_SMOKE_AGENTS
  ? process.env.PATCHWARDEN_SMOKE_AGENTS.split(",").map((value) => value.trim()).filter(Boolean)
  : ["codex", "claude", "opencode"];
const detections = new Map((await detectAgents()).map((detection) => [detection.id, detection]));
const agents = Object.fromEntries(requestedAgents.flatMap((name) => {
  const liveAgent = liveConfig.agents[name];
  const detection = detections.get(name);
  if (!liveAgent || !detection?.available) return [];
  const registration = buildAgentRegistration(name, detection, liveAgent.model || null);
  return [[name, {
    ...registration,
    ...(liveAgent.envAllowlist ? { envAllowlist: liveAgent.envAllowlist } : {}),
  }]];
}));
const timestamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
const root = mkdtempSync(join(process.cwd(), ".tmp", `live-agent-smoke-${timestamp}-`));
const evidenceRoot = join(".patchwarden", "acceptance", basename(root));
const fixtureBefore = fingerprintDirectory(repo);

const configPath = join(root, "patchwarden.config.json");
writeFileSync(configPath, `${JSON.stringify({
  workspaceRoot,
  plansDir: join(evidenceRoot, "plans"),
  tasksDir: join(evidenceRoot, "tasks"),
  assessmentsDir: join(evidenceRoot, "assessments"),
  agents,
  allowedTestCommands: ["npm test"],
  defaultTaskTimeoutSeconds: 180,
  maxTaskTimeoutSeconds: 240,
  watcherStaleSeconds: 30,
}, null, 2)}\n`, "utf-8");
process.env.PATCHWARDEN_CONFIG = configPath;
reloadConfig(configPath);

const results = [];
for (const agent of requestedAgents) {
  if (!agents[agent]) {
    results.push({ agent, available: false, task_status: "not_configured" });
    continue;
  }
  try {
    const created = await createTask({
      template: "inspect_only",
      goal: "Inspect README.md and package.json only. Do not modify files. Return one concise verification sentence.",
      agent,
      repo_path: repoPath,
      verify_commands: ["npm test"],
      timeout_seconds: 180,
      execution_mode: "execute",
    });
    const taskId = created.task_id;
    const run = await runTask(taskId);
    const status = readTaskStatus(taskId);
    results.push({
      agent,
      available: true,
      task_id: taskId,
      task_status: run.status,
      provider_failure_category: status.agent_failure_category || null,
      error_present: Boolean(run.error),
      agent_runtime: status.agent_runtime || null,
    });
  } catch (error) {
    results.push({
      agent,
      available: true,
      task_status: "runtime_exception",
      provider_failure_category: "unclassified_external_failure",
      error_present: true,
    });
  }
}

let watcher = null;
let loop = null;
let watcherStatus = null;
if (agents.opencode && process.env.PATCHWARDEN_SMOKE_SKIP_LOOP !== "1") {
  try {
    watcher = spawn(process.execPath, [join(runtimeRoot, "dist", "runner", "watch.js")], {
      cwd: runtimeRoot,
      env: { ...process.env, PATCHWARDEN_CONFIG: configPath },
      stdio: "ignore",
      windowsHide: true,
    });
    watcherStatus = await waitForWatcher();
    const startedAt = Date.now();
    const output = await runTaskLoop({
      repo_path: repoPath,
      goal: "Inspect README.md only and make no repository changes.",
      verify_commands: ["npm test"],
      agent: "opencode",
      template: "inspect_only",
      max_iterations: 1,
      task_timeout_seconds: 180,
      isolation_mode: "current_repo",
      request_id: `acceptance_${timestamp}`,
    });
    const returnDurationMs = Date.now() - startedAt;
    const mainTask = output.tasks.main;
    const mainResult = mainTask ? await waitForTerminal(mainTask) : null;
    const lineage = await waitForLineage(output.lineage_id);
    loop = {
      request_id: output.request_id,
      lineage_id: output.lineage_id,
      async_return_duration_ms: returnDurationMs,
      queued_status: output.final_status,
      queued_stop_reason: output.stop_reason,
      main_task: mainTask,
      main_task_status: mainResult?.status || null,
      final_status: lineage.final_status,
      stop_reason: lineage.stop_reason,
      created_task_count: [lineage.tasks.main, ...lineage.tasks.fix, ...lineage.tasks.cleanup].filter(Boolean).length,
      rounds: lineage.rounds.map((round) => ({
        role: round.role,
        task_status: round.status,
        audit_verdict: round.audit_verdict,
      })),
    };
  } catch (error) {
    loop = {
      final_status: "external_failure",
      stop_reason: "watcher_or_provider_unavailable",
      created_task_count: 0,
      error_present: true,
    };
  } finally {
    if (watcher && watcher.exitCode === null) watcher.kill("SIGTERM");
  }
}

const opencode = results.find((result) => result.agent === "opencode");
const fixtureAfter = fingerprintDirectory(repo);
const summary = {
  packaged_runtime_root: runtimeRoot,
  server_version: PATCHWARDEN_VERSION,
  workspace_root: workspaceRoot,
  fixture_repo: repo,
  fixture_root: root,
  fixture_files_unchanged: fixtureBefore === fixtureAfter,
  watcher: watcherStatus ? {
    status: watcherStatus.status,
    available: watcherStatus.available,
  } : null,
  agents: results,
  opencode_model_evidence_ok: opencode?.agent_runtime?.effective_model === "agnes/agnes-2.0-flash"
    && opencode.agent_runtime.model_argument_present === true,
  run_task_loop: loop,
};
const summaryPath = join(root, "live-smoke-summary.json");
writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf-8");
console.log(JSON.stringify({ ...summary, summary_path: summaryPath }, null, 2));

function readTaskStatus(taskId) {
  return JSON.parse(readFileSync(join(getTasksDir(reloadConfig(configPath)), taskId, "status.json"), "utf-8"));
}

async function waitForWatcher() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const status = readWatcherStatus(reloadConfig(configPath));
    if (status.available && status.status === "healthy") return status;
    await sleep(100);
  }
  throw new Error("isolated watcher did not become healthy");
}

async function waitForTerminal(taskId) {
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    const result = await waitForTask(taskId, 30);
    if (!result.continuation_required) return result;
  }
  throw new Error("timed out waiting for loop main task");
}

async function waitForLineage(lineageId) {
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    const lineage = getTaskLineage(lineageId);
    if (lineage.final_status !== "running") return lineage;
    await sleep(100);
  }
  throw new Error("timed out waiting for task lineage");
}

function fingerprintDirectory(directory) {
  const hash = createHash("sha256");
  const visit = (current) => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      const relativePath = relative(directory, path).replaceAll("\\", "/");
      const stat = lstatSync(path);
      hash.update(relativePath);
      hash.update("\0");
      if (stat.isSymbolicLink()) {
        hash.update("symlink");
      } else if (stat.isDirectory()) {
        visit(path);
      } else if (stat.isFile()) {
        hash.update(readFileSync(path));
      }
      hash.update("\0");
    }
  };
  visit(directory);
  return hash.digest("hex");
}
