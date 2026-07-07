import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { relative, join, extname } from "node:path";
import { getConfig } from "../config.js";
import { PatchWardenError } from "../errors.js";
import { isSensitivePath } from "../security/sensitiveGuard.js";
import {
  readDirectSession,
  validateDirectSessionFreshness,
} from "../direct/directSessionStore.js";
import { guardDirectSessionActive } from "../direct/directGuards.js";

// ── Types ──────────────────────────────────────────────────────────

export interface SearchWorkspaceInput {
  session_id: string;
  query: string;
  max_results?: number;
  case_sensitive?: boolean;
  max_preview_chars?: number;
  include_globs?: string[];
}

export interface SearchMatch {
  path: string;
  line: number;
  preview: string;
}

export interface SearchWorkspaceOutput {
  results: SearchMatch[];
  total_matches: number;
  truncated: boolean;
}

// ── Constants ──────────────────────────────────────────────────────

const SKIP_DIRECTORIES = new Set([
  ".git",
  ".patchwarden",
  "node_modules",
  "dist",
  "release",
  "coverage",
  ".next",
  ".turbo",
]);

const BINARY_EXTENSIONS = new Set([
  ".exe",
  ".dll",
  ".so",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".ico",
  ".webp",
  ".pdf",
  ".mp3",
  ".mp4",
  ".zip",
  ".gz",
  ".tar",
  ".bin",
  ".dat",
  ".class",
  ".jar",
  ".wasm",
  ".node",
]);

// Safety valve: stop scanning after this many total matches to prevent
// runaway searches in large repositories with very common terms.
const MAX_TOTAL_MATCHES = 10_000;

// ── Tool implementation ────────────────────────────────────────────

export function searchWorkspace(
  input: SearchWorkspaceInput
): SearchWorkspaceOutput {
  const config = getConfig();

  // ── Validate session freshness ───────────────────────────────────

  const validation = validateDirectSessionFreshness(input.session_id);
  if (!validation.valid || !validation.session) {
    throw new PatchWardenError(
      validation.failure_reason || "session_invalid",
      `Direct session "${input.session_id}" is not valid: ${validation.failure_reason}.`,
      "Create a new direct session with create_direct_session.",
      true,
      {
        session_id: input.session_id,
        failure_reason: validation.failure_reason,
        operation: "search_workspace",
      }
    );
  }

  const session = validation.session;
  guardDirectSessionActive(session);

  // ── Validate query ───────────────────────────────────────────────

  if (!input.query || input.query.trim() === "") {
    throw new PatchWardenError(
      "invalid_input",
      "query is required and must be a non-empty string.",
      "Provide a search query to look for in file contents.",
      true,
      { operation: "search_workspace", session_id: input.session_id }
    );
  }

  // ── Resolve parameters ───────────────────────────────────────────

  const maxResults = input.max_results ?? 20;
  const caseSensitive = input.case_sensitive ?? false;
  const maxPreviewChars = input.max_preview_chars ?? 200;
  const includeGlobs = input.include_globs;
  const query = caseSensitive ? input.query : input.query.toLowerCase();

  const repoPath = session.resolved_repo_path;

  if (!existsSync(repoPath)) {
    throw new PatchWardenError(
      "repo_not_found",
      `Session repo path "${repoPath}" no longer exists.`,
      "Create a new direct session with create_direct_session.",
      true,
      {
        session_id: input.session_id,
        resolved_repo_path: repoPath,
        operation: "search_workspace",
      }
    );
  }

  // ── Recursive search ─────────────────────────────────────────────

  const results: SearchMatch[] = [];
  let totalMatches = 0;
  let truncated = false;

  const visit = (directory: string): void => {
    if (truncated && totalMatches >= MAX_TOTAL_MATCHES) return;

    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (totalMatches >= MAX_TOTAL_MATCHES) {
        truncated = true;
        return;
      }

      // Skip blacklisted directories
      if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) {
        continue;
      }

      const fullPath = join(directory, entry.name);
      const relPath = relative(repoPath, fullPath).replace(/\\/g, "/");

      if (entry.isDirectory()) {
        visit(fullPath);
        continue;
      }

      if (!entry.isFile()) continue;

      // Skip sensitive files
      if (isSensitivePath(relPath)) continue;

      // Skip binary files by extension
      const ext = extname(entry.name).toLowerCase();
      if (BINARY_EXTENSIONS.has(ext)) continue;

      // Apply include_globs filter
      if (includeGlobs && includeGlobs.length > 0) {
        if (!matchesAnyGlob(relPath, includeGlobs)) continue;
      }

      // Read file content and search line by line
      let content: string;
      try {
        const fileStat = statSync(fullPath);
        if (fileStat.size > config.directMaxFileBytes) continue;
        content = readFileSync(fullPath, "utf-8");
      } catch {
        continue;
      }

      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (totalMatches >= MAX_TOTAL_MATCHES) {
          truncated = true;
          break;
        }

        const line = lines[i];
        const haystack = caseSensitive ? line : line.toLowerCase();
        if (haystack.includes(query)) {
          totalMatches++;
          if (results.length < maxResults) {
            const preview =
              line.length > maxPreviewChars
                ? line.slice(0, maxPreviewChars)
                : line;
            results.push({
              path: relPath,
              line: i + 1,
              preview,
            });
          } else {
            truncated = true;
          }
        }
      }
    }
  };

  visit(repoPath);

  return {
    results,
    total_matches: totalMatches,
    truncated,
  };
}

// ── Glob matching ──────────────────────────────────────────────────

function matchesAnyGlob(filePath: string, globs: string[]): boolean {
  for (const pattern of globs) {
    if (matchGlob(filePath, pattern)) return true;
  }
  return false;
}

/**
 * Simple glob matching: "*" matches any sequence of characters (including
 * path separators), "?" matches a single character.
 *
 * Examples:
 *   "*.ts"       matches "foo.ts", "src/bar.ts"
 *   "src/*.ts"   matches "src/foo.ts", "src/sub/bar.ts"
 *   "*.test.ts"  matches "foo.test.ts", "src/bar.test.ts"
 */
function matchGlob(filePath: string, pattern: string): boolean {
  const normalizedPattern = pattern.replace(/\\/g, "/");
  const regex = globToRegex(normalizedPattern);
  return regex.test(filePath);
}

function globToRegex(pattern: string): RegExp {
  let regexStr = "";
  for (const char of pattern) {
    if (char === "*") {
      regexStr += ".*";
    } else if (char === "?") {
      regexStr += ".";
    } else if (/[.+^${}()|[\]\\]/.test(char)) {
      regexStr += "\\" + char;
    } else {
      regexStr += char;
    }
  }
  return new RegExp("^" + regexStr + "$");
}
