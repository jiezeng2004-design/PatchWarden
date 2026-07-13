#!/usr/bin/env node
/**
 * PatchWarden MCP Server — HTTP (Streamable HTTP) transport
 *
 * Binds to 127.0.0.1 only. Never exposes to LAN or public internet.
 * Use with OpenAI tunnel-client or ChatGPT Connector.
 *
 * Each HTTP request gets its own MCP Server + transport instance
 * to avoid "Already connected" errors from reusing a single Server.
 *
 * Config options (in patchwarden.config.json):
 *   httpPort: number (default 7331)
 *
 * Run: node dist/httpServer.js
 *   or: npm run start:http
 */

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig, getTasksDir } from "./config.js";
import { registerTools } from "./tools/registry.js";
import { healthCheck } from "./tools/healthCheck.js";
import { getToolCatalogSnapshot } from "./tools/registry.js";
import { PATCHWARDEN_VERSION } from "./version.js";
import { logger } from "./logging.js";

// ── Bootstrap ─────────────────────────────────────────────────────

const config = loadConfig();
const port = parseInt(process.env.PATCHWARDEN_HTTP_PORT || "") ||
  config.httpPort ||
  7331;
const host = "127.0.0.1";

logger.info(`[patchwarden-http] Workspace: ${config.workspaceRoot}`);
logger.info(`[patchwarden-http] Listening:  http://${host}:${port}/mcp`);
logger.info(`[patchwarden-http] ⚠️  Bound to 127.0.0.1 only — not exposed to network`);

// ── Owner token (optional) ────────────────────────────────────────

const httpCfg = config.http || {};
const ownerTokenEnv = httpCfg.ownerTokenEnv || "PATCHWARDEN_OWNER_TOKEN";
const ownerToken = process.env[ownerTokenEnv] || "";

if (ownerToken) {
  logger.info(`[patchwarden-http] 🔒 Owner token required (env: ${ownerTokenEnv})`);
} else {
  logger.info(`[patchwarden-http] ⚠️  No owner token set — all local requests accepted`);
}

function checkOwnerToken(req: IncomingMessage): boolean {
  if (!ownerToken) return true; // no token configured — allow all

  const authHeader = req.headers["authorization"] || "";
  const customHeader = req.headers["x-patchwarden-token"] || "";

  if (authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7) === ownerToken;
  }

  if (typeof customHeader === "string" && customHeader.length > 0) {
    return customHeader === ownerToken;
  }

  return false;
}

// ── Acceptance helpers ────────────────────────────────────────────

function getAcceptancePath(taskId: string): string {
  const tasksDir = getTasksDir(config);
  return join(resolve(tasksDir, taskId), "acceptance.json");
}

function handleAcceptance(taskId: string, status: "accepted" | "rejected", body: string): object {
  const filePath = getAcceptancePath(taskId);
  const taskDir = join(resolve(getTasksDir(config), taskId));
  if (!existsSync(taskDir)) {
    throw Object.assign(new Error(`Task "${taskId}" not found.`), { statusCode: 404 });
  }
  let notes = "";
  try {
    const parsed = JSON.parse(body || "{}");
    notes = String(parsed.notes || parsed.reason || "");
  } catch {
    // no body or invalid JSON — notes stays empty
  }
  const acceptance = {
    status,
    reviewed_at: new Date().toISOString(),
    reviewer: "human",
    notes,
  };
  writeFileSync(filePath, JSON.stringify(acceptance, null, 2), "utf-8");

  // Also update the task's status.json with acceptance_status
  const statusFile = join(taskDir, "status.json");
  if (existsSync(statusFile)) {
    try {
      const current = JSON.parse(readFileSync(statusFile, "utf-8"));
      current.acceptance_status = status;
      current.acceptance_reviewed_at = acceptance.reviewed_at;
      writeFileSync(statusFile, JSON.stringify(current, null, 2), "utf-8");
    } catch {
      // status.json update is best-effort
    }
  }
  return acceptance;
}

function readAcceptance(taskId: string): object {
  const filePath = getAcceptancePath(taskId);
  if (!existsSync(filePath)) {
    return { status: "pending", reviewed_at: null, reviewer: null, notes: null };
  }
  return JSON.parse(readFileSync(filePath, "utf-8"));
}

// ── Helpers ───────────────────────────────────────────────────────

/** Create a fresh MCP Server with tools registered */
function createMcpServer(): Server {
  const server = new Server(
    { name: "patchwarden", version: PATCHWARDEN_VERSION },
    { capabilities: { tools: {} } }
  );
  registerTools(server);
  return server;
}

/** Handle one MCP request with its own server+transport lifecycle */
async function handleMcpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Fresh instances per request — no shared state, no "already connected" errors
  const mcpServer = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
  });

  try {
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res);
  } catch (err) {
    logger.error("[patchwarden-http] Request error", {
      error: err instanceof Error ? err.message : String(err),
    });
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
  } finally {
    // Always close to free resources
    try {
      await transport.close();
    } catch {
      // best effort
    }
    try {
      await mcpServer.close();
    } catch {
      // best effort
    }
  }
}

// ── Parse URL for admin routes ────────────────────────────────────

function parseAdminUrl(url: string) {
  // Match: /admin/tasks/:id/accept, /admin/tasks/:id/reject, /admin/tasks/:id/acceptance
  const acceptMatch = url.match(/^\/admin\/tasks\/(task_\w+)\/accept$/);
  if (acceptMatch) return { taskId: acceptMatch[1], action: "accept" as const };
  const rejectMatch = url.match(/^\/admin\/tasks\/(task_\w+)\/reject$/);
  if (rejectMatch) return { taskId: rejectMatch[1], action: "reject" as const };
  const readMatch = url.match(/^\/admin\/tasks\/(task_\w+)\/acceptance$/);
  if (readMatch) return { taskId: readMatch[1], action: "get_acceptance" as const };
  return null;
}

// ── HTTP server ───────────────────────────────────────────────────

const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  // Health check endpoints
  if (req.method === "GET" && (req.url === "/healthz" || req.url === "/readyz")) {
    const health = healthCheck(getToolCatalogSnapshot());
    const ready = health.mcp_server.available && health.workspace_root.available && health.tasks_dir.available;
    res.writeHead(req.url === "/readyz" && !ready ? 503 : 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ...health, ready }));
    return;
  }

  // Admin acceptance endpoints
  const admin = parseAdminUrl(req.url || "");
  if (admin) {
    if (!checkOwnerToken(req)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized — invalid or missing owner token" }));
      return;
    }
    try {
      if (admin.action === "get_acceptance" && req.method === "GET") {
        const acceptance = readAcceptance(admin.taskId);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(acceptance, null, 2));
        return;
      }
      if ((admin.action === "accept" || admin.action === "reject") && req.method === "POST") {
        const chunks: Buffer[] = [];
        for await (const chunk of req) { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); }
        const body = Buffer.concat(chunks).toString("utf-8");
        const acceptance = handleAcceptance(admin.taskId, admin.action === "accept" ? "accepted" : "rejected", body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(acceptance, null, 2));
        return;
      }
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed for this admin endpoint." }));
    } catch (err: any) {
      const statusCode = err.statusCode || 500;
      res.writeHead(statusCode, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message || "Internal server error" }));
    }
    return;
  }

  // MCP endpoint
  if (req.url !== "/mcp" && req.url !== "/mcp/") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      error_code: "mcp_endpoint_not_found",
      error: "PatchWarden MCP endpoint not found.",
      expected_path: "/mcp",
      health_path: "/healthz",
      admin_paths: {
        accept: "POST /admin/tasks/:id/accept",
        reject: "POST /admin/tasks/:id/reject",
        get_acceptance: "GET /admin/tasks/:id/acceptance",
      },
      suggestion: "Use POST /mcp for MCP requests, GET /healthz for local diagnostics, or /admin/tasks/:id/accept for human review.",
    }));
    return;
  }

  // Owner token check (if configured)
  if (!checkOwnerToken(req)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorized — invalid or missing owner token" }));
    return;
  }

  await handleMcpRequest(req, res);
});

// ── Start ─────────────────────────────────────────────────────────

httpServer.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    logger.fatal(`[patchwarden-http] Fatal: port ${port} is already in use on ${host}.`);
    logger.fatal("[patchwarden-http] Stop the other PatchWarden HTTP instance or change httpPort in patchwarden.config.json.");
  } else {
    logger.fatal(`[patchwarden-http] Fatal: ${err.message}`);
  }
  process.exit(1);
});

httpServer.listen(port, host, () => {
  logger.info(`[patchwarden-http] ✅ Ready`);
  logger.info(`[patchwarden-http] Admin:    http://${host}:${port}/admin/tasks/:id/accept`);
});

// Graceful shutdown
process.on("SIGINT", () => {
  logger.info("[patchwarden-http] Shutting down...");
  httpServer.close(() => process.exit(0));
});

process.on("SIGTERM", () => {
  httpServer.close(() => process.exit(0));
});
