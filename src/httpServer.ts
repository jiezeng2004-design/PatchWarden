#!/usr/bin/env node
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { getTasksDir, loadConfig, type PatchWardenConfig } from "./config.js";
import { registerTools, getToolCatalogSnapshot } from "./tools/registry.js";
import { healthCheck } from "./tools/diagnostics/healthCheck.js";
import { PATCHWARDEN_VERSION } from "./version.js";
import { logger } from "./logging.js";
import { firstHeaderValue, timingSafeStringEqual } from "./security/secretComparison.js";
import { isTrustedLoopbackHostHeader } from "./security/loopbackHost.js";
import { verifyTaskAttestation } from "./attestation/attestationStore.js";

export interface HttpLimits {
  maxMcpBodyBytes: number;
  maxConcurrentRequests: number;
  bodyReadTimeoutMs: number;
  handlerTimeoutMs: number;
  headersTimeoutMs: number;
  requestTimeoutMs: number;
  keepAliveTimeoutMs: number;
  maxHeadersCount: number;
}

export const HTTP_LIMITS: Readonly<HttpLimits> = Object.freeze({
  maxMcpBodyBytes: 1024 * 1024,
  maxConcurrentRequests: 8,
  bodyReadTimeoutMs: 10_000,
  handlerTimeoutMs: 45_000,
  headersTimeoutMs: 10_000,
  requestTimeoutMs: 55_000,
  keepAliveTimeoutMs: 5_000,
  maxHeadersCount: 64,
});

const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
} as const;

export interface PatchWardenHttpServerOptions {
  config: PatchWardenConfig;
  ownerToken: string;
  host?: "127.0.0.1";
  port: number;
  limits?: Partial<HttpLimits>;
}

function jsonResponse(res: ServerResponse, status: number, value: unknown, extra: Record<string, string> = {}): void {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(status, { ...SECURITY_HEADERS, ...extra });
  res.end(JSON.stringify(value));
}

function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

function requestAuthorized(req: IncomingMessage, ownerToken: string): boolean {
  if (!ownerToken) return false;
  const authHeader = firstHeaderValue(req.headers.authorization);
  const customHeader = firstHeaderValue(req.headers["x-patchwarden-token"]);
  if (authHeader.startsWith("Bearer ")) return timingSafeStringEqual(authHeader.slice(7), ownerToken);
  return customHeader.length > 0 && timingSafeStringEqual(customHeader, ownerToken);
}

function parseAdminUrl(pathname: string) {
  const match = pathname.match(/^\/admin\/tasks\/(task[_-][A-Za-z0-9_-]{1,160})\/(accept|reject|acceptance)$/);
  if (!match) return null;
  return { taskId: match[1], action: match[2] as "accept" | "reject" | "acceptance" };
}

function readAcceptance(config: PatchWardenConfig, taskId: string): object {
  const taskDir = join(getTasksDir(config), taskId);
  if (!existsSync(taskDir)) throw httpError(404, `Task "${taskId}" not found.`);
  const verification = verifyTaskAttestation(taskId, taskDir, config.workspaceRoot);
  if (verification.required) {
    return {
      status: verification.valid ? verification.decision : "pending",
      authoritative: verification.valid,
      authority: "external_ledger_v1",
      reason: verification.reason,
      reviewed_at: verification.attestation?.reviewed_at || null,
      evidence_sha256: verification.attestation?.evidence_sha256 || null,
    };
  }
  const legacyPath = join(taskDir, "acceptance.json");
  if (!existsSync(legacyPath)) {
    return { status: "pending", authoritative: false, authority: "legacy_unattested", reviewed_at: null };
  }
  const legacy = JSON.parse(readFileSync(legacyPath, "utf-8")) as Record<string, unknown>;
  return { ...legacy, authoritative: false, authority: "legacy_unattested" };
}

async function readBoundedJsonBody(req: IncomingMessage, maxBytes: number, timeoutMs: number): Promise<unknown> {
  const declared = firstHeaderValue(req.headers["content-length"]);
  if (declared) {
    const value = Number(declared);
    if (!Number.isSafeInteger(value) || value < 0) throw httpError(400, "Invalid Content-Length header.");
    if (value > maxBytes) {
      req.resume();
      throw httpError(413, `Request body exceeds ${maxBytes} bytes.`);
    }
  }
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectBody(error);
      else resolveBody(value);
    };
    const timer = setTimeout(() => {
      req.resume();
      finish(httpError(408, "Request body read timed out."));
    }, timeoutMs);
    timer.unref();
    req.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > maxBytes) {
        req.resume();
        finish(httpError(413, `Request body exceeds ${maxBytes} bytes.`));
      } else {
        chunks.push(buffer);
      }
    });
    req.on("end", () => {
      if (settled) return;
      try {
        const text = Buffer.concat(chunks).toString("utf-8");
        finish(undefined, text.length > 0 ? JSON.parse(text) : undefined);
      } catch {
        finish(httpError(400, "Request body must be valid JSON."));
      }
    });
    req.on("error", (error) => finish(error));
    req.on("aborted", () => finish(httpError(400, "Request was aborted.")));
  });
}

function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: "patchwarden", version: PATCHWARDEN_VERSION },
    { capabilities: { tools: {} } },
  );
  registerTools(server);
  return server;
}

async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  parsedBody: unknown,
  timeoutMs: number,
): Promise<void> {
  const mcpServer = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  let timeout: NodeJS.Timeout | undefined;
  try {
    await mcpServer.connect(transport);
    await Promise.race([
      transport.handleRequest(req, res, parsedBody),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(httpError(504, "MCP request exceeded its execution budget.")), timeoutMs);
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    try { await transport.close(); } catch { /* best effort */ }
    try { await mcpServer.close(); } catch { /* best effort */ }
  }
}

export function createPatchWardenHttpServer(options: PatchWardenHttpServerOptions): Server {
  const { config, ownerToken, port } = options;
  const host = options.host || "127.0.0.1";
  const limits = { ...HTTP_LIMITS, ...(options.limits || {}) };
  let activeRequests = 0;

  const server = createServer(async (req, res) => {
    const boundAddress = server.address();
    const expectedPort = port === 0 && boundAddress && typeof boundAddress === "object"
      ? boundAddress.port
      : port;
    if (!isTrustedLoopbackHostHeader(req.headers.host, expectedPort)) {
      jsonResponse(res, 421, { error_code: "untrusted_host", error: "Untrusted Host header." });
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url || "/", `http://${host}:${expectedPort}`);
    } catch {
      jsonResponse(res, 400, { error_code: "invalid_url", error: "Request URL is invalid." });
      return;
    }
    const isHealth = req.method === "GET" && (url.pathname === "/healthz" || url.pathname === "/readyz");
    if (isHealth) {
      const health = healthCheck(getToolCatalogSnapshot());
      const ready = Boolean(health.mcp_server.available && health.workspace_root.available && health.tasks_dir.available && ownerToken);
      const detailed = url.searchParams.get("detail") === "full";
      if (detailed && !requestAuthorized(req, ownerToken)) {
        jsonResponse(res, 401, { error_code: "unauthorized", error: "Owner token required." });
        return;
      }
      const status = url.pathname === "/readyz" && !ready ? 503 : 200;
      jsonResponse(res, status, detailed
        ? { ...health, ready, authentication: { configured: Boolean(ownerToken) } }
        : { service: "patchwarden", status: ready ? "ok" : "degraded", ready });
      return;
    }

    const admin = parseAdminUrl(url.pathname);
    if (admin) {
      if (!requestAuthorized(req, ownerToken)) {
        jsonResponse(res, 401, { error_code: "unauthorized", error: "Owner token required." });
        return;
      }
      if (admin.action === "acceptance" && req.method === "GET") {
        try { jsonResponse(res, 200, readAcceptance(config, admin.taskId)); }
        catch (error) {
          const status = Number((error as { statusCode?: number }).statusCode) || 500;
          jsonResponse(res, status, { error_code: "acceptance_read_failed", error: error instanceof Error ? error.message : "Read failed." });
        }
        return;
      }
      if ((admin.action === "accept" || admin.action === "reject") && req.method === "POST") {
        // An MCP owner token proves API ownership, not a local user gesture.
        // Signing is intentionally available only through patchwarden-attest.
        req.resume();
        jsonResponse(res, 409, {
          error_code: "local_attestation_required",
          error: "Authoritative review requires the local interactive patchwarden-attest CLI.",
          command: `patchwarden-attest ${admin.taskId} --${admin.action}`,
        });
        return;
      }
      jsonResponse(res, 405, { error_code: "method_not_allowed", error: "Method not allowed." }, { Allow: admin.action === "acceptance" ? "GET" : "POST" });
      return;
    }

    if (url.pathname !== "/mcp" && url.pathname !== "/mcp/") {
      jsonResponse(res, 404, {
        error_code: "mcp_endpoint_not_found",
        error: "PatchWarden MCP endpoint not found.",
        expected_path: "/mcp",
        health_path: "/healthz",
      });
      return;
    }
    if (!requestAuthorized(req, ownerToken)) {
      req.resume();
      jsonResponse(res, 401, { error_code: "unauthorized", error: "Owner token required." });
      return;
    }
    if (req.method !== "POST") {
      req.resume();
      jsonResponse(res, 405, { error_code: "method_not_allowed", error: "MCP requests must use POST." }, { Allow: "POST" });
      return;
    }
    if (!firstHeaderValue(req.headers["content-type"]).toLowerCase().startsWith("application/json")) {
      req.resume();
      jsonResponse(res, 415, { error_code: "unsupported_media_type", error: "MCP requests require application/json." });
      return;
    }
    if (activeRequests >= limits.maxConcurrentRequests) {
      req.resume();
      jsonResponse(res, 429, { error_code: "concurrency_limit", error: "HTTP MCP concurrency budget exhausted." }, { "Retry-After": "1" });
      return;
    }

    activeRequests += 1;
    try {
      const body = await readBoundedJsonBody(req, limits.maxMcpBodyBytes, limits.bodyReadTimeoutMs);
      await handleMcpRequest(req, res, body, limits.handlerTimeoutMs);
    } catch (error) {
      const status = Number((error as { statusCode?: number }).statusCode) || 500;
      if (status >= 500) logger.error("[patchwarden-http] Request failed", { error: error instanceof Error ? error.message : String(error) });
      jsonResponse(res, status, {
        error_code: status === 413 ? "body_too_large" : status === 504 ? "request_timeout" : "request_failed",
        error: status >= 500 && status !== 504 ? "Internal server error." : error instanceof Error ? error.message : "Request failed.",
      });
    } finally {
      activeRequests -= 1;
    }
  });

  server.headersTimeout = limits.headersTimeoutMs;
  server.requestTimeout = limits.requestTimeoutMs;
  server.keepAliveTimeout = limits.keepAliveTimeoutMs;
  server.maxHeadersCount = limits.maxHeadersCount;
  return server;
}

export function startPatchWardenHttpServer(): Server {
  const config = loadConfig();
  const configuredPort = process.env.PATCHWARDEN_HTTP_PORT;
  const port = configuredPort !== undefined ? Number(configuredPort) : (config.http?.port || config.httpPort || 7331);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("PATCHWARDEN_HTTP_PORT must be an integer from 1 to 65535.");
  const ownerTokenEnv = config.http?.ownerTokenEnv || "PATCHWARDEN_OWNER_TOKEN";
  const ownerToken = process.env[ownerTokenEnv] || "";
  if (!ownerToken) throw new Error(`HTTP MCP requires an owner token in ${ownerTokenEnv}.`);
  const host = "127.0.0.1" as const;
  const server = createPatchWardenHttpServer({ config, ownerToken, host, port });
  server.on("error", (error: NodeJS.ErrnoException) => {
    logger.fatal(`[patchwarden-http] Fatal: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(port, host, () => {
    logger.info(`[patchwarden-http] Ready on http://${host}:${port}/mcp (owner token: ${ownerTokenEnv})`);
  });
  return server;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    const server = startPatchWardenHttpServer();
    process.on("SIGINT", () => server.close(() => process.exit(0)));
    process.on("SIGTERM", () => server.close(() => process.exit(0)));
  } catch (error) {
    logger.fatal(`[patchwarden-http] Fatal: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
