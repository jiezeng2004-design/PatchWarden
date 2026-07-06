import { join } from "node:path";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";

// ── Page aliases ─────────────────────────────────────────────────────

export const PAGE_ALIASES: Record<string, string> = {
  "/dashboard.html": "pages/dashboard.html",
  "/tasks.html": "pages/tasks.html",
  "/workspace.html": "pages/workspace.html",
  "/audit.html": "pages/audit.html",
  "/task-detail.html": "pages/task-detail.html",
  "/direct-sessions.html": "pages/direct-sessions.html",
  "/logs.html": "pages/logs.html",
};

// ── URLs and defaults ────────────────────────────────────────────────

export const CORE_BASE_URL = process.env.PATCHWARDEN_CORE_URL || "http://127.0.0.1:8080";
export const DIRECT_BASE_URL = process.env.PATCHWARDEN_DIRECT_URL || "http://127.0.0.1:8081";
export const DEFAULT_TUNNEL_CLIENT_EXE = "D:\\ai_agent\\tunnel-client-v0.0.9--context-conduit-topaz-windows-amd64\\tunnel-client.exe";

// ── Favicon ──────────────────────────────────────────────────────────

export const CONTROL_CENTER_FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#0a0e14"/>
  <path d="M32 52s17-8 17-27V14L32 8 15 14v11c0 19 17 27 17 27z" fill="#111820" stroke="#2dd4a8" stroke-width="4" stroke-linejoin="round"/>
  <path d="M24 32l6 6 12-14" fill="none" stroke="#2dd4a8" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

// ── Content types ────────────────────────────────────────────────────

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

// ── Log tail limits ──────────────────────────────────────────────────

export const ALLOWED_LOG_TAILS = new Set([100, 300, 1000]);

// ── Event limits ─────────────────────────────────────────────────────

export const MAX_EVENT_LINES = 2000;

// ── Runtime root helper ──────────────────────────────────────────────

export function getRuntimeRoot(direct: boolean): string {
  const base =
    process.platform === "win32" && process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, "patchwarden")
      : join(homedir(), ".patchwarden");
  return join(base, direct ? "runtime-direct" : "runtime");
}

export function getControlCenterLogDir(): string {
  const override = process.env.PATCHWARDEN_CONTROL_LOG_DIR;
  if (override && isAbsolute(override)) return override;
  const base =
    process.platform === "win32" && process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, "patchwarden")
      : join(homedir(), ".patchwarden");
  return join(base, "control-center");
}