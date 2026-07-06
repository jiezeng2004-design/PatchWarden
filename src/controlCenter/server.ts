#!/usr/bin/env node
/**
 * PatchWarden Control Center — Request router and server bootstrap.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { errorMessage, sendJson, readBody, resolveTailParam } from "./helpers.js";
import { PAGE_ALIASES, getControlCenterLogDir } from "./constants.js";
import { serveStatic, serveFavicon } from "./staticServing.js";
import { handleDirectSessions, handleDirectSessionDetail } from "./directSessions.js";
import {
  handleStatus,
  handleTasks,
  handleStaleTasks,
  handleReconcile,
  handleTaskDetail,
  handleTaskAudit,
  handleOpenTaskFolder,
  handleLogs,
  handleWorkspace,
  handleWorkspaceRepoStatus,
  handleAudit,
  handleTunnelUiUrl,
  handleManageAction,
  handleEvents,
  handleOpenLogsFolder,
  handleControlCenterStatus,
  type LogCategory,
} from "./apiHandlers.js";
import { writeStatusFile, removeStatusFile, recordEvent } from "./statusEvents.js";
import { getTasksDir, getDirectSessionsDir, loadConfig, resolveWorkspaceRoot, type PatchWardenConfig } from "../config.js";
import { PATCHWARDEN_VERSION, TOOL_SCHEMA_EPOCH } from "../version.js";

// ── Paths ─────────────────────────────────────────────────────────

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const uiRoot = join(projectRoot, "ui");
const manageScriptPath = join(projectRoot, "scripts", "control", "manage-patchwarden.ps1");

// ── Config (fault-tolerant bootstrap) ─────────────────────────────

function createFallbackConfig(): PatchWardenConfig {
  return {
    workspaceRoot: process.cwd(),
    plansDir: ".patchwarden/plans",
    tasksDir: ".patchwarden/tasks",
    assessmentsDir: ".patchwarden/assessments",
    assessmentTtlSeconds: 3600,
    agents: {},
    allowedTestCommands: [],
    repoAllowedTestCommands: {},
    maxReadFileBytes: 200_000,
    defaultTaskTimeoutSeconds: 900,
    maxTaskTimeoutSeconds: 3600,
    watcherStaleSeconds: 30,
    toolProfile: "full",
    enableDirectProfile: false,
    directSessionsDir: ".patchwarden/direct-sessions",
    directSessionTtlSeconds: 3600,
    directMaxPatchBytes: 200_000,
    directMaxFileBytes: 500_000,
  };
}

let config: PatchWardenConfig;
try {
  config = loadConfig();
} catch (err) {
  console.error(
    `[control-center] WARNING: Failed to load config (${errorMessage(err)}). Using fallback defaults.`
  );
  config = createFallbackConfig();
}

// ── Control token (in-memory only) ────────────────────────────────

const controlToken = randomUUID();

// ── Port resolution ───────────────────────────────────────────────

function resolvePort(): number {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port" && i + 1 < argv.length) {
      const n = parseInt(argv[i + 1], 10);
      if (Number.isFinite(n) && n >= 0) return n;
    }
    const m = arg.match(/^--port=(\d+)$/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n >= 0) return n;
    }
  }
  const envPort = parseInt(process.env.PATCHWARDEN_CONTROL_PORT || "", 10);
  if (Number.isFinite(envPort) && envPort >= 0) return envPort;
  return 8090;
}

const port = resolvePort();
const host = "127.0.0.1";

// Status + events files
const controlCenterStatusPath = join(getControlCenterLogDir(), "control-center-status.json");
const controlCenterEventsPath = join(getControlCenterLogDir(), "control-center-events.jsonl");

// State tracking for status diff
const lastStatusDigest: { value: import("./statusEvents.js").StatusSnapshotForSuggestions | null } = { value: null };

// ── Request router ────────────────────────────────────────────────

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const parsedUrl = new URL(req.url || "/", `http://${req.headers.host || host}`);
  const pathname = parsedUrl.pathname;
  const method = (req.method || "GET").toUpperCase();

  // Static routes
  if (method === "GET" && pathname === "/") {
    serveStatic(res, "pages/dashboard.html", uiRoot);
    return;
  }
  const pageAlias = PAGE_ALIASES[pathname];
  if (method === "GET" && pageAlias) {
    serveStatic(res, pageAlias, uiRoot);
    return;
  }
  if (method === "GET" && pathname === "/control-token.json") {
    sendJson(res, 200, { token: controlToken });
    return;
  }
  if (method === "GET" && pathname === "/favicon.ico") {
    serveFavicon(res);
    return;
  }
  if (
    method === "GET" &&
    (pathname === "/colors_and_type.css" ||
      pathname.startsWith("/pages/") ||
      pathname.startsWith("/partials/") ||
      pathname.startsWith("/vendor/"))
  ) {
    serveStatic(res, pathname, uiRoot);
    return;
  }

  // GET API routes
  if (method === "GET" && pathname === "/api/status") {
    await handleStatus(res, config, projectRoot, controlCenterEventsPath, lastStatusDigest, port, host);
    return;
  }
  if (method === "GET" && pathname === "/api/tasks") {
    handleTasks(res, config);
    return;
  }
  if (method === "GET" && pathname === "/api/tasks/stale") {
    handleStaleTasks(res, config);
    return;
  }
  const taskMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (method === "GET" && taskMatch) {
    let taskId: string;
    try {
      taskId = decodeURIComponent(taskMatch[1]);
    } catch {
      taskId = taskMatch[1];
    }
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
    handleTaskDetail(res, taskId, config);
    return;
  }
  // Logs: /api/logs/<category>?tail=<100|300|1000>
  const logsMatch = pathname.match(/^\/api\/logs\/([a-z-]+)$/);
  if (method === "GET" && logsMatch) {
    const rawCat = logsMatch[1];
    const category = rawCat === "core" || rawCat === "direct" || rawCat === "watcher" || rawCat === "control-center"
      ? (rawCat as LogCategory)
      : null;
    if (!category) {
      sendJson(res, 404, { error: "Unknown log category" });
      return;
    }
    const tail = resolveTailParam(parsedUrl.searchParams.get("tail"));
    handleLogs(res, category, tail);
    return;
  }
  if (method === "GET" && pathname === "/api/workspace") {
    handleWorkspace(res, config);
    return;
  }
  const workspaceRepoMatch = pathname.match(/^\/api\/workspace\/([^/]+(?:\/[^/]+)*)\/status$/);
  if (method === "GET" && workspaceRepoMatch) {
    let repoParam: string;
    try {
      repoParam = decodeURIComponent(workspaceRepoMatch[1]);
    } catch {
      sendJson(res, 400, { error: "Invalid repo path encoding" });
      return;
    }
    handleWorkspaceRepoStatus(res, repoParam, config);
    return;
  }
  if (method === "GET" && pathname === "/api/direct-sessions") {
    const sessionsDir = getDirectSessionsDir(config);
    handleDirectSessions(res, sessionsDir);
    return;
  }
  const directSessionMatch = pathname.match(/^\/api\/direct-sessions\/([^/]+)$/);
  if (method === "GET" && directSessionMatch) {
    let sessionId: string;
    try {
      sessionId = decodeURIComponent(directSessionMatch[1]);
    } catch {
      sessionId = directSessionMatch[1];
    }
    const sessionsDir = getDirectSessionsDir(config);
    handleDirectSessionDetail(res, sessionId, sessionsDir);
    return;
  }
  if (method === "GET" && pathname === "/api/audit") {
    handleAudit(res, config);
    return;
  }
  if (method === "GET" && pathname === "/api/tunnel-ui-url") {
    handleTunnelUiUrl(res);
    return;
  }
  if (method === "GET" && pathname === "/api/events") {
    const limitParam = parsedUrl.searchParams.get("limit");
    let limit = 100;
    if (limitParam !== null) {
      const n = parseInt(limitParam, 10);
      if (Number.isFinite(n) && n > 0 && n <= 1000) limit = n;
    }
    handleEvents(res, limit, controlCenterEventsPath);
    return;
  }
  if (method === "GET" && pathname === "/api/control-center-status") {
    handleControlCenterStatus(res, controlCenterStatusPath);
    return;
  }

  // POST API routes (all require control token)
  if (method === "POST") {
    await readBody(req); // drain optional body
    if (!checkControlToken(req)) {
      sendJson(res, 403, { error: "Missing or invalid control token" });
      return;
    }
    if (pathname === "/api/start-all") return handleManageAction(res, "start", "all", projectRoot, manageScriptPath, controlCenterEventsPath);
    if (pathname === "/api/stop-all") return handleManageAction(res, "stop", "all", projectRoot, manageScriptPath, controlCenterEventsPath);
    if (pathname === "/api/restart-all") return handleManageAction(res, "restart", "all", projectRoot, manageScriptPath, controlCenterEventsPath);
    if (pathname === "/api/core/start") return handleManageAction(res, "start", "core", projectRoot, manageScriptPath, controlCenterEventsPath);
    if (pathname === "/api/core/stop") return handleManageAction(res, "stop", "core", projectRoot, manageScriptPath, controlCenterEventsPath);
    if (pathname === "/api/direct/start") return handleManageAction(res, "start", "direct", projectRoot, manageScriptPath, controlCenterEventsPath);
    if (pathname === "/api/direct/stop") return handleManageAction(res, "stop", "direct", projectRoot, manageScriptPath, controlCenterEventsPath);
    if (pathname === "/api/open-logs-folder") {
      handleOpenLogsFolder(res);
      return;
    }
    // POST /api/tasks/:taskId/reconcile (token already validated above)
    const reconcileMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/reconcile$/);
    if (reconcileMatch) {
      let taskId: string;
      try {
        taskId = decodeURIComponent(reconcileMatch[1]);
      } catch {
        taskId = reconcileMatch[1];
      }
      handleReconcile(res, taskId, config, controlCenterEventsPath);
      return;
    }
    // POST /api/tasks/:taskId/audit — run audit_task safely
    const auditMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/audit$/);
    if (auditMatch) {
      let taskId: string;
      try {
        taskId = decodeURIComponent(auditMatch[1]);
      } catch {
        taskId = auditMatch[1];
      }
      handleTaskAudit(res, taskId, config, controlCenterEventsPath);
      return;
    }
    // POST /api/tasks/:taskId/open-folder — open task folder in file explorer
    const openFolderMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/open-folder$/);
    if (openFolderMatch) {
      let taskId: string;
      try {
        taskId = decodeURIComponent(openFolderMatch[1]);
      } catch {
        taskId = openFolderMatch[1];
      }
      handleOpenTaskFolder(res, taskId, config);
      return;
    }
    sendJson(res, 404, { error: "Not found" });
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

function checkControlToken(req: IncomingMessage): boolean {
  const header = req.headers["x-patchwarden-control-token"];
  const provided = Array.isArray(header) ? header[0] : header;
  if (typeof provided !== "string" || provided.length === 0) return false;
  return provided === controlToken;
}

// ── Server bootstrap ──────────────────────────────────────────────

export const server = createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    if (!res.headersSent) {
      sendJson(res, 500, { error: errorMessage(err) });
    } else {
      try { res.end(); } catch { /* ignore */ }
    }
  });
});

server.on("error", (err) => {
  console.error(`[control-center] Server error: ${errorMessage(err)}`);
  process.exit(1);
});

server.listen(port, host, () => {
  const addr = server.address();
  const formatted = addr && typeof addr === "object" ? `http://${addr.address}:${addr.port}/` : `http://${host}:${port}/`;
  console.error(`[control-center] PatchWarden v${PATCHWARDEN_VERSION} (schema epoch ${TOOL_SCHEMA_EPOCH})`);
  console.error(`[control-center] Workspace: ${config.workspaceRoot}`);
  console.error(`[control-center] Listening: ${formatted}`);
  console.error(`[control-center] Bound to 127.0.0.1 only — not exposed to network`);
  // Persist status file
  writeStatusFile(port, host, controlCenterStatusPath);
  recordEvent("control_center.started", controlCenterEventsPath, {
    pid: process.pid,
    port,
    url: formatted,
    version: PATCHWARDEN_VERSION,
  });
});

export function shutdown(): void {
  console.error("[control-center] Shutting down...");
  recordEvent("control_center.stopped", controlCenterEventsPath, { pid: process.pid });
  removeStatusFile(controlCenterStatusPath);
  server.close(() => {
    try { process.exit(0); } catch { /* ignore */ }
  });
  setTimeout(() => {
    try { process.exit(0); } catch { /* ignore */ }
  }, 3000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);