/**
 * Control Center static file middleware.
 *
 * Serves the bundled `ui/` directory (dashboard pages, partials, vendor
 * assets, css) with path-traversal protection, plus the inline SVG favicon.
 * Content types are mapped from `CONTENT_TYPES` in shared.ts.
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { type ServerResponse } from "node:http";
import {
  CONTENT_TYPES,
  CONTROL_CENTER_FAVICON,
  errorMessage,
  sendJson,
  uiRoot,
} from "../shared.js";

export function serveStatic(res: ServerResponse, urlPath: string): void {
  let candidate = "";
  try {
    const normalized = urlPath.startsWith("/") ? urlPath.slice(1) : urlPath;
    let decoded: string;
    try {
      decoded = decodeURIComponent(normalized);
    } catch {
      sendJson(res, 400, { error: "Invalid path encoding" });
      return;
    }
    if (decoded.includes("\0")) {
      sendJson(res, 400, { error: "Invalid path" });
      return;
    }
    const segments = decoded.split("/").filter(Boolean);
    if (segments.some((s) => s === "..")) {
      sendJson(res, 403, { error: "Forbidden" });
      return;
    }
    candidate = resolve(uiRoot, ...segments);
    const rel = relative(uiRoot, candidate);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      sendJson(res, 403, { error: "Forbidden" });
      return;
    }
  } catch (err) {
    sendJson(res, 500, { error: errorMessage(err) });
    return;
  }
  try {
    if (!existsSync(candidate) || !statSync(candidate).isFile()) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }
    // Resolve links before reading. Lexical `..` checks alone do not stop a
    // symlink or junction inside `ui/` from pointing outside the bundle.
    const realRoot = realpathSync(uiRoot);
    const realCandidate = realpathSync(candidate);
    const realRelative = relative(realRoot, realCandidate);
    if (realRelative === "" || realRelative.startsWith("..") || isAbsolute(realRelative)) {
      sendJson(res, 403, { error: "Forbidden" });
      return;
    }
    if (!statSync(realCandidate).isFile()) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }
    const ext = extname(realCandidate).toLowerCase();
    const contentType = CONTENT_TYPES[ext] || "application/octet-stream";
    const content = readFileSync(realCandidate);
    res.writeHead(200, { "Content-Type": contentType });
    res.end(content);
  } catch (err) {
    sendJson(res, 500, { error: errorMessage(err) });
  }
}

export function serveFavicon(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "image/svg+xml; charset=utf-8",
    "Cache-Control": "public, max-age=86400",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(CONTROL_CENTER_FAVICON);
}
