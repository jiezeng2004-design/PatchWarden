/**
 * PatchWarden Control Center — shared infrastructure.
 *
 * Holds the fault-tolerant config bootstrap, path constants, the in-memory
 * control token, port resolution, and the generic HTTP/file helpers reused by
 * every route module. Importing this module performs the same bootstrap side
 * effects the original monolithic controlCenter.ts did (config load, token
 * generation, port resolution) so that a single import wires up the runtime.
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { type IncomingMessage, type ServerResponse } from "node:http";
import { loadConfig, type PatchWardenConfig } from "../config.js";
import { logger } from "../logging.js";

// ── Paths ─────────────────────────────────────────────────────────

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const uiRoot = join(projectRoot, "ui");
export const manageScriptPath = join(projectRoot, "scripts", "control", "manage-patchwarden.ps1");

function resolveActiveConfigPath(): string {
  if (process.env.PATCHWARDEN_CONFIG) return resolve(process.env.PATCHWARDEN_CONFIG);
  for (const name of ["patchwarden.config.json", ".patchwarden.json"]) {
    const candidate = resolve(process.cwd(), name);
    if (existsSync(candidate)) return candidate;
  }
  return resolve(process.cwd(), "patchwarden.config.json");
}

export const activeConfigPath = resolveActiveConfigPath();
export const configIdentitySha256 = createHash("sha256")
  .update(process.platform === "win32" ? activeConfigPath.toLowerCase() : activeConfigPath)
  .digest("hex");

export const PAGE_ALIASES: Record<string, string> = {
  "/getting-started.html": "pages/getting-started.html",
  "/dashboard.html": "pages/dashboard.html",
  "/tasks.html": "pages/tasks.html",
  "/workspace.html": "pages/workspace.html",
  "/audit.html": "pages/audit.html",
  "/task-detail.html": "pages/task-detail.html",
  "/direct-sessions.html": "pages/direct-sessions.html",
  "/logs.html": "pages/logs.html",
  "/settings.html": "pages/settings.html",
};

// ── Config (fault-tolerant bootstrap) ─────────────────────────────

export function createFallbackConfig(): PatchWardenConfig {
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

export let config: PatchWardenConfig;
try {
  config = loadConfig();
} catch (err) {
  logger.warn(`[control-center] WARNING: Failed to load config. Using fallback defaults.`, {
    error: errorMessage(err),
  });
  config = createFallbackConfig();
}

// ── Control token (in-memory only) ────────────────────────────────

export const controlToken = randomUUID();

// ── Port resolution ───────────────────────────────────────────────

export function resolvePort(): number {
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

export const port = resolvePort();
export const host = "127.0.0.1";

// Core/Direct probe base URLs — overridable for tests so the smoke test does
// not depend on the real 8080/8081 ports being free on the host.
export const CORE_BASE_URL = process.env.PATCHWARDEN_CORE_URL || "http://127.0.0.1:8080";
export const DIRECT_BASE_URL = process.env.PATCHWARDEN_DIRECT_URL || "http://127.0.0.1:8081";
export const CONTROL_CENTER_FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#0a0e14"/>
  <path d="M32 52s17-8 17-27V14L32 8 15 14v11c0 19 17 27 17 27z" fill="#111820" stroke="#2dd4a8" stroke-width="4" stroke-linejoin="round"/>
  <path d="M24 32l6 6 12-14" fill="none" stroke="#2dd4a8" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

// ── Helpers ───────────────────────────────────────────────────────

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function getRuntimeRoot(direct: boolean): string {
  const base =
    process.platform === "win32" && process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, "patchwarden")
      : join(homedir(), ".patchwarden");
  return join(base, direct ? "runtime-direct" : "runtime");
}

export function getControlCenterLogDir(): string {
  // Test/local override: when set to an absolute path, use it directly so the
  // smoke test can redirect status/events/log files into a sandbox-writable
  // directory under the project root instead of LOCALAPPDATA.
  const override = process.env.PATCHWARDEN_CONTROL_LOG_DIR;
  if (override && isAbsolute(override)) return override;
  const base =
    process.platform === "win32" && process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, "patchwarden")
      : join(homedir(), ".patchwarden");
  return join(base, "control-center");
}

// Status + events files live alongside the control-center logs so the launcher
// can discover a running instance without probing the port blindly.
export const controlCenterStatusPath = join(getControlCenterLogDir(), "control-center-status.json");
export const controlCenterEventsPath = join(getControlCenterLogDir(), "control-center-events.jsonl");
export const MAX_EVENT_LINES = 2000;

export const ALLOWED_LOG_TAILS = new Set([100, 300, 1000]);

export function resolveTailParam(value: string | null): number {
  if (value === null) return 100;
  const n = parseInt(value, 10);
  if (Number.isFinite(n) && ALLOWED_LOG_TAILS.has(n)) return n;
  return 100;
}

export const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  let payload: string;
  try {
    payload = JSON.stringify(body);
  } catch (err) {
    payload = JSON.stringify({ error: `serialization failed: ${errorMessage(err)}` });
    status = 500;
  }
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(payload);
}

export function readBody(req: IncomingMessage): Promise<unknown | null> {
  return new Promise((resolve) => {
    let total = 0;
    const chunks: Buffer[] = [];
    let aborted = false;
    req.on("data", (chunk: Buffer) => {
      if (aborted) return;
      total += chunk.length;
      if (total > 1024 * 1024) {
        aborted = true;
        try { req.destroy(); } catch { /* ignore */ }
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (aborted) return;
      if (chunks.length === 0) {
        resolve(null);
        return;
      }
      const text = Buffer.concat(chunks).toString("utf-8");
      try {
        resolve(JSON.parse(text));
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

export function readJsonFileSafe<T = unknown>(filePath: string): T | null {
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw) as T;
  } catch {
    return null;
  }
}

export function isPathInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function readJsonFileSafeUnder<T = unknown>(root: string, relPath: string): T | null {
  const base = resolve(root);
  const target = resolve(base, relPath);
  if (!isPathInside(base, target) || !existsSync(target)) return null;
  try {
    const realBase = realpathSync(base);
    const realTarget = realpathSync(target);
    if (!isPathInside(realBase, realTarget)) return null;
    return readJsonFileSafe<T>(realTarget);
  } catch {
    return null;
  }
}

export function readTextFileSafe(filePath: string): string | null {
  if (!existsSync(filePath)) return null;
  try {
    return readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

export function readFileTail(filePath: string, lines = 100): string {
  if (!existsSync(filePath)) return "";
  const content = readFileSync(filePath, "utf-8");
  const allLines = content.split(/\r?\n/);
  if (allLines.length > 0 && allLines[allLines.length - 1] === "") allLines.pop();
  return allLines.slice(-lines).join("\n");
}

export function findLatestLog(dir: string, pattern: RegExp): string | null {
  if (!existsSync(dir)) return null;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const files = entries.filter((e) => e.isFile() && pattern.test(e.name));
  if (files.length === 0) return null;
  let latestName = files[0].name;
  let latestMtime = -1;
  for (const f of files) {
    try {
      const m = statSync(join(dir, f.name)).mtimeMs;
      if (m > latestMtime) {
        latestMtime = m;
        latestName = f.name;
      }
    } catch {
      /* keep current */
    }
  }
  return join(dir, latestName);
}

// Re-export widely-used node primitives so route modules have a single import
// surface for path/delimiter helpers that are also needed alongside the shared
// helpers above.
export { delimiter, extname, join, resolve, isAbsolute, relative };
