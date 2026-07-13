/**
 * PatchWarden Control Center — HTTP server creation, routing, and lifecycle.
 *
 * This module wires together the route handlers (routes/*.ts), middleware
 * (auth/static), and the shared/runtime helpers. It owns the `handleRequest`
 * router that dispatches every GET/POST route, the POST control-token gate,
 * and the server bootstrap/shutdown lifecycle (status file, activity events,
 * SIGINT/SIGTERM).
 *
 * Entry point: `controlCenter.ts` imports `startServer()` from here.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { PATCHWARDEN_VERSION, TOOL_SCHEMA_EPOCH } from "../version.js";
import { logger } from "../logging.js";
import {
  config,
  controlToken,
  errorMessage,
  host,
  PAGE_ALIASES,
  port,
  readBody,
  resolveTailParam,
  sendJson,
} from "./shared.js";
import { recordEvent, removeStatusFile, writeStatusFile } from "./runtime.js";
import { checkControlToken } from "./middleware/auth.js";
import { serveFavicon, serveStatic } from "./middleware/static.js";
import { handleTasks, handleStaleTasks, handleTaskDetail, handleTaskSafeResult, handleTaskSafeAudit, handleTaskSafeTestSummary, handleTaskSafeDiffSummary } from "./routes/tasks.js";
import { handleReconcile, handleTaskAudit, handleOpenTaskFolder, handleHideStale } from "./routes/taskActions.js";
import { handleDirectSessions, handleDirectSessionDetail, handleDirectSessionSafeSummary, handleDirectSessionFinalize, handleDirectSessionAudit, handleDirectSessionHide } from "./routes/sessions.js";
import { handleLineages, handleLineageDetail } from "./routes/lineage.js";
import { handleEvidencePacks, handleEvidencePackDetail, handleEvidencePackExport } from "./routes/evidence.js";
import { handleProjectPolicy, handleReleaseStatus } from "./routes/policy.js";
import { handleWorkspace, handleWorkspaceRepos, handleWorkspaceRepoStatus } from "./routes/workspace.js";
import { handleManageAction, handleOpenLogsFolder } from "./routes/process.js";
import { handleStatus, handleControlCenterStatus, handleEvents, handleTunnelUiUrl, handleDiagnostics } from "./routes/status.js";
import { handleLogs, handleAudit, handleWarnings, type LogCategory } from "./routes/audit.js";

// ── Request router ────────────────────────────────────────────────

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const parsedUrl = new URL(req.url || "/", `http://${req.headers.host || host}`);
  const pathname = parsedUrl.pathname;
  const method = (req.method || "GET").toUpperCase();

  // Static routes
  if (method === "GET" && pathname === "/") {
    serveStatic(res, "pages/dashboard.html");
    return;
  }
  const pageAlias = PAGE_ALIASES[pathname];
  if (method === "GET" && pageAlias) {
    serveStatic(res, pageAlias);
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
    serveStatic(res, pathname);
    return;
  }

  // GET API routes
  if (method === "GET" && pathname === "/api/status") {
    await handleStatus(res);
    return;
  }
  if (method === "GET" && pathname === "/api/tasks") {
    handleTasks(res, {
      repo_path: parsedUrl.searchParams.get("repo_path") || undefined,
      status: parsedUrl.searchParams.get("status") || undefined,
      acceptance_status: parsedUrl.searchParams.get("acceptance_status") || undefined,
      agent: parsedUrl.searchParams.get("agent") || undefined,
      warning_type: parsedUrl.searchParams.get("warning_type") || undefined,
    });
    return;
  }
  if (method === "GET" && pathname === "/api/tasks/stale") {
    handleStaleTasks(res);
    return;
  }
  if (method === "GET" && pathname === "/api/lineages") {
    handleLineages(res);
    return;
  }
  const lineageMatch = pathname.match(/^\/api\/lineages\/([^/]+)$/);
  if (method === "GET" && lineageMatch) {
    let lineageId: string;
    try {
      lineageId = decodeURIComponent(lineageMatch[1]);
    } catch {
      lineageId = lineageMatch[1];
    }
    handleLineageDetail(res, lineageId);
    return;
  }
  if (method === "GET" && pathname === "/api/project-policy") {
    handleProjectPolicy(res, parsedUrl.searchParams.get("repo_path") || ".");
    return;
  }
  if (method === "GET" && pathname === "/api/release/status") {
    handleReleaseStatus(res, parsedUrl.searchParams.get("repo_path") || ".");
    return;
  }
  if (method === "GET" && pathname === "/api/evidence-packs") {
    handleEvidencePacks(res);
    return;
  }
  const evidencePackMatch = pathname.match(/^\/api\/evidence-packs\/([^/]+)$/);
  if (method === "GET" && evidencePackMatch) {
    let lineageId: string;
    try {
      lineageId = decodeURIComponent(evidencePackMatch[1]);
    } catch {
      lineageId = evidencePackMatch[1];
    }
    handleEvidencePackDetail(res, lineageId);
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
    handleTaskDetail(res, taskId);
    return;
  }
  // Safe, bounded views for task artifacts (no full stdout/stderr/diff).
  const taskSafeResultMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/safe-result$/);
  if (method === "GET" && taskSafeResultMatch) {
    let taskId: string;
    try {
      taskId = decodeURIComponent(taskSafeResultMatch[1]);
    } catch {
      taskId = taskSafeResultMatch[1];
    }
    handleTaskSafeResult(res, taskId);
    return;
  }
  const taskSafeAuditMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/safe-audit$/);
  if (method === "GET" && taskSafeAuditMatch) {
    let taskId: string;
    try {
      taskId = decodeURIComponent(taskSafeAuditMatch[1]);
    } catch {
      taskId = taskSafeAuditMatch[1];
    }
    handleTaskSafeAudit(res, taskId);
    return;
  }
  const taskSafeTestSummaryMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/safe-test-summary$/);
  if (method === "GET" && taskSafeTestSummaryMatch) {
    let taskId: string;
    try {
      taskId = decodeURIComponent(taskSafeTestSummaryMatch[1]);
    } catch {
      taskId = taskSafeTestSummaryMatch[1];
    }
    handleTaskSafeTestSummary(res, taskId);
    return;
  }
  const taskSafeDiffSummaryMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/safe-diff-summary$/);
  if (method === "GET" && taskSafeDiffSummaryMatch) {
    let taskId: string;
    try {
      taskId = decodeURIComponent(taskSafeDiffSummaryMatch[1]);
    } catch {
      taskId = taskSafeDiffSummaryMatch[1];
    }
    handleTaskSafeDiffSummary(res, taskId);
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
    handleWorkspace(res);
    return;
  }
  if (method === "GET" && pathname === "/api/workspace/repos") {
    handleWorkspaceRepos(res);
    return;
  }
  // On-demand git status for a single repo (path-traversal safe).
  // The repo segment is URL-decoded; traversal is rejected by guardWorkspacePath.
  const workspaceRepoMatch = pathname.match(/^\/api\/workspace\/([^/]+(?:\/[^/]+)*)\/status$/);
  if (method === "GET" && workspaceRepoMatch) {
    let repoParam: string;
    try {
      repoParam = decodeURIComponent(workspaceRepoMatch[1]);
    } catch {
      sendJson(res, 400, { error: "Invalid repo path encoding" });
      return;
    }
    handleWorkspaceRepoStatus(res, repoParam);
    return;
  }
  if (method === "GET" && pathname === "/api/direct-sessions") {
    handleDirectSessions(res);
    return;
  }
  const directSessionSummaryMatch = pathname.match(/^\/api\/direct-sessions\/([^/]+)\/summary$/);
  if (method === "GET" && directSessionSummaryMatch) {
    let sessionId: string;
    try {
      sessionId = decodeURIComponent(directSessionSummaryMatch[1]);
    } catch {
      sessionId = directSessionSummaryMatch[1];
    }
    handleDirectSessionSafeSummary(res, sessionId);
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
    handleDirectSessionDetail(res, sessionId);
    return;
  }
  if (method === "GET" && pathname === "/api/audit") {
    handleAudit(res);
    return;
  }
  if (method === "GET" && pathname === "/api/warnings") {
    handleWarnings(res);
    return;
  }
  if (method === "GET" && pathname === "/api/diagnostics") {
    handleDiagnostics(res);
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
    handleEvents(res, limit);
    return;
  }
  if (method === "GET" && pathname === "/api/control-center-status") {
    handleControlCenterStatus(res);
    return;
  }

  // POST API routes (all require control token)
  if (method === "POST") {
    await readBody(req); // drain optional body
    if (!checkControlToken(req)) {
      sendJson(res, 403, { error: "Missing or invalid control token" });
      return;
    }
    if (pathname === "/api/start-all") return handleManageAction(res, "start", "all");
    if (pathname === "/api/stop-all") return handleManageAction(res, "stop", "all");
    if (pathname === "/api/restart-all") return handleManageAction(res, "restart", "all");
    if (pathname === "/api/core/start") return handleManageAction(res, "start", "core");
    if (pathname === "/api/core/stop") return handleManageAction(res, "stop", "core");
    if (pathname === "/api/direct/start") return handleManageAction(res, "start", "direct");
    if (pathname === "/api/direct/stop") return handleManageAction(res, "stop", "direct");
    if (pathname === "/api/open-logs-folder") {
      handleOpenLogsFolder(res);
      return;
    }
    // POST /api/direct-sessions/:sessionId/finalize — finalize a direct session
    // (must be matched BEFORE any generic /api/direct-sessions/:sessionId pattern)
    const finalizeDirectMatch = pathname.match(/^\/api\/direct-sessions\/([^/]+)\/finalize$/);
    if (finalizeDirectMatch) {
      let sessionId: string;
      try {
        sessionId = decodeURIComponent(finalizeDirectMatch[1]);
      } catch {
        sessionId = finalizeDirectMatch[1];
      }
      await handleDirectSessionFinalize(res, sessionId);
      return;
    }
    // POST /api/direct-sessions/:sessionId/audit — audit a direct session
    const auditDirectMatch = pathname.match(/^\/api\/direct-sessions\/([^/]+)\/audit$/);
    if (auditDirectMatch) {
      let sessionId: string;
      try {
        sessionId = decodeURIComponent(auditDirectMatch[1]);
      } catch {
        sessionId = auditDirectMatch[1];
      }
      handleDirectSessionAudit(res, sessionId);
      return;
    }
    // POST /api/direct-sessions/:sessionId/hide — hide a direct session from the list
    const hideDirectMatch = pathname.match(/^\/api\/direct-sessions\/([^/]+)\/hide$/);
    if (hideDirectMatch) {
      let sessionId: string;
      try {
        sessionId = decodeURIComponent(hideDirectMatch[1]);
      } catch {
        sessionId = hideDirectMatch[1];
      }
      handleDirectSessionHide(res, sessionId);
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
      handleReconcile(res, taskId);
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
      handleTaskAudit(res, taskId);
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
      handleOpenTaskFolder(res, taskId);
      return;
    }
    // POST /api/tasks/:taskId/hide-stale — hide a stale task from the dashboard
    const hideStaleMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/hide-stale$/);
    if (hideStaleMatch) {
      let taskId: string;
      try {
        taskId = decodeURIComponent(hideStaleMatch[1]);
      } catch {
        taskId = hideStaleMatch[1];
      }
      handleHideStale(res, taskId);
      return;
    }
    // POST /api/evidence-packs/:lineageId/export — export an evidence pack for a lineage
    const exportPackMatch = pathname.match(/^\/api\/evidence-packs\/([^/]+)\/export$/);
    if (exportPackMatch) {
      let lineageId: string;
      try {
        lineageId = decodeURIComponent(exportPackMatch[1]);
      } catch {
        lineageId = exportPackMatch[1];
      }
      handleEvidencePackExport(res, lineageId);
      return;
    }
    sendJson(res, 404, { error: "Not found" });
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

// ── Server bootstrap ──────────────────────────────────────────────

let server: Server | null = null;

export function startServer(): Server {
  server = createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: errorMessage(err) });
      } else {
        try { res.end(); } catch { /* ignore */ }
      }
    });
  });

  server.on("error", (err) => {
    logger.fatal("[control-center] Server error", { error: errorMessage(err) });
    process.exit(1);
  });

  server.listen(port, host, () => {
    const addr = server!.address();
    const formatted = addr && typeof addr === "object" ? `http://${addr.address}:${addr.port}/` : `http://${host}:${port}/`;
    logger.info(`[control-center] PatchWarden v${PATCHWARDEN_VERSION} (schema epoch ${TOOL_SCHEMA_EPOCH})`);
    logger.info(`[control-center] Workspace: ${config.workspaceRoot}`);
    logger.info(`[control-center] Listening: ${formatted}`);
    logger.info(`[control-center] Bound to 127.0.0.1 only — not exposed to network`);
    // Persist status file so the launcher can detect a running instance and
    // open the browser without spawning a second server.
    writeStatusFile();
    recordEvent("control_center.started", {
      pid: process.pid,
      port,
      url: formatted,
      version: PATCHWARDEN_VERSION,
    });
  });

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return server;
}

function shutdown(): void {
  logger.info("[control-center] Shutting down...");
  recordEvent("control_center.stopped", { pid: process.pid });
  removeStatusFile();
  if (server) {
    server.close(() => {
      try { process.exit(0); } catch { /* ignore */ }
    });
  }
  setTimeout(() => {
    try { process.exit(0); } catch { /* ignore */ }
  }, 3000).unref();
}
