import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { errorMessage, fileMtimeIso, readJsonFileSafe, readTextFileSafe, readFileTail, findLatestLog, resolveTailParam, sendJson } from "./helpers.js";
import { getControlCenterLogDir, getRuntimeRoot, CORE_BASE_URL, DIRECT_BASE_URL, DEFAULT_TUNNEL_CLIENT_EXE } from "./constants.js";
import { probeRuntimeHealth, readTunnelStatus, readToolManifest, readTunnelUrl, type RuntimeHealth } from "./healthProbing.js";
import { classifyStaleTask, augmentTaskWithStale, listTasksForStatus, TERMINAL_TASK_STATUSES, type StaleClassification, type StatusTasks } from "./taskManagement.js";
import { serveStatic, serveFavicon } from "./staticServing.js";
import { runManageAction, preflightManageAction, findTunnelClientExecutable } from "./manageProcess.js";
import { recordEvent, buildSuggestions, buildStatusDigest, diffAndRecordEvents, readEvents, parseReviewVerdict, collectAudits, type ControlCenterStatusFile, type StatusSnapshotForSuggestions } from "./statusEvents.js";
import { readDirectSessionSummary, handleDirectSessions, handleDirectSessionDetail } from "./directSessions.js";
import { listTasks, type TaskEntry } from "../tools/listTasks.js";
import type { AcceptanceStatus } from "../tools/createTask.js";
import { listAgents, type AgentAvailability } from "../tools/listAgents.js";
import { readWatcherStatus, type WatcherStatusSnapshot } from "../watcherStatus.js";
import { redactSensitiveContent } from "../security/contentRedaction.js";
import { guardWorkspacePath } from "../security/pathGuard.js";
import { auditTask } from "../tools/auditTask.js";
import type { PatchWardenConfig } from "../config.js";
import { getTasksDir, getDirectSessionsDir, resolveWorkspaceRoot } from "../config.js";

// ── Safe wrappers around reusable modules ─────────────────────────

export function readWatcherStatusSafe(config: PatchWardenConfig): WatcherStatusSnapshot {
  try {
    return readWatcherStatus(config);
  } catch (err) {
    return {
      status: "unreadable",
      available: false,
      stale_after_seconds: config.watcherStaleSeconds,
      last_heartbeat_at: null,
      heartbeat_age_seconds: null,
      heartbeat_pid: null,
      instance_id: null,
      launcher_pid: null,
      reason: errorMessage(err),
      activity: null,
    };
  }
}

export function listAgentsSafe(): AgentAvailability[] {
  try {
    return listAgents().agents;
  } catch {
    return [];
  }
}

export function resolveWorkspaceRootSafe(config: PatchWardenConfig): string | null {
  try {
    return resolveWorkspaceRoot(config);
  } catch {
    return null;
  }
}

// ── API handlers ──────────────────────────────────────────────────

export async function handleStatus(
  res: ServerResponse,
  config: PatchWardenConfig,
  projectRoot: string,
  controlCenterEventsPath: string,
  lastStatusDigest: { value: StatusSnapshotForSuggestions | null },
  port: number,
  host: string
): Promise<void> {
  try {
    const [coreHealth, directHealth, watcher, tunnelCore, tunnelDirect, toolsCore, toolsDirect, agents, workspaceRoot, tasks] = await Promise.all([
      probeRuntimeHealth(CORE_BASE_URL).catch((err): RuntimeHealth => ({
        available: false,
        reason: errorMessage(err),
        healthz: null,
        readyz: null,
      })),
      probeRuntimeHealth(DIRECT_BASE_URL).catch((err): RuntimeHealth => ({
        available: false,
        reason: errorMessage(err),
        healthz: null,
        readyz: null,
      })),
      Promise.resolve(readWatcherStatusSafe(config)),
      Promise.resolve(readTunnelStatus(false)),
      Promise.resolve(readTunnelStatus(true)),
      Promise.resolve(readToolManifest(false)),
      Promise.resolve(readToolManifest(true)),
      Promise.resolve(listAgentsSafe()),
      Promise.resolve(resolveWorkspaceRootSafe(config)),
      Promise.resolve(listTasksForStatus(config)),
    ]);
    const snapshotForSuggestions: StatusSnapshotForSuggestions = {
      core: coreHealth,
      direct: directHealth,
      watcher,
      tunnel: { core: tunnelCore, direct: tunnelDirect },
      agents,
      tasks,
    };
    const suggestions = buildSuggestions(snapshotForSuggestions);
    const tunnelClientExe = findTunnelClientExecutable();

    // Diff against the previous poll to record observed state-change events.
    const digest = buildStatusDigest(snapshotForSuggestions);
    if (lastStatusDigest.value) {
      diffAndRecordEvents(buildStatusDigest(lastStatusDigest.value), digest, controlCenterEventsPath);
    }
    lastStatusDigest.value = snapshotForSuggestions;

    sendJson(res, 200, {
      core: coreHealth,
      direct: directHealth,
      watcher,
      tunnel: { core: tunnelCore, direct: tunnelDirect },
      tools: { core: toolsCore, direct: toolsDirect },
      agents,
      workspace_root: workspaceRoot,
      tasks,
      suggestions,
      setup: {
        tunnel_client: {
          available: tunnelClientExe !== null,
          path: tunnelClientExe,
          default_path: DEFAULT_TUNNEL_CLIENT_EXE,
        },
        workspace_root: workspaceRoot,
        watcher: {
          status: watcher.status,
          available: watcher.available,
          reason: watcher.reason,
        },
      },
    });
  } catch (err) {
    sendJson(res, 200, { error: errorMessage(err), partial: true });
  }
}

export function handleTasks(res: ServerResponse, config: PatchWardenConfig): void {
  try {
    const result = listTasks({ limit: 100 });
    const watcher = result.watcher;
    const now = Date.now();
    const augmented = result.tasks.map((t) => augmentTaskWithStale(t, watcher, config, now));
    const staleCount = augmented.filter((t) => t.is_stale).length;
    sendJson(res, 200, {
      tasks: augmented,
      total: result.total,
      returned: augmented.length,
      watcher,
      stale_count: staleCount,
    });
  } catch (err) {
    sendJson(res, 200, {
      tasks: [],
      total: 0,
      returned: 0,
      watcher: null,
      stale_count: 0,
      error: errorMessage(err),
    });
  }
}

export function handleStaleTasks(res: ServerResponse, config: PatchWardenConfig): void {
  try {
    const result = listTasks({ limit: 100 });
    const watcher = result.watcher;
    const now = Date.now();
    const staleTasks = result.tasks
      .map((t) => augmentTaskWithStale(t, watcher, config, now))
      .filter((t) => t.is_stale);
    sendJson(res, 200, {
      stale_tasks: staleTasks,
      total: staleTasks.length,
      watcher,
      stale_threshold_seconds: config.watcherStaleSeconds,
      reason: null,
    });
  } catch (err) {
    sendJson(res, 200, { stale_tasks: [], total: 0, reason: errorMessage(err) });
  }
}

export function handleReconcile(res: ServerResponse, taskId: string, config: PatchWardenConfig, controlCenterEventsPath: string): void {
  try {
    if (
      taskId === "." ||
      taskId === ".." ||
      taskId.includes("/") ||
      taskId.includes("\\") ||
      taskId.includes("\0")
    ) {
      sendJson(res, 400, { error: "Invalid task id" });
      return;
    }
    const tasksDir = getTasksDir(config);
    const taskDir = join(tasksDir, taskId);
    if (!existsSync(taskDir) || !statSync(taskDir).isDirectory()) {
      sendJson(res, 404, { error: "Task not found" });
      return;
    }

    const statusPath = join(taskDir, "status.json");
    const runtimePath = join(taskDir, "runtime.json");
    const statusData = readJsonFileSafe<Record<string, unknown>>(statusPath) ?? {};
    const runtimeData = readJsonFileSafe<Record<string, unknown>>(runtimePath) ?? {};

    const watcher = readWatcherStatusSafe(config);
    const VALID_ACCEPTANCE = ["pending", "accepted", "rejected", "needs_fix", "blocked"];
    const taskStatus = String(statusData.status || "pending");
    const taskAcceptanceStatus = taskStatus === "done_by_agent"
      ? (typeof statusData.acceptance_status === "string" && VALID_ACCEPTANCE.includes(statusData.acceptance_status) ? (statusData.acceptance_status as AcceptanceStatus) : "pending" as AcceptanceStatus)
      : null;
    const taskEntry: TaskEntry = {
      task_id: taskId,
      plan_id: String(statusData.plan_id || ""),
      title: "",
      agent: String(statusData.agent || ""),
      status: taskStatus as TaskEntry["status"],
      phase: String(runtimeData.phase || statusData.phase || "queued") as TaskEntry["phase"],
      acceptance_status: taskAcceptanceStatus,
      created_at: String(statusData.created_at || ""),
      updated_at: String(statusData.updated_at || ""),
      workspace_root: String(statusData.workspace_root || config.workspaceRoot),
      repo_path: String(statusData.repo_path || "."),
      resolved_repo_path: String(statusData.resolved_repo_path || statusData.repo_path || config.workspaceRoot),
      test_command: String(statusData.test_command || ""),
      verify_commands: Array.isArray(statusData.verify_commands) ? (statusData.verify_commands as string[]) : [],
      error: statusData.error ? String(statusData.error) : null,
      last_heartbeat_at: String(runtimeData.last_heartbeat_at || statusData.last_heartbeat_at || statusData.updated_at || ""),
      current_command: runtimeData.current_command === undefined ? null : String(runtimeData.current_command || "") || null,
      timeout_seconds: Number(statusData.timeout_seconds) || config.defaultTaskTimeoutSeconds,
      pending_reason: null,
      watcher_status: watcher.status,
    };

    const cls = classifyStaleTask(taskEntry, watcher, config);
    const isTerminal = TERMINAL_TASK_STATUSES.has(taskEntry.status);

    let decision: "marked_stale" | "marked_archived" | "no_action";
    let safe = false;
    if (isTerminal) {
      decision = "marked_archived";
      safe = true;
    } else if (
      cls.is_stale &&
      (taskEntry.current_command === null || taskEntry.current_command === "" || watcher.status !== "healthy")
    ) {
      decision = "marked_stale";
      safe = true;
    } else {
      decision = "no_action";
      safe = false;
    }

    const reconciledAt = new Date().toISOString();
    const reconcileRecord = {
      task_id: taskId,
      reconciled_at: reconciledAt,
      decision,
      safe,
      previous_status: taskEntry.status,
      previous_phase: taskEntry.phase,
      is_stale: cls.is_stale,
      stale_reasons: cls.stale_reasons,
      watcher_status: watcher.status,
      watcher_last_heartbeat_at: watcher.last_heartbeat_at,
      task_last_heartbeat_at: taskEntry.last_heartbeat_at || null,
      task_current_command: taskEntry.current_command,
      notes:
        decision === "no_action"
          ? "Task does not currently qualify for safe reconcile (still actively running or watcher is healthy)."
          : "Task annotated with reconcile metadata; original status preserved. No files were deleted.",
    };

    try {
      writeFileSync(join(taskDir, "reconcile.json"), JSON.stringify(reconcileRecord, null, 2), "utf-8");
    } catch (writeErr) {
      sendJson(res, 500, { error: `Failed to write reconcile record: ${errorMessage(writeErr)}` });
      return;
    }

    if (safe) {
      const annotated = {
        ...statusData,
        reconcile_state: decision === "marked_archived" ? "archived" : "stale",
        reconciled_at: reconciledAt,
      };
      try {
        writeFileSync(statusPath, JSON.stringify(annotated, null, 2), "utf-8");
      } catch (writeErr) {
        sendJson(res, 500, { error: `Failed to annotate status.json: ${errorMessage(writeErr)}` });
        return;
      }
    }

    recordEvent("task.reconciled", controlCenterEventsPath, {
      task_id: taskId,
      decision,
      safe,
      previous_status: taskEntry.status,
      is_stale: cls.is_stale,
    });
    sendJson(res, 200, reconcileRecord);
  } catch (err) {
    sendJson(res, 500, { error: errorMessage(err) });
  }
}

export function handleTaskDetail(res: ServerResponse, taskId: string, config: PatchWardenConfig): void {
  try {
    const tasksDir = getTasksDir(config);
    const taskDir = join(tasksDir, taskId);
    if (!existsSync(taskDir) || !statSync(taskDir).isDirectory()) {
      sendJson(res, 404, { error: "Task not found" });
      return;
    }

    const statusData = readJsonFileSafe<Record<string, unknown>>(join(taskDir, "status.json"));
    const runtimeData = readJsonFileSafe<Record<string, unknown>>(join(taskDir, "runtime.json"));
    const resultData = readJsonFileSafe<Record<string, unknown>>(join(taskDir, "result.json"));
    const auditData = readJsonFileSafe<Record<string, unknown>>(join(taskDir, "audit.json"));
    const verifyData = readJsonFileSafe<Record<string, unknown>>(join(taskDir, "verify.json"));
    const changedFiles = readJsonFileSafe<Record<string, unknown>>(join(taskDir, "changed-files.json"));
    const fileStats = readJsonFileSafe<Record<string, unknown>>(join(taskDir, "file-stats.json"));
    const reconcileData = readJsonFileSafe<Record<string, unknown>>(join(taskDir, "reconcile.json"));

    const reviewPath = join(taskDir, "independent-review.md");
    let independentReview: { verdict: string | null; content: string | null } = { verdict: null, content: null };
    if (existsSync(reviewPath)) {
      const content = readTextFileSafe(reviewPath) ?? "";
      independentReview = { verdict: parseReviewVerdict(content), content };
    }

    const verificationSummary = verifyData
      ? {
          status: verifyData.status ?? null,
          commands: Array.isArray(verifyData.commands) ? verifyData.commands : null,
          checked_at: fileMtimeIso(join(taskDir, "verify.json")),
        }
      : null;

    const warnings: string[] = [];
    const errors: string[] = [];
    if (statusData && statusData.error) errors.push(String(statusData.error));
    if (resultData && Array.isArray(resultData.warnings)) {
      for (const w of resultData.warnings) warnings.push(String(w));
    }
    if (resultData && resultData.error) errors.push(String(resultData.error));
    const errorLog = readJsonFileSafe<Record<string, unknown>>(join(taskDir, "error.log"));
    if (errorLog && errorLog.message) errors.push(String(errorLog.message));

    let stale: StaleClassification | null = null;
    if (statusData) {
      const watcher = readWatcherStatusSafe(config);
      const VALID_ACCEPTANCE2 = ["pending", "accepted", "rejected", "needs_fix", "blocked"];
      const taskStatus2 = String(statusData.status || "pending");
      const taskAcceptanceStatus2 = taskStatus2 === "done_by_agent"
        ? (typeof statusData.acceptance_status === "string" && VALID_ACCEPTANCE2.includes(statusData.acceptance_status) ? (statusData.acceptance_status as AcceptanceStatus) : "pending" as AcceptanceStatus)
        : null;
      const entry: TaskEntry = {
        task_id: taskId,
        plan_id: String(statusData.plan_id || ""),
        title: "",
        agent: String(statusData.agent || ""),
        status: taskStatus2 as TaskEntry["status"],
        phase: String(runtimeData?.phase || statusData.phase || "queued") as TaskEntry["phase"],
        acceptance_status: taskAcceptanceStatus2,
        created_at: String(statusData.created_at || ""),
        updated_at: String(statusData.updated_at || ""),
        workspace_root: String(statusData.workspace_root || config.workspaceRoot),
        repo_path: String(statusData.repo_path || "."),
        resolved_repo_path: String(statusData.resolved_repo_path || statusData.repo_path || config.workspaceRoot),
        test_command: String(statusData.test_command || ""),
        verify_commands: Array.isArray(statusData.verify_commands) ? (statusData.verify_commands as string[]) : [],
        error: statusData.error ? String(statusData.error) : null,
        last_heartbeat_at: String(runtimeData?.last_heartbeat_at || statusData.last_heartbeat_at || statusData.updated_at || ""),
        current_command: runtimeData?.current_command === undefined ? null : String(runtimeData.current_command || "") || null,
        timeout_seconds: Number(statusData.timeout_seconds) || config.defaultTaskTimeoutSeconds,
        pending_reason: null,
        watcher_status: watcher.status,
      };
      stale = classifyStaleTask(entry, watcher, config);
    }

    sendJson(res, 200, {
      task_id: taskId,
      status: statusData,
      runtime: runtimeData,
      result: resultData,
      audit: auditData,
      independent_review: independentReview,
      diff_patch: readTextFileSafe(join(taskDir, "diff.patch")),
      test_log: readTextFileSafe(join(taskDir, "test.log")) ?? readTextFileSafe(join(taskDir, "test-log.txt")),
      verify_log: readTextFileSafe(join(taskDir, "verify.log")),
      changed_files: changedFiles,
      file_stats: fileStats,
      verification_summary: verificationSummary,
      warnings,
      errors,
      stale,
      reconcile: reconcileData,
      task_dir: taskDir,
    });
  } catch (err) {
    sendJson(res, 200, { task_id: taskId, error: errorMessage(err) });
  }
}

export function handleTaskAudit(res: ServerResponse, taskId: string, config: PatchWardenConfig, controlCenterEventsPath: string): void {
  try {
    if (
      taskId === "." ||
      taskId === ".." ||
      taskId.includes("/") ||
      taskId.includes("\\") ||
      taskId.includes("\0")
    ) {
      sendJson(res, 400, { error: "Invalid task id" });
      return;
    }
    const tasksDir = getTasksDir(config);
    const taskDir = join(tasksDir, taskId);
    if (!existsSync(taskDir) || !statSync(taskDir).isDirectory()) {
      sendJson(res, 404, { error: "Task not found" });
      return;
    }
    const statusData = readJsonFileSafe<Record<string, unknown>>(join(taskDir, "status.json"));
    const taskStatus = statusData ? String(statusData.status || "") : "";
    if (!TERMINAL_TASK_STATUSES.has(taskStatus as string)) {
      sendJson(res, 409, {
        error: "Task is not in a terminal state; audit_task can only run safely after completion.",
        status: taskStatus || "unknown",
      });
      return;
    }
    const output = auditTask(taskId);
    recordEvent("task.audited", controlCenterEventsPath, { task_id: taskId, previous_status: taskStatus });
    sendJson(res, 200, { ok: true, audit: output });
  } catch (err) {
    sendJson(res, 500, { error: errorMessage(err) });
  }
}

export function handleOpenTaskFolder(res: ServerResponse, taskId: string, config: PatchWardenConfig): void {
  try {
    if (
      taskId === "." ||
      taskId === ".." ||
      taskId.includes("/") ||
      taskId.includes("\\") ||
      taskId.includes("\0")
    ) {
      sendJson(res, 400, { error: "Invalid task id" });
      return;
    }
    const tasksDir = getTasksDir(config);
    const taskDir = join(tasksDir, taskId);
    if (!existsSync(taskDir) || !statSync(taskDir).isDirectory()) {
      sendJson(res, 404, { error: "Task not found" });
      return;
    }
    let cmd: string;
    if (process.platform === "win32") {
      cmd = "explorer.exe";
    } else if (process.platform === "darwin") {
      cmd = "open";
    } else {
      cmd = "xdg-open";
    }
    try {
      const child = spawn(cmd, [taskDir], { detached: true, stdio: "ignore" });
      child.on("error", () => { /* ignore spawn errors */ });
      child.unref();
    } catch {
      /* ignore */
    }
    sendJson(res, 200, { ok: true, path: taskDir });
  } catch (err) {
    sendJson(res, 500, { error: errorMessage(err) });
  }
}

export type LogCategory = "core" | "direct" | "watcher" | "control-center";

export function handleLogs(res: ServerResponse, category: LogCategory, tailLines: number): void {
  try {
    let dir: string;
    let stdoutPath: string;
    let stderrPath: string;
    let stdoutExists: boolean;
    let stderrExists: boolean;

    if (category === "control-center") {
      dir = getControlCenterLogDir();
      stdoutPath = join(dir, "control-center.stdout.log");
      stderrPath = join(dir, "control-center.stderr.log");
      stdoutExists = existsSync(stdoutPath);
      stderrExists = existsSync(stderrPath);
    } else if (category === "watcher") {
      dir = getRuntimeRoot(false);
      const sp = findLatestLog(dir, /^watcher-.*\.stdout\.log$/);
      const ep = findLatestLog(dir, /^watcher-.*\.stderr\.log$/);
      stdoutPath = sp ?? "";
      stderrPath = ep ?? "";
      stdoutExists = sp !== null;
      stderrExists = ep !== null;
    } else {
      dir = getRuntimeRoot(category === "direct");
      stdoutPath = join(dir, "tunnel-client.stdout.log");
      stderrPath = join(dir, "tunnel-client.stderr.log");
      stdoutExists = existsSync(stdoutPath);
      stderrExists = existsSync(stderrPath);
    }

    if (!stdoutExists && !stderrExists) {
      sendJson(res, 200, {
        stdout: "",
        stderr: "",
        category,
        tail: tailLines,
        reason: "log file not found",
      });
      return;
    }

    const stdoutRaw = stdoutExists ? readFileTail(stdoutPath, tailLines) : "";
    const stderrRaw = stderrExists ? readFileTail(stderrPath, tailLines) : "";
    const stdout = redactSensitiveContent(stdoutRaw).content;
    const stderr = redactSensitiveContent(stderrRaw).content;
    sendJson(res, 200, { stdout, stderr, category, tail: tailLines, reason: null });
  } catch (err) {
    sendJson(res, 200, { stdout: "", stderr: "", category, tail: tailLines, reason: errorMessage(err) });
  }
}

export function handleWorkspace(res: ServerResponse, config: PatchWardenConfig): void {
  let workspaceRoot: string | null = null;
  let directories: string[] = [];
  let agents: AgentAvailability[] = [];
  let configSummary: { toolProfile: string | null; allowedTestCommandsCount: number; enableDirectProfile: boolean } | null = null;

  try {
    workspaceRoot = resolveWorkspaceRoot(config);
  } catch {
    workspaceRoot = null;
  }
  if (workspaceRoot) {
    try {
      directories = readdirSync(workspaceRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
    } catch {
      directories = [];
    }
  }
  try {
    agents = listAgents().agents;
  } catch {
    agents = [];
  }
  try {
    configSummary = {
      toolProfile: config.toolProfile ?? null,
      allowedTestCommandsCount: config.allowedTestCommands.length,
      enableDirectProfile: config.enableDirectProfile ?? false,
    };
  } catch {
    configSummary = null;
  }
  sendJson(res, 200, { workspace_root: workspaceRoot, directories, agents, config: configSummary });
}

export function handleWorkspaceRepoStatus(res: ServerResponse, repoParam: string, config: PatchWardenConfig): void {
  try {
    let workspaceRoot: string;
    try {
      workspaceRoot = resolveWorkspaceRoot(config);
    } catch (err) {
      sendJson(res, 500, { error: `workspace root unavailable: ${errorMessage(err)}` });
      return;
    }

    if (repoParam.includes("\0") || repoParam.includes("..")) {
      sendJson(res, 400, { error: "Invalid repo path: traversal segments are not allowed" });
      return;
    }

    let repoAbs: string;
    try {
      repoAbs = guardWorkspacePath(repoParam || ".", workspaceRoot);
    } catch (err) {
      sendJson(res, 400, { error: `Invalid repo path: ${errorMessage(err)}` });
      return;
    }

    if (!existsSync(repoAbs) || !statSync(repoAbs).isDirectory()) {
      sendJson(res, 404, { error: "Repo directory not found", repo_path: repoParam });
      return;
    }

    execFile(
      "git",
      ["status", "--short"],
      { cwd: repoAbs, maxBuffer: 1024 * 1024, timeout: 8000, windowsHide: true, encoding: "utf-8" },
      (err, stdout, stderr) => {
        if (err) {
          sendJson(res, 200, {
            repo_path: repoParam,
            resolved_repo_path: repoAbs,
            is_git_repo: false,
            changed_files_count: 0,
            untracked_count: 0,
            modified_count: 0,
            is_clean: true,
            short_status: "",
            error: errorMessage(err),
            stderr: stderr ? String(stderr).slice(0, 500) : "",
          });
          return;
        }
        const text = String(stdout);
        const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
        let modified = 0;
        let untracked = 0;
        for (const line of lines) {
          const xy = line.slice(0, 2);
          if (xy === "??") untracked++;
          else modified++;
        }
        sendJson(res, 200, {
          repo_path: repoParam,
          resolved_repo_path: repoAbs,
          is_git_repo: true,
          changed_files_count: lines.length,
          untracked_count: untracked,
          modified_count: modified,
          is_clean: lines.length === 0,
          short_status: text,
          error: null,
        });
      }
    );
  } catch (err) {
    sendJson(res, 500, { error: errorMessage(err) });
  }
}

export function handleAudit(res: ServerResponse, config: PatchWardenConfig): void {
  try {
    const tasksDir = getTasksDir(config);
    const sessionsDir = getDirectSessionsDir(config);
    const audits = collectAudits(
      tasksDir,
      sessionsDir,
      existsSync,
      readdirSync,
      readTextFileSafe,
      readJsonFileSafe,
      fileMtimeIso,
      parseReviewVerdict
    );
    sendJson(res, 200, { audits, total: audits.length });
  } catch (err) {
    sendJson(res, 200, { audits: [], reason: errorMessage(err) });
  }
}

export function handleTunnelUiUrl(res: ServerResponse): void {
  sendJson(res, 200, {
    core: readTunnelUrl(false),
    direct: readTunnelUrl(true),
  });
}

export async function handleManageAction(
  res: ServerResponse,
  action: string,
  mode: string,
  projectRoot: string,
  manageScriptPath: string,
  controlCenterEventsPath: string
): Promise<void> {
  try {
    const preflight = preflightManageAction(action, mode, projectRoot);
    if (preflight) {
      recordEvent("manage." + mode + "." + action + ".preflight_failed", controlCenterEventsPath, {
        missing: preflight.body.missing,
      });
      sendJson(res, preflight.status, preflight.body);
      return;
    }
    const result = await runManageAction(action, mode, manageScriptPath, projectRoot);
    recordEvent("manage." + mode + "." + action, controlCenterEventsPath, {
      exit_code: result.exitCode,
      ok: result.exitCode === 0,
    });
    sendJson(res, 200, {
      ok: result.exitCode === 0,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  } catch (err) {
    recordEvent("manage." + mode + "." + action + ".failed", controlCenterEventsPath, { error: errorMessage(err) });
    sendJson(res, 500, { error: errorMessage(err) });
  }
}

export function handleEvents(res: ServerResponse, limit: number, controlCenterEventsPath: string): void {
  const events = readEvents(limit, controlCenterEventsPath);
  sendJson(res, 200, {
    events,
    total: events.length,
    limit,
  });
}

export function handleOpenLogsFolder(res: ServerResponse): void {
  try {
    const target = getRuntimeRoot(false);
    let cmd: string;
    if (process.platform === "win32") {
      cmd = "explorer.exe";
    } else if (process.platform === "darwin") {
      cmd = "open";
    } else {
      cmd = "xdg-open";
    }
    try {
      const child = spawn(cmd, [target], { detached: true, stdio: "ignore" });
      child.on("error", () => { /* ignore spawn errors */ });
      child.unref();
    } catch {
      /* ignore */
    }
    sendJson(res, 200, { ok: true, path: target });
  } catch (err) {
    sendJson(res, 500, { error: errorMessage(err) });
  }
}

export function handleControlCenterStatus(res: ServerResponse, controlCenterStatusPath: string): void {
  if (!existsSync(controlCenterStatusPath)) {
    sendJson(res, 200, { running: false });
    return;
  }
  const data = readJsonFileSafe<ControlCenterStatusFile>(controlCenterStatusPath);
  if (!data) {
    sendJson(res, 200, { running: false });
    return;
  }
  sendJson(res, 200, { running: true, ...data });
}