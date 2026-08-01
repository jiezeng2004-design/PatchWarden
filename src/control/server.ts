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
import { performance } from "node:perf_hooks";
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
  sendJson,
} from "./shared.js";
import { recordEvent, removeStatusFile, writeStatusFile } from "./runtime.js";
import { checkControlToken, isTrustedControlHost } from "./middleware/auth.js";
import { serveFavicon, serveStatic } from "./middleware/static.js";
import { buildRoutes } from "./routeTable.js";
import {
  startArchivedTaskCleanupScheduler,
  type ArchivedTaskCleanupScheduler,
} from "../tools/tasks/pruneArchivedTasks.js";
import { clearControlDataCache } from "./dataCache.js";

// ── Request router ────────────────────────────────────────────────

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const startedAt = performance.now();
  const requestPath = String(req.url || "/").split(/[?#]/, 1)[0].slice(0, 240);
  if (requestPath.startsWith("/api/")) {
    res.once("finish", () => {
      const durationMs = Math.round((performance.now() - startedAt) * 10) / 10;
      if (durationMs < 250) return;
      const context = { method: String(req.method || "GET").toUpperCase(), path: requestPath, status: res.statusCode, duration_ms: durationMs };
      if (durationMs >= 2_000) logger.warn("[control-center] Slow API request", context);
      else logger.info("[control-center] API request timing", context);
    });
  }
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; base-uri 'none'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; form-action 'self'; connect-src 'self'; img-src 'self' data:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
  );
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");

  if (!isTrustedControlHost(req, port)) {
    sendJson(res, 421, { error: "Untrusted Host header" });
    return;
  }

  const parsedUrl = new URL(req.url || "/", `http://${host}:${port}`);
  const pathname = parsedUrl.pathname;
  const method = (req.method || "GET").toUpperCase();

  // ── Static resource priority branches (not in routeTable.ts) ──
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
      pathname === "/desktop.css" ||
      pathname === "/desktop-bridge.js" ||
      pathname === "/log-parser.js" ||
      pathname === "/i18n.js" ||
      pathname === "/getting-started.js" ||
      pathname === "/settings.js" ||
      pathname.startsWith("/pages/") ||
      pathname.startsWith("/partials/") ||
      pathname.startsWith("/vendor/"))
  ) {
    serveStatic(res, pathname);
    return;
  }

  // ── POST routes: drain body + verify control token before dispatch ──
  // All POST routes in the table declare `requiresToken: true`; the body is
  // drained up-front so HTTP keep-alive connections stay clean even when the
  // route is unknown (preserving the original handleRequest behavior).
  let requestBody: unknown | null = null;
  if (method === "POST") {
    requestBody = await readBody(req);
    if (!checkControlToken(req)) {
      sendJson(res, 403, { error: "Missing or invalid control token" });
      return;
    }
  }

  // ── Declarative route table dispatch ──
  // Filter by method → match pattern (in declaration order, so specific
  // patterns win over generic `:id`) → call handler with capture-group slice.
  const routes = buildRoutes(parsedUrl, requestBody);
  for (const route of routes) {
    if (route.method !== method) continue;
    const match = pathname.match(route.pattern);
    if (!match) continue;
    if (method === "POST") clearControlDataCache();
    await route.handler(res, match.slice(1));
    if (method === "POST") clearControlDataCache();
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

// ── Server bootstrap ──────────────────────────────────────────────

let server: Server | null = null;
let archivedTaskCleanup: ArchivedTaskCleanupScheduler | null = null;

export function startServer(): Server {
  archivedTaskCleanup?.stop();
  archivedTaskCleanup = null;
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
    archivedTaskCleanup = startArchivedTaskCleanupScheduler({ config, initialDelayMs: 250 });
  });

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return server;
}

function shutdown(): void {
  logger.info("[control-center] Shutting down...");
  recordEvent("control_center.stopped", { pid: process.pid });
  removeStatusFile();
  archivedTaskCleanup?.stop();
  archivedTaskCleanup = null;
  if (server) {
    server.close(() => {
      try { process.exit(0); } catch { /* ignore */ }
    });
  }
  setTimeout(() => {
    try { process.exit(0); } catch { /* ignore */ }
  }, 3000).unref();
}
