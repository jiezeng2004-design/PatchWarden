import { resolve, relative, isAbsolute, sep } from "node:path";
import { existsSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { PatchWardenError } from "../errors.js";
import { isSensitivePath } from "../security/sensitiveGuard.js";
import { guardWorkspacePath } from "../security/pathGuard.js";
import { getConfig } from "../config.js";
import type { DirectSessionRecord } from "./directSessionStore.js";

// ── Session state guards ───────────────────────────────────────────

export function guardDirectSessionActive(session: DirectSessionRecord): void {
  if (new Date(session.expires_at) < new Date()) {
    throw new PatchWardenError(
      "session_expired",
      `Direct session "${session.session_id}" expired at ${session.expires_at}.`,
      "Create a new direct session with create_direct_session.",
      true,
      { session_id: session.session_id, expires_at: session.expires_at }
    );
  }

  if (session.finalized) {
    throw new PatchWardenError(
      "session_finalized",
      `Direct session "${session.session_id}" has been finalized. No further modifications are allowed.`,
      "Create a new direct session with create_direct_session to continue making changes.",
      true,
      { session_id: session.session_id, finalized_at: session.finalized_at }
    );
  }
}

export function guardDirectSessionFinalized(
  session: DirectSessionRecord
): void {
  if (!session.finalized) {
    throw new PatchWardenError(
      "session_not_finalized",
      `Direct session "${session.session_id}" has not been finalized. Call finalize_direct_session first.`,
      "Call finalize_direct_session before audit_session.",
      true,
      { session_id: session.session_id }
    );
  }
}

// ── Path guards ────────────────────────────────────────────────────

/**
 * Resolve a relative path against the session's repo_path and verify it stays
 * inside both the repo and the workspace root.
 */
export function guardDirectPath(
  filePath: string,
  resolvedRepoPath: string,
  workspaceRoot: string
): string {
  const config = getConfig();
  const resolved = resolve(resolvedRepoPath, filePath);
  const normalizedRepo = resolve(resolvedRepoPath);
  const normalizedWs = resolve(workspaceRoot);

  // Check path is inside workspace root
  const relToWs = relative(normalizedWs, resolved);
  if (isAbsolute(relToWs) || relToWs.startsWith("..")) {
    throw new PatchWardenError(
      "path_outside_repo",
      `Path "${filePath}" resolves outside the session repo.`,
      "Use a relative path inside the session's repo_path.",
      true,
      { path: filePath, operation: "direct_path_access" }
    );
  }

  // Check path is inside repo_path
  const relToRepo = relative(normalizedRepo, resolved);
  if (isAbsolute(relToRepo) || relToRepo.startsWith("..")) {
    throw new PatchWardenError(
      "path_outside_repo",
      `Path "${filePath}" is outside the session repo_path "${resolvedRepoPath}".`,
      "Use a relative path inside the session's repo_path.",
      true,
      { path: filePath, operation: "direct_path_access" }
    );
  }

  return resolved;
}

/**
 * Guard a read path: must be inside repo, not sensitive, not binary.
 */
export function guardDirectReadPath(
  filePath: string,
  resolvedRepoPath: string,
  workspaceRoot: string
): string {
  const resolved = guardDirectPath(filePath, resolvedRepoPath, workspaceRoot);
  const normalized = filePath.replace(/\\/g, "/");

  // Block internal PatchWarden paths (sessions, tasks, plans, assessments)
  if (
    normalized.startsWith(".patchwarden/") ||
    normalized.includes("/.patchwarden/")
  ) {
    throw new PatchWardenError(
      "internal_patchwarden_path_blocked",
      `Access denied: "${filePath}" is inside the internal .patchwarden directory.`,
      "Internal PatchWarden files cannot be accessed through Direct mode.",
      true,
      { path: filePath, operation: "direct_read" }
    );
  }

  if (isSensitivePath(filePath)) {
    throw new PatchWardenError(
      "sensitive_path_blocked",
      `Access denied: "${filePath}" matches a sensitive file pattern.`,
      "Read only non-sensitive files within the session repo.",
      true,
      { path: filePath, operation: "direct_read" }
    );
  }

  if (existsSync(resolved) && statSync(resolved).isFile() && isBinaryFile(resolved)) {
    throw new PatchWardenError(
      "binary_file_blocked",
      `File "${filePath}" appears to be a binary file.`,
      "Binary files cannot be read in Direct mode.",
      true,
      { path: filePath, operation: "direct_read" }
    );
  }

  return resolved;
}

/**
 * Guard a write path: must be inside repo, not sensitive, not binary,
 * not in node_modules, release, or dist directories.
 */
export function guardDirectWritePath(
  filePath: string,
  resolvedRepoPath: string,
  workspaceRoot: string
): string {
  const resolved = guardDirectPath(filePath, resolvedRepoPath, workspaceRoot);
  const normalized = filePath.replace(/\\/g, "/");

  // Block internal PatchWarden paths
  if (
    normalized.startsWith(".patchwarden/") ||
    normalized.includes("/.patchwarden/")
  ) {
    throw new PatchWardenError(
      "internal_patchwarden_path_blocked",
      `Modification denied: "${filePath}" is inside the internal .patchwarden directory.`,
      "Internal PatchWarden files cannot be modified through Direct mode.",
      true,
      { path: filePath, operation: "direct_write" }
    );
  }

  if (isSensitivePath(normalized)) {
    throw new PatchWardenError(
      "sensitive_path_blocked",
      `Modification denied: "${filePath}" matches a sensitive file pattern.`,
      "Do not modify .env, credentials, keys, or other sensitive files.",
      true,
      { path: filePath, operation: "direct_write" }
    );
  }

  // Block node_modules
  if (normalized.startsWith("node_modules/") || normalized.includes("/node_modules/")) {
    throw new PatchWardenError(
      "blocked_artifact_path",
      `Modification denied: "${filePath}" is inside node_modules.`,
      "Do not modify dependencies directly. Use package management tools instead.",
      true,
      { path: filePath, operation: "direct_write" }
    );
  }

  // Block release/
  if (normalized.startsWith("release/") || normalized.includes("/release/")) {
    throw new PatchWardenError(
      "blocked_artifact_path",
      `Modification denied: "${filePath}" is inside the release directory.`,
      "Do not manually modify release artifacts.",
      true,
      { path: filePath, operation: "direct_write" }
    );
  }

  // Block dist/
  if (normalized.startsWith("dist/") || normalized.includes("/dist/")) {
    throw new PatchWardenError(
      "blocked_artifact_path",
      `Modification denied: "${filePath}" is inside the dist directory.`,
      "Do not manually modify build output. Modify source files instead.",
      true,
      { path: filePath, operation: "direct_write" }
    );
  }

  if (existsSync(resolved) && statSync(resolved).isFile() && isBinaryFile(resolved)) {
    throw new PatchWardenError(
      "binary_file_blocked",
      `Modification denied: "${filePath}" appears to be a binary file.`,
      "Binary files cannot be modified in Direct mode.",
      true,
      { path: filePath, operation: "direct_write" }
    );
  }

  return resolved;
}

// ── Size guards ────────────────────────────────────────────────────

export function guardDirectPatchSize(patchBytes: number): void {
  const config = getConfig();
  if (patchBytes > config.directMaxPatchBytes) {
    throw new PatchWardenError(
      "patch_too_large",
      `Patch size ${patchBytes} bytes exceeds maximum ${config.directMaxPatchBytes} bytes.`,
      "Split the patch into smaller operations or reduce the patch size.",
      true,
      { patch_bytes: patchBytes, max_bytes: config.directMaxPatchBytes }
    );
  }
}

export function guardDirectFileSize(fileBytes: number): void {
  const config = getConfig();
  if (fileBytes > config.directMaxFileBytes) {
    throw new PatchWardenError(
      "file_too_large",
      `File size ${fileBytes} bytes exceeds maximum ${config.directMaxFileBytes} bytes.`,
      "Use search_workspace to find specific content, or split the read into smaller portions.",
      true,
      { file_bytes: fileBytes, max_bytes: config.directMaxFileBytes }
    );
  }
}

// ── Binary detection ───────────────────────────────────────────────

const BINARY_EXTENSIONS = new Set([
  ".exe", ".dll", ".so", ".dylib", ".a", ".lib", ".o", ".obj",
  ".zip", ".gz", ".tar", ".tgz", ".bz2", ".7z", ".rar",
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".tiff",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".mp3", ".mp4", ".avi", ".mov", ".wav", ".flv",
  ".bin", ".dat", ".pak", ".pfx", ".p12", ".class", ".jar", ".war",
  ".wasm", ".node",
]);

/**
 * Maximum bytes to scan for null-byte detection when the extension is not
 * a known binary type. 1 MB catches binary content embedded deep in files
 * (e.g., null bytes at offset 8200) without reading excessively large files.
 */
const BINARY_SCAN_LIMIT = 1_048_576; // 1 MB
const BINARY_SCAN_CHUNK = 65536; // 64 KB per read

export function isBinaryFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  for (const ext of BINARY_EXTENSIONS) {
    if (normalized.endsWith(ext)) return true;
  }

  // Scan file content for null bytes in chunks up to BINARY_SCAN_LIMIT.
  // Previously only the first 8 KB were checked, allowing null bytes at
  // offset 8193+ to bypass detection.
  try {
    const stat = statSync(filePath);
    const scanSize = Math.min(stat.size, BINARY_SCAN_LIMIT);
    const fd = openSync(filePath, "r");
    try {
      const chunk = Buffer.alloc(BINARY_SCAN_CHUNK);
      let scanned = 0;
      while (scanned < scanSize) {
        const toRead = Math.min(BINARY_SCAN_CHUNK, scanSize - scanned);
        const bytesRead = readSync(fd, chunk, 0, toRead, scanned);
        if (bytesRead === 0) break;
        for (let i = 0; i < bytesRead; i++) {
          if (chunk[i] === 0) return true;
        }
        scanned += bytesRead;
      }
      return false;
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}
