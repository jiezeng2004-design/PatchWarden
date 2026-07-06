import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ALLOWED_LOG_TAILS } from "./constants.js";

// ── Error message helper ─────────────────────────────────────────────

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── JSON response helper ─────────────────────────────────────────────

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

// ── Request body reader ──────────────────────────────────────────────

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

// ── Safe file readers ────────────────────────────────────────────────

export function readJsonFileSafe<T = unknown>(filePath: string): T | null {
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw) as T;
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

// ── Tail parameter resolver ──────────────────────────────────────────

export function resolveTailParam(value: string | null): number {
  if (value === null) return 100;
  const n = parseInt(value, 10);
  if (Number.isFinite(n) && ALLOWED_LOG_TAILS.has(n)) return n;
  return 100;
}

// ── File mtime ISO helper ────────────────────────────────────────────

export function fileMtimeIso(filePath: string): string | null {
  try {
    const m = statSync(filePath).mtime;
    return m ? m.toISOString() : null;
  } catch {
    return null;
  }
}