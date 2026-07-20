import { readFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { PatchWardenError } from "../../errors.js";
import { getConfig, type PatchWardenConfig } from "../../config.js";
import {
  guardDirectReadPath,
  guardDirectFileSize,
  guardDirectSessionActive,
  guardDirectWritePath,
} from "../../direct/directGuards.js";
import {
  appendDirectSessionOperation,
  readDirectSession,
  withDirectSessionMutationLock,
} from "../../direct/directSessionStore.js";
import { computeFileSha256 } from "../../direct/directPatch.js";
import { atomicWriteFileSync } from "../../utils/atomicFile.js";
import { redactSensitiveContent } from "../../security/contentRedaction.js";

export interface SyncFileResult {
  source_path: string;
  target_path: string;
  before_target_sha256: string | null;
  after_target_sha256: string;
  source_sha256: string;
  copied_bytes: number;
  changed: boolean;
}

/**
 * Copy a file from source to target within the same session repo.
 * Both source and target must be inside the session's repo_path.
 */
export function syncFile(
  sessionId: string,
  sourcePath: string,
  targetPath: string,
  options?: {
    expected_source_sha256?: string;
    expected_target_sha256?: string;
  },
  config?: PatchWardenConfig
): SyncFileResult {
  const cfg = config || getConfig();
  return withDirectSessionMutationLock(sessionId, () => {
  const session = readDirectSession(sessionId, cfg);
  guardDirectSessionActive(session);
  const repoPath = session.resolved_repo_path;
  const workspaceRoot = cfg.workspaceRoot;

  // Guard source path — must be inside repo and not internal/sensitive/binary.
  const resolvedSource = guardDirectReadPath(sourcePath, repoPath, workspaceRoot);

  if (!existsSync(resolvedSource)) {
    throw new PatchWardenError(
      "source_file_not_found",
      `Source file does not exist: "${sourcePath}".`,
      "Ensure the source path is correct.",
      true,
      { source_path: sourcePath }
    );
  }

  // Guard target path — must be inside repo, not in blocked dirs
  const resolvedTarget = guardDirectWritePath(targetPath, repoPath, workspaceRoot);

  const sourceMetadata = statSync(resolvedSource);
  if (!sourceMetadata.isFile()) {
    throw new PatchWardenError(
      "direct_source_not_file",
      `Source path is not a regular file: "${sourcePath}".`,
      "Choose an existing text file inside the Direct session repository.",
      true,
      { source_path: sourcePath },
    );
  }
  guardDirectFileSize(sourceMetadata.size, cfg);

  // Read once, then hash the exact bytes that will be copied.
  const sourceContent = readFileSync(resolvedSource);
  guardDirectFileSize(sourceContent.length, cfg);
  const sourceText = sourceContent.toString("utf-8");
  if (!Buffer.from(sourceText, "utf-8").equals(sourceContent)) {
    throw new PatchWardenError(
      "unsupported_text_encoding",
      `Source file "${sourcePath}" is not valid UTF-8 text.`,
      "Use a normal task or convert the file to UTF-8 before Direct sync.",
      true,
      { source_path: sourcePath },
    );
  }
  const sensitive = redactSensitiveContent(sourceText);
  if (sensitive.redacted) {
    throw new PatchWardenError(
      "sensitive_content_blocked",
      `Source file contains credential-like content (${sensitive.redaction_categories.join(", ")}).`,
      "Remove the sensitive value and retry with placeholders or environment-variable references.",
      true,
      { source_path: sourcePath, redaction_categories: sensitive.redaction_categories },
    );
  }
  const sourceSha256 = createHash("sha256").update(sourceContent).digest("hex");
  if (options?.expected_source_sha256 && options.expected_source_sha256 !== sourceSha256) {
    throw new PatchWardenError(
      "source_hash_mismatch",
      `Source file hash mismatch. Expected "${options.expected_source_sha256}" but got "${sourceSha256}".`,
      "Re-read the source file to get the current sha256.",
      true,
      { expected_sha256: options.expected_source_sha256, actual_sha256: sourceSha256 }
    );
  }

  // Get target sha256 before copy
  let beforeTargetSha256: string | null = null;
  if (existsSync(resolvedTarget)) {
    const targetMetadata = statSync(resolvedTarget);
    if (!targetMetadata.isFile()) {
      throw new PatchWardenError(
        "direct_target_not_file",
        `Target path is not a regular file: "${targetPath}".`,
        "Choose a text-file target inside the Direct session repository.",
        true,
        { target_path: targetPath },
      );
    }
    guardDirectFileSize(targetMetadata.size, cfg);
    beforeTargetSha256 = computeFileSha256(resolvedTarget);
    // Verify target sha256 if provided
    if (options?.expected_target_sha256 && options.expected_target_sha256 !== beforeTargetSha256) {
      throw new PatchWardenError(
        "target_hash_mismatch",
        `Target file hash mismatch. Expected "${options.expected_target_sha256}" but got "${beforeTargetSha256}".`,
        "Re-read the target file to get the current sha256.",
        true,
        { expected_sha256: options.expected_target_sha256, actual_sha256: beforeTargetSha256 }
      );
    }
  }

  const copiedBytes = sourceContent.length;

  if (beforeTargetSha256 === sourceSha256) {
    assertSourceUnchanged(sourcePath, resolvedSource, sourceSha256, repoPath, workspaceRoot);
    appendSyncOperation(
      sessionId,
      sourcePath,
      targetPath,
      beforeTargetSha256,
      sourceSha256,
      0,
      0,
      cfg,
    );
    return buildSyncResult(
      sourcePath,
      targetPath,
      beforeTargetSha256,
      sourceSha256,
      copiedBytes,
      false,
    );
  }

  // Create target directory if needed
  mkdirSync(dirname(resolvedTarget), { recursive: true });

  // Re-resolve after directory creation so a newly exposed link/reparse point
  // cannot reuse the earlier lexical decision. Replace atomically in the
  // validated target directory and preserve an existing file's permissions.
  const revalidatedTarget = guardDirectWritePath(resolvedTarget, repoPath, workspaceRoot);
  const currentTargetSha256 = existsSync(revalidatedTarget)
    ? computeFileSha256(revalidatedTarget)
    : null;
  if (currentTargetSha256 !== beforeTargetSha256) {
    throw new PatchWardenError(
      "direct_target_changed_during_sync",
      `Target file "${targetPath}" changed while sync_file was preparing the copy.`,
      "Re-read the target file and retry after concurrent filesystem changes stop.",
      true,
      {
        path: targetPath,
        before_sha256: beforeTargetSha256,
        current_sha256: currentTargetSha256,
      },
    );
  }
  assertSourceUnchanged(sourcePath, resolvedSource, sourceSha256, repoPath, workspaceRoot);
  const existingMode = existsSync(revalidatedTarget) ? statSync(revalidatedTarget).mode : undefined;
  atomicWriteFileSync(revalidatedTarget, sourceContent, { mode: existingMode });
  const finalTarget = guardDirectWritePath(revalidatedTarget, repoPath, workspaceRoot);
  if (finalTarget !== revalidatedTarget) {
    throw new PatchWardenError(
      "direct_path_changed_during_write",
      `Target path "${targetPath}" changed while sync_file was writing it.`,
      "Inspect the repository path and retry only after concurrent filesystem changes stop.",
      true,
      { path: targetPath, operation: "sync_file" }
    );
  }

  // Compute after hash
  const afterTargetSha256 = computeFileSha256(finalTarget);
  const changed = beforeTargetSha256 !== afterTargetSha256;

  appendSyncOperation(
    sessionId,
    sourcePath,
    targetPath,
    beforeTargetSha256,
    afterTargetSha256,
    1,
    copiedBytes,
    cfg,
  );
  return buildSyncResult(
    sourcePath,
    targetPath,
    beforeTargetSha256,
    afterTargetSha256,
    copiedBytes,
    changed,
  );
  }, cfg);
}

function assertSourceUnchanged(
  sourcePath: string,
  resolvedSource: string,
  expectedSha256: string,
  repoPath: string,
  workspaceRoot: string,
): void {
  const currentPath = guardDirectReadPath(sourcePath, repoPath, workspaceRoot);
  const samePath = process.platform === "win32"
    ? currentPath.toLowerCase() === resolvedSource.toLowerCase()
    : currentPath === resolvedSource;
  const currentSha256 = samePath && existsSync(currentPath)
    ? computeFileSha256(currentPath)
    : null;
  if (!samePath || currentSha256 !== expectedSha256) {
    throw new PatchWardenError(
      "direct_source_changed_during_sync",
      `Source file "${sourcePath}" changed while sync_file was preparing the copy.`,
      "Re-read the source file and retry after concurrent filesystem changes stop.",
      true,
      { source_path: sourcePath, expected_sha256: expectedSha256, actual_sha256: currentSha256 },
    );
  }
}

function appendSyncOperation(
  sessionId: string,
  sourcePath: string,
  targetPath: string,
  beforeSha256: string | null,
  afterSha256: string,
  operationsApplied: number,
  bytesChanged: number,
  config: PatchWardenConfig,
): void {
  appendDirectSessionOperation(sessionId, {
    index: 0,
    timestamp: new Date().toISOString(),
    path: targetPath,
    source_path: sourcePath,
    operation_type: "sync",
    before_sha256: beforeSha256,
    after_sha256: afterSha256,
    operations_applied: operationsApplied,
    bytes_changed: bytesChanged,
  }, config);
}

function buildSyncResult(
  sourcePath: string,
  targetPath: string,
  beforeSha256: string | null,
  afterSha256: string,
  copiedBytes: number,
  changed: boolean,
): SyncFileResult {
  return {
    source_path: sourcePath,
    target_path: targetPath,
    before_target_sha256: beforeSha256,
    after_target_sha256: afterSha256,
    source_sha256: afterSha256,
    copied_bytes: copiedBytes,
    changed,
  };
}
