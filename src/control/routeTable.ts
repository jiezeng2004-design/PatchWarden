/**
 * PatchWarden Control Center — declarative route table.
 *
 * Exports `buildRoutes(parsedUrl)` which returns the full `Route[]` array
 * consumed by `server.ts`'s `handleRequest`. Routes that need query-string
 * parameters (e.g. `/api/tasks`, `/api/logs/:category`) close over `parsedUrl`
 * via the `query` helper, so each request gets its own self-contained table
 * without module-scoped request state. This keeps concurrent requests safe.
 *
 * Ordering rules:
 *   - GET routes first, POST routes second.
 *   - Within each method, more specific patterns precede generic `:id`
 *     patterns (e.g. `/api/tasks/stale` before `/api/tasks/:id`).
 *   - Static asset routes (`/`, `/favicon.ico`, CSS/JS, `/pages/`,
 *     `/partials/`, `/vendor/`) and `/control-token.json` are NOT in this
 *     table — they remain priority branches in `server.ts`.
 */
import { type Route, decodeParam, resolveTailParam, sendJson } from "./shared.js";
import { isValidTaskId } from "./runtime.js";
import {
  handleTasks,
  handleStaleTasks,
  handleTaskDetail,
  handleTaskSafeResult,
  handleTaskSafeAudit,
  handleTaskSafeTestSummary,
  handleTaskSafeDiffSummary,
} from "./routes/tasks.js";
import {
  handleReconcile,
  handleTaskAudit,
  handleOpenTaskFolder,
  handleHideStale,
} from "./routes/taskActions.js";
import {
  handleDirectSessions,
  handleDirectSessionDetail,
  handleDirectSessionSafeSummary,
  handleDirectSessionFinalize,
  handleDirectSessionAudit,
  handleDirectSessionHide,
} from "./routes/sessions.js";
import { handleLineages, handleLineageDetail } from "./routes/lineage.js";
import {
  handleEvidencePacks,
  handleEvidencePackDetail,
  handleEvidencePackExport,
} from "./routes/evidence.js";
import { handleProjectPolicy, handleReleaseStatus } from "./routes/policy.js";
import {
  handleWorkspace,
  handleWorkspaceRepos,
  handleWorkspaceRepoStatus,
} from "./routes/workspace.js";
import { handleManageAction, handleOpenLogsFolder } from "./routes/process.js";
import {
  handleStatus,
  handleControlCenterStatus,
  handleEvents,
  handleTunnelUiUrl,
  handleDiagnostics,
} from "./routes/status.js";
import { handleLogs, handleAudit, handleWarnings, type LogCategory } from "./routes/audit.js";

const KNOWN_LOG_CATEGORIES: ReadonlySet<LogCategory> = new Set([
  "core",
  "direct",
  "watcher",
  "control-center",
]);

/**
 * Build the per-request `Route[]` table. `parsedUrl` is captured by closures
 * so handlers that need query parameters can read `searchParams` without any
 * module-scoped state.
 */
export function buildRoutes(parsedUrl: URL): Route[] {
  const query = parsedUrl.searchParams;

  // ── GET routes (no token required) ──────────────────────────────
  const getRoutes: Route[] = [
    { method: "GET", pattern: /^\/api\/status$/, handler: (res) => handleStatus(res) },
    {
      method: "GET",
      pattern: /^\/api\/tasks$/,
      handler: (res) =>
        handleTasks(res, {
          repo_path: query.get("repo_path") || undefined,
          status: query.get("status") || undefined,
          acceptance_status: query.get("acceptance_status") || undefined,
          agent: query.get("agent") || undefined,
          warning_type: query.get("warning_type") || undefined,
          date_from: query.get("date_from") || undefined,
          date_to: query.get("date_to") || undefined,
          limit: query.get("limit") ? Number(query.get("limit")) : undefined,
          cursor: query.get("cursor") || undefined,
        }),
    },
    // /api/tasks/stale MUST precede /api/tasks/:id (stale matches the :id pattern).
    { method: "GET", pattern: /^\/api\/tasks\/stale$/, handler: (res) => handleStaleTasks(res) },
    { method: "GET", pattern: /^\/api\/lineages$/, handler: (res) => handleLineages(res) },
    {
      method: "GET",
      pattern: /^\/api\/lineages\/([^/]+)$/,
      handler: (res, p) => handleLineageDetail(res, decodeParam(p, 0)),
    },
    {
      method: "GET",
      pattern: /^\/api\/project-policy$/,
      handler: (res) => handleProjectPolicy(res, query.get("repo_path") || "."),
    },
    {
      method: "GET",
      pattern: /^\/api\/release\/status$/,
      handler: (res) => handleReleaseStatus(res, query.get("repo_path") || "."),
    },
    { method: "GET", pattern: /^\/api\/evidence-packs$/, handler: (res) => handleEvidencePacks(res) },
    {
      method: "GET",
      pattern: /^\/api\/evidence-packs\/([^/]+)$/,
      handler: (res, p) => handleEvidencePackDetail(res, decodeParam(p, 0)),
    },
    {
      method: "GET",
      pattern: /^\/api\/tasks\/([^/]+)$/,
      handler: (res, p) => {
        const taskId = decodeParam(p, 0);
        if (!isValidTaskId(taskId)) {
          sendJson(res, 400, { error: "Invalid task id" });
          return;
        }
        handleTaskDetail(res, taskId);
      },
    },
    // Safe, bounded views for task artifacts (no full stdout/stderr/diff).
    {
      method: "GET",
      pattern: /^\/api\/tasks\/([^/]+)\/safe-result$/,
      handler: (res, p) => handleTaskSafeResult(res, decodeParam(p, 0)),
    },
    {
      method: "GET",
      pattern: /^\/api\/tasks\/([^/]+)\/safe-audit$/,
      handler: (res, p) => handleTaskSafeAudit(res, decodeParam(p, 0)),
    },
    {
      method: "GET",
      pattern: /^\/api\/tasks\/([^/]+)\/safe-test-summary$/,
      handler: (res, p) => handleTaskSafeTestSummary(res, decodeParam(p, 0)),
    },
    {
      method: "GET",
      pattern: /^\/api\/tasks\/([^/]+)\/safe-diff-summary$/,
      handler: (res, p) => handleTaskSafeDiffSummary(res, decodeParam(p, 0)),
    },
    // /api/logs/<category>?tail=<100|300|1000>
    {
      method: "GET",
      pattern: /^\/api\/logs\/([a-z-]+)$/,
      handler: (res, p) => {
        const rawCat = p[0] || "";
        const category = KNOWN_LOG_CATEGORIES.has(rawCat as LogCategory)
          ? (rawCat as LogCategory)
          : null;
        if (!category) {
          sendJson(res, 404, { error: "Unknown log category" });
          return;
        }
        const tail = resolveTailParam(query.get("tail"));
        handleLogs(res, category, tail);
      },
    },
    { method: "GET", pattern: /^\/api\/workspace$/, handler: (res) => handleWorkspace(res) },
    // /api/workspace/repos MUST precede /api/workspace/:repo+/status (no segment conflict,
    // but preserved for ordering clarity).
    { method: "GET", pattern: /^\/api\/workspace\/repos$/, handler: (res) => handleWorkspaceRepos(res) },
    {
      method: "GET",
      pattern: /^\/api\/workspace\/([^/]+(?:\/[^/]+)*)\/status$/,
      handler: (res, p) => {
        const raw = p[0] || "";
        let repoParam: string;
        try {
          repoParam = decodeURIComponent(raw);
        } catch {
          sendJson(res, 400, { error: "Invalid repo path encoding" });
          return;
        }
        handleWorkspaceRepoStatus(res, repoParam);
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/direct-sessions$/,
      handler: (res) => handleDirectSessions(res, {
        state: (query.get("state") || undefined) as "active" | "archive" | "finalized" | "audited" | "expired" | undefined,
        repo_path: query.get("repo_path") || undefined,
        date_from: query.get("date_from") || undefined,
        date_to: query.get("date_to") || undefined,
        limit: query.get("limit") ? Number(query.get("limit")) : undefined,
        cursor: query.get("cursor") || undefined,
      }),
    },
    // /api/direct-sessions/:id/summary MUST precede /api/direct-sessions/:id.
    {
      method: "GET",
      pattern: /^\/api\/direct-sessions\/([^/]+)\/summary$/,
      handler: (res, p) => handleDirectSessionSafeSummary(res, decodeParam(p, 0)),
    },
    {
      method: "GET",
      pattern: /^\/api\/direct-sessions\/([^/]+)$/,
      handler: (res, p) => handleDirectSessionDetail(res, decodeParam(p, 0)),
    },
    { method: "GET", pattern: /^\/api\/audit$/, handler: (res) => handleAudit(res) },
    { method: "GET", pattern: /^\/api\/warnings$/, handler: (res) => handleWarnings(res) },
    { method: "GET", pattern: /^\/api\/diagnostics$/, handler: (res) => handleDiagnostics(res) },
    { method: "GET", pattern: /^\/api\/tunnel-ui-url$/, handler: (res) => handleTunnelUiUrl(res) },
    {
      method: "GET",
      pattern: /^\/api\/events$/,
      handler: (res) => {
        const limitParam = query.get("limit");
        let limit = 100;
        if (limitParam !== null) {
          const n = parseInt(limitParam, 10);
          if (Number.isFinite(n) && n > 0 && n <= 1000) limit = n;
        }
        handleEvents(res, limit);
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/control-center-status$/,
      handler: (res) => handleControlCenterStatus(res),
    },
  ];

  // ── POST routes (requiresToken: true) ──────────────────────────
  const postRoutes: Route[] = [
    { method: "POST", pattern: /^\/api\/start-all$/, requiresToken: true, handler: (res) => handleManageAction(res, "start", "all") },
    { method: "POST", pattern: /^\/api\/stop-all$/, requiresToken: true, handler: (res) => handleManageAction(res, "stop", "all") },
    { method: "POST", pattern: /^\/api\/restart-all$/, requiresToken: true, handler: (res) => handleManageAction(res, "restart", "all") },
    { method: "POST", pattern: /^\/api\/core\/start$/, requiresToken: true, handler: (res) => handleManageAction(res, "start", "core") },
    { method: "POST", pattern: /^\/api\/core\/stop$/, requiresToken: true, handler: (res) => handleManageAction(res, "stop", "core") },
    { method: "POST", pattern: /^\/api\/direct\/start$/, requiresToken: true, handler: (res) => handleManageAction(res, "start", "direct") },
    { method: "POST", pattern: /^\/api\/direct\/stop$/, requiresToken: true, handler: (res) => handleManageAction(res, "stop", "direct") },
    { method: "POST", pattern: /^\/api\/open-logs-folder$/, requiresToken: true, handler: (res) => handleOpenLogsFolder(res) },
    // /api/direct-sessions/:id/finalize MUST precede any generic /api/direct-sessions/:id pattern.
    {
      method: "POST",
      pattern: /^\/api\/direct-sessions\/([^/]+)\/finalize$/,
      requiresToken: true,
      handler: (res, p) => handleDirectSessionFinalize(res, decodeParam(p, 0)),
    },
    {
      method: "POST",
      pattern: /^\/api\/direct-sessions\/([^/]+)\/audit$/,
      requiresToken: true,
      handler: (res, p) => handleDirectSessionAudit(res, decodeParam(p, 0)),
    },
    {
      method: "POST",
      pattern: /^\/api\/direct-sessions\/([^/]+)\/hide$/,
      requiresToken: true,
      handler: (res, p) => handleDirectSessionHide(res, decodeParam(p, 0)),
    },
    {
      method: "POST",
      pattern: /^\/api\/tasks\/([^/]+)\/reconcile$/,
      requiresToken: true,
      handler: (res, p) => handleReconcile(res, decodeParam(p, 0)),
    },
    {
      method: "POST",
      pattern: /^\/api\/tasks\/([^/]+)\/audit$/,
      requiresToken: true,
      handler: (res, p) => handleTaskAudit(res, decodeParam(p, 0)),
    },
    {
      method: "POST",
      pattern: /^\/api\/tasks\/([^/]+)\/open-folder$/,
      requiresToken: true,
      handler: (res, p) => handleOpenTaskFolder(res, decodeParam(p, 0)),
    },
    {
      method: "POST",
      pattern: /^\/api\/tasks\/([^/]+)\/hide-stale$/,
      requiresToken: true,
      handler: (res, p) => handleHideStale(res, decodeParam(p, 0)),
    },
    {
      method: "POST",
      pattern: /^\/api\/evidence-packs\/([^/]+)\/export$/,
      requiresToken: true,
      handler: (res, p) => handleEvidencePackExport(res, decodeParam(p, 0)),
    },
  ];

  return [...getRoutes, ...postRoutes];
}
