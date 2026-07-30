import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { getConfig } from "../../config.js";
import { PatchWardenError } from "../../errors.js";
import {
  guardDirectFileSize,
  guardDirectReadPath,
  guardDirectSessionActive,
  guardDirectWritePath,
} from "../../direct/directGuards.js";
import { computeContentSha256, computeFileSha256 } from "../../direct/directPatch.js";
import {
  appendDirectSessionOperation,
  readDirectSession,
  withDirectSessionMutationLock,
} from "../../direct/directSessionStore.js";
import { redactSensitiveContent } from "../../security/contentRedaction.js";

export function createDirectFile(input: { session_id: string; path: string; content: string }) {
  const config = getConfig();
  return withDirectSessionMutationLock(input.session_id, () => {
    const session = readDirectSession(input.session_id, config);
    guardDirectSessionActive(session);
    const target = guardDirectWritePath(input.path, session.resolved_repo_path, config.workspaceRoot);
    if (existsSync(target)) throw directConflict("direct_target_exists", input.path, "Choose a new path or use apply_patch with the current file hash.");
    const parent = dirname(target);
    if (!existsSync(parent) || !lstatSync(parent).isDirectory()) throw directConflict("direct_parent_missing", input.path, "Create the parent directory with mkdir first.");
    const content = String(input.content);
    guardDirectFileSize(Buffer.byteLength(content, "utf-8"), config);
    guardSensitiveContent(content, input.path);
    const revalidated = guardDirectWritePath(input.path, session.resolved_repo_path, config.workspaceRoot);
    if (existsSync(revalidated)) throw directConflict("direct_target_exists", input.path, "Re-read the repository and choose a new path.");
    let descriptor: number | null = null;
    try {
      descriptor = openSync(revalidated, "wx", 0o600);
      writeFileSync(descriptor, content, "utf-8");
    } finally {
      if (descriptor !== null) closeSync(descriptor);
    }
    const after = computeFileSha256(revalidated);
    appendOperation(input.session_id, input.path, "create", null, after, 1, Buffer.byteLength(content, "utf-8"));
    return { path: input.path, before_sha256: null, after_sha256: after, created: true, next_action: "Run verification or continue with another Direct edit." };
  }, config);
}

export function mkdirDirect(input: { session_id: string; path: string }) {
  const config = getConfig();
  return withDirectSessionMutationLock(input.session_id, () => {
    const session = readDirectSession(input.session_id, config);
    guardDirectSessionActive(session);
    const target = guardDirectWritePath(input.path, session.resolved_repo_path, config.workspaceRoot);
    if (existsSync(target)) throw directConflict("direct_target_exists", input.path, "Choose a directory path that does not already exist.");
    const parent = dirname(target);
    if (!existsSync(parent) || !lstatSync(parent).isDirectory()) throw directConflict("direct_parent_missing", input.path, "Create one directory level at a time.");
    const revalidated = guardDirectWritePath(input.path, session.resolved_repo_path, config.workspaceRoot);
    mkdirSync(revalidated);
    appendOperation(input.session_id, input.path, "mkdir", null, null, 1, 0);
    return { path: input.path, created: true, next_action: "Create files inside the new directory, then run verification." };
  }, config);
}

export function moveDirectFile(input: { session_id: string; source_path: string; target_path: string; expected_source_sha256: string }) {
  const config = getConfig();
  return withDirectSessionMutationLock(input.session_id, () => {
    const session = readDirectSession(input.session_id, config);
    guardDirectSessionActive(session);
    const source = guardDirectReadPath(input.source_path, session.resolved_repo_path, config.workspaceRoot);
    guardDirectWritePath(input.source_path, session.resolved_repo_path, config.workspaceRoot);
    const target = guardDirectWritePath(input.target_path, session.resolved_repo_path, config.workspaceRoot);
    if (!existsSync(source) || !lstatSync(source).isFile()) throw directConflict("source_file_not_found", input.source_path, "Choose an existing regular text file.");
    if (existsSync(target)) throw directConflict("direct_target_exists", input.target_path, "Move to a path that does not already exist.");
    if (!existsSync(dirname(target)) || !lstatSync(dirname(target)).isDirectory()) throw directConflict("direct_parent_missing", input.target_path, "Create the target parent directory first.");
    const sourceHash = computeFileSha256(source);
    if (!/^[a-f0-9]{64}$/i.test(input.expected_source_sha256) || sourceHash !== input.expected_source_sha256) throw hashMismatch(input.expected_source_sha256, sourceHash);
    guardSensitiveContent(readUtf8(source, config.directMaxFileBytes), input.source_path);
    const currentSource = guardDirectReadPath(input.source_path, session.resolved_repo_path, config.workspaceRoot);
    const currentTarget = guardDirectWritePath(input.target_path, session.resolved_repo_path, config.workspaceRoot);
    if (computeFileSha256(currentSource) !== sourceHash || existsSync(currentTarget)) throw directConflict("direct_path_changed_during_write", input.target_path, "Retry after concurrent filesystem changes stop.");
    renameSync(currentSource, currentTarget);
    const after = computeFileSha256(currentTarget);
    appendOperation(input.session_id, input.target_path, "move", sourceHash, after, 1, 0, input.source_path);
    return { source_path: input.source_path, target_path: input.target_path, before_sha256: sourceHash, after_sha256: after, moved: true, next_action: "Run verification and finalize the Direct session." };
  }, config);
}

export function deleteDirectFile(input: { session_id: string; path: string; expected_sha256: string; confirm_delete: boolean }) {
  const config = getConfig();
  return withDirectSessionMutationLock(input.session_id, () => {
    if (input.confirm_delete !== true) throw new PatchWardenError(
      "direct_delete_confirmation_required",
      "Direct file deletion requires confirm_delete=true.",
      "Re-read the file, review its hash, and retry with explicit confirmation.",
      true,
      { path: input.path, confirmation_supported: true },
    );
    const session = readDirectSession(input.session_id, config);
    guardDirectSessionActive(session);
    const target = guardDirectReadPath(input.path, session.resolved_repo_path, config.workspaceRoot);
    guardDirectWritePath(input.path, session.resolved_repo_path, config.workspaceRoot);
    if (!existsSync(target) || !lstatSync(target).isFile()) throw directConflict("file_not_found", input.path, "Choose an existing regular text file.");
    const before = computeFileSha256(target);
    if (!/^[a-f0-9]{64}$/i.test(input.expected_sha256) || before !== input.expected_sha256) throw hashMismatch(input.expected_sha256, before);
    guardSensitiveContent(readUtf8(target, config.directMaxFileBytes), input.path);
    const revalidated = guardDirectWritePath(input.path, session.resolved_repo_path, config.workspaceRoot);
    if (computeFileSha256(revalidated) !== before) throw hashMismatch(before, computeFileSha256(revalidated));
    unlinkSync(revalidated);
    appendOperation(input.session_id, input.path, "delete", before, null, 1, 0);
    return { path: input.path, before_sha256: before, after_sha256: null, deleted: true, next_action: "Run verification and review the deletion in the final diff." };
  }, config);
}

function readUtf8(path: string, maxBytes: number): string {
  const bytes = readFileSync(path);
  guardDirectFileSize(bytes.length);
  const text = bytes.toString("utf-8");
  if (!Buffer.from(text, "utf-8").equals(bytes) || bytes.length > maxBytes) throw directConflict("unsupported_text_encoding", path, "Use Direct operations only for bounded UTF-8 text files.");
  return text;
}

function guardSensitiveContent(content: string, path: string): void {
  const result = redactSensitiveContent(content);
  if (result.redacted) throw new PatchWardenError(
    "sensitive_content_blocked",
    `Direct file content contains credential-like material (${result.redaction_categories.join(", ")}).`,
    "Remove sensitive values and use placeholders or environment-variable references.",
    true,
    { path, redaction_categories: result.redaction_categories },
  );
}

function appendOperation(sessionId: string, path: string, operationType: "create" | "delete" | "move" | "mkdir", before: string | null, after: string | null, applied: number, bytes: number, sourcePath?: string): void {
  appendDirectSessionOperation(sessionId, {
    index: 0,
    timestamp: new Date().toISOString(),
    path,
    operation_type: operationType,
    ...(sourcePath ? { source_path: sourcePath } : {}),
    before_sha256: before,
    after_sha256: after,
    operations_applied: applied,
    bytes_changed: bytes,
  });
}

function directConflict(reason: string, path: string, suggestion: string): PatchWardenError {
  return new PatchWardenError(reason, `Direct file operation rejected for "${path}".`, suggestion, true, { path });
}

function hashMismatch(expected: string, actual: string): PatchWardenError {
  return new PatchWardenError("file_hash_mismatch", `File hash mismatch. Expected "${expected}" but got "${actual}".`, "Re-read the file and retry with its current sha256.", true, { expected_sha256: expected, actual_sha256: actual });
}
