import { readFileSync, statSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, relative, isAbsolute } from "node:path";
import { getConfig } from "../../config.js";
import { guardReadPath } from "../../security/pathGuard.js";
import { guardSensitivePath } from "../../security/sensitiveGuard.js";
import { redactSensitiveContent } from "../../security/contentRedaction.js";
import { PatchWardenError } from "../../errors.js";
import { readDirectSession } from "../../direct/directSessionStore.js";
import { guardDirectSessionActive, guardDirectReadPath, isBinaryFile, guardDirectFileSize } from "../../direct/directGuards.js";
import { resolveToolProfile } from "../catalog/toolCatalog.js";

export interface ReadWorkspaceFileOutput {
  path: string;
  content: string;
  size: number;
  redacted?: boolean;
  redaction_categories?: string[];
  // Direct mode extensions
  relative_path?: string;
  sha256?: string;
}

export interface ReadWorkspaceFileInput {
  path: string;
  session_id?: string;
}

export function readWorkspaceFile(input: string | ReadWorkspaceFileInput): ReadWorkspaceFileOutput {
  const config = getConfig();

  // Support both old string API and new object API
  const relativePath = typeof input === "string" ? input : input.path;
  const sessionId = typeof input === "string" ? undefined : input.session_id;

  // Direct mode: session_id provided
  if (sessionId) {
    return readWorkspaceFileDirect(relativePath, sessionId);
  }

  // In chatgpt_direct profile, session_id is required
  const profile = resolveToolProfile(config.toolProfile);
  if (profile === "chatgpt_direct") {
    throw new PatchWardenError(
      "session_id_required",
      "session_id is required when using the chatgpt_direct profile.",
      "Provide a session_id from create_direct_session.",
      true,
      { operation: "read_workspace_file" }
    );
  }

  // Compatibility mode: no session_id, original behavior
  const safePath = guardReadPath(relativePath, config.workspaceRoot);
  guardSensitivePath(safePath);

  const stat = statSync(safePath);
  if (stat.size > config.maxReadFileBytes) {
    throw new Error(
      `File is ${stat.size} bytes, exceeds max of ${config.maxReadFileBytes} bytes.`
    );
  }

  // Only allow text-like files
  if (stat.size > 5_000_000) {
    throw new Error("File exceeds 5 MB size limit.");
  }

  const redaction = redactSensitiveContent(readFileSync(safePath, "utf-8"));
  return {
    path: safePath,
    content: redaction.content,
    size: stat.size,
    redacted: redaction.redacted,
    redaction_categories: redaction.redaction_categories,
  };
}

function readWorkspaceFileDirect(relativePath: string, sessionId: string): ReadWorkspaceFileOutput {
  const config = getConfig();
  const session = readDirectSession(sessionId);
  guardDirectSessionActive(session);

  // Resolve path within session's repo
  const safePath = guardDirectReadPath(relativePath, session.resolved_repo_path, config.workspaceRoot);

  if (!existsSync(safePath)) {
    throw new PatchWardenError(
      "file_not_found",
      `File "${relativePath}" not found in session repo.`,
      "Use search_workspace to find available files.",
      true,
      { path: relativePath, session_id: sessionId }
    );
  }

  const stat = statSync(safePath);
  guardDirectFileSize(stat.size);

  // Block binary files
  if (isBinaryFile(safePath)) {
    throw new PatchWardenError(
      "binary_file_blocked",
      `File "${relativePath}" appears to be a binary file.`,
      "Binary files cannot be read in Direct mode.",
      true,
      { path: relativePath }
    );
  }

  const content = readFileSync(safePath, "utf-8");
  const redaction = redactSensitiveContent(content);
  const sha256 = createHash("sha256").update(content, "utf-8").digest("hex");

  return {
    path: safePath,
    relative_path: relativePath,
    content: redaction.content,
    size: stat.size,
    sha256,
    redacted: redaction.redacted,
    redaction_categories: redaction.redaction_categories,
  };
}
