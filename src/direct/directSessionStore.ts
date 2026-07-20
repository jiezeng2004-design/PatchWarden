import {
  mkdirSync,
  existsSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { resolve, join } from "node:path";
import {
  getDirectSessionsDir,
  getConfig,
  getRepoDirectAllowedCommands,
  PatchWardenConfig,
} from "../config.js";
import { guardPath } from "../security/pathGuard.js";
import { PatchWardenError } from "../errors.js";
import { PATCHWARDEN_VERSION, TOOL_SCHEMA_EPOCH } from "../version.js";
import { atomicWriteFileSync, atomicWriteJsonFileSync } from "../utils/atomicFile.js";
import { redactSensitiveContent } from "../security/contentRedaction.js";
import {
  mutateLockedJsonFileSync,
  readJsonObjectFileSync,
  withFileLock,
  withFileLockSync,
} from "../utils/lockedJsonFile.js";
import { getLastToolCatalogSnapshot } from "../tools/catalog/toolCatalog.js";
import {
  type RepoSnapshot,
  type ChangeArtifacts,
} from "../runner/changeCapture.js";

// ── Types ──────────────────────────────────────────────────────────

export interface DirectSessionOperation {
  index: number;
  timestamp: string;
  path: string;
  operation_type?: "patch" | "sync";
  source_path?: string;
  before_sha256: string | null;
  after_sha256: string;
  operations_applied: number;
  bytes_changed: number;
}

export interface DirectSessionVerificationRun {
  command: string;
  exit_code: number | null;
  passed: boolean;
  timed_out: boolean;
  redacted?: boolean;
  redaction_categories?: string[];
  stdout_tail: string;
  stderr_tail: string;
  started_at: string;
  finished_at: string;
  log_path: string;
}

export interface DirectSessionRecord {
  session_id: string;
  title: string;
  repo_path: string;
  resolved_repo_path: string;
  created_at: string;
  expires_at: string;
  server_version: string;
  schema_epoch: string;
  tool_manifest_sha256: string;
  workspace_snapshot_before: RepoSnapshot;
  workspace_fingerprint_before: string;
  allowed_commands: string[];
  operations: DirectSessionOperation[];
  verification_runs: DirectSessionVerificationRun[];
  finalized: boolean;
  finalized_at: string | null;
  audited: boolean;
  change_artifacts: ChangeArtifacts | null;
}

export interface DirectSessionCreateInput {
  repo_path: string;
  resolved_repo_path: string;
  title?: string;
  snapshot: RepoSnapshot;
}

// ── ID generation ──────────────────────────────────────────────────

export function generateDirectSessionId(): string {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace("T", "_")
    .slice(0, 15);
  const randomHex = randomBytes(16).toString("hex");
  return `direct_${timestamp}_${randomHex}`;
}

/**
 * Direct session IDs are directory names. Keep one shared, bounded grammar so
 * MCP tools and Control Center routes cannot disagree about traversal input.
 */
export function isValidDirectSessionId(sessionId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(sessionId);
}

function guardDirectSessionId(sessionId: string): void {
  if (!isValidDirectSessionId(sessionId)) {
    throw new PatchWardenError(
      "invalid_session_id",
      `Direct session ID "${sessionId}" is invalid.`,
      "Use the session_id returned by create_direct_session.",
      true,
      { session_id: sessionId }
    );
  }
}

// ── Directory management ───────────────────────────────────────────

export function createDirectSessionDir(
  sessionId: string,
  config: PatchWardenConfig = getConfig()
): string {
  guardDirectSessionId(sessionId);
  const sessionsDir = getDirectSessionsDir(config);
  guardPath(sessionsDir, config.workspaceRoot, config.directSessionsDir);
  mkdirSync(sessionsDir, { recursive: true });
  const dir = getDirectSessionDir(sessionId, config);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function getDirectSessionDir(
  sessionId: string,
  config: PatchWardenConfig = getConfig()
): string {
  guardDirectSessionId(sessionId);
  const sessionsDir = getDirectSessionsDir(config);
  return guardPath(
    resolve(sessionsDir, sessionId),
    config.workspaceRoot,
    config.directSessionsDir
  );
}

// ── CRUD ───────────────────────────────────────────────────────────

export function createDirectSession(
  input: DirectSessionCreateInput
): DirectSessionRecord {
  const config = getConfig();

  const sessionId = generateDirectSessionId();
  const dir = createDirectSessionDir(sessionId);

  const toolManifest =
    getLastToolCatalogSnapshot()?.tool_manifest_sha256 ||
    computeFallbackManifestHash(config);

  const workspaceFingerprint = computeWorkspaceFingerprint(input.snapshot);

  const allowedCommands = [
    ...(config.directAllowedCommands || []),
    ...getRepoDirectAllowedCommands(config, input.resolved_repo_path),
  ];

  const now = new Date();
  const expiresAt = new Date(
    now.getTime() + config.directSessionTtlSeconds * 1000
  ).toISOString();

  const record: DirectSessionRecord = {
    session_id: sessionId,
    title: redactSensitiveContent(input.title || "")
      .content
      .replace(/[\r\n\t]+/g, " ")
      .trim()
      .slice(0, 500),
    repo_path: input.repo_path,
    resolved_repo_path: input.resolved_repo_path,
    created_at: now.toISOString(),
    expires_at: expiresAt,
    server_version: PATCHWARDEN_VERSION,
    schema_epoch: TOOL_SCHEMA_EPOCH,
    tool_manifest_sha256: toolManifest,
    workspace_snapshot_before: input.snapshot,
    workspace_fingerprint_before: workspaceFingerprint,
    allowed_commands: allowedCommands,
    operations: [],
    verification_runs: [],
    finalized: false,
    finalized_at: null,
    audited: false,
    change_artifacts: null,
  };

  atomicWriteJsonFileSync(join(dir, "session.json"), record);

  return record;
}

export function readDirectSession(
  sessionId: string,
  config: PatchWardenConfig = getConfig()
): DirectSessionRecord {
  const file = getDirectSessionFile(sessionId, config);

  if (!existsSync(file)) {
    throw new PatchWardenError(
      "session_not_found",
      `Direct session "${sessionId}" not found.`,
      "Call create_direct_session first to get a valid session_id.",
      true,
      { session_id: sessionId }
    );
  }

  let value: unknown;
  try {
    value = readJsonObjectFileSync(file);
  } catch {
    throw invalidDirectSessionRecord(sessionId, "session.json is not valid JSON");
  }
  return validateDirectSessionRecord(sessionId, value);
}

export function updateDirectSession(
  sessionId: string,
  updates: Partial<DirectSessionRecord>
): DirectSessionRecord {
  return mutateDirectSessionRecord(sessionId, (session) => ({
    ...session,
    ...updates,
    session_id: session.session_id,
  }));
}

export function appendDirectSessionOperation(
  sessionId: string,
  operation: DirectSessionOperation,
  config: PatchWardenConfig = getConfig(),
): DirectSessionRecord {
  return mutateDirectSessionRecord(sessionId, (session) => ({
    ...session,
    operations: [
      ...session.operations,
      {
        ...operation,
        index: session.operations.reduce((max, entry) => Math.max(max, entry.index), -1) + 1,
      },
    ],
  }), config);
}

export function withDirectSessionMutationLock<R>(
  sessionId: string,
  action: () => R,
  config: PatchWardenConfig = getConfig(),
): R {
  const lockTarget = join(getDirectSessionDir(sessionId, config), "workspace-mutation");
  return withFileLockSync(lockTarget, action, directSessionBusyOptions(sessionId));
}

export function withDirectSessionMutationLockAsync<R>(
  sessionId: string,
  action: () => Promise<R>,
  config: PatchWardenConfig = getConfig(),
): Promise<R> {
  const lockTarget = join(getDirectSessionDir(sessionId, config), "workspace-mutation");
  return withFileLock(lockTarget, action, directSessionBusyOptions(sessionId));
}

export function appendDirectSessionVerificationRun(
  sessionId: string,
  run: DirectSessionVerificationRun
): DirectSessionRecord {
  return mutateDirectSessionRecord(sessionId, (session) => ({
    ...session,
    verification_runs: [...session.verification_runs, run],
  }));
}

// ── Validation ─────────────────────────────────────────────────────

export interface DirectSessionValidationResult {
  valid: boolean;
  failure_reason: string | null;
  session: DirectSessionRecord | null;
}

export function validateDirectSessionFreshness(
  sessionId: string
): DirectSessionValidationResult {
  let session: DirectSessionRecord;
  try {
    session = readDirectSession(sessionId);
  } catch (e) {
    return {
      valid: false,
      failure_reason: extractReason(e),
      session: null,
    };
  }

  if (new Date(session.expires_at) < new Date()) {
    return { valid: false, failure_reason: "session_expired", session };
  }

  const currentManifest =
    getLastToolCatalogSnapshot()?.tool_manifest_sha256 ||
    computeFallbackManifestHash(getConfig());
  if (currentManifest !== session.tool_manifest_sha256) {
    return {
      valid: false,
      failure_reason: "session_stale_config",
      session,
    };
  }

  return { valid: true, failure_reason: null, session };
}

// ── Finalization ───────────────────────────────────────────────────

export function finalizeDirectSessionRecord(
  sessionId: string,
  changeArtifacts: ChangeArtifacts
): DirectSessionRecord {
  const dir = getDirectSessionDir(sessionId);

  // Write change artifacts to session directory
  atomicWriteJsonFileSync(join(dir, "changed-files.json"), changeArtifacts.changed_files);
  atomicWriteFileSync(join(dir, "diff.patch"), changeArtifacts.diff);

  const summary = {
    changed_files_total: changeArtifacts.changed_files.length,
    additions: changeArtifacts.additions,
    deletions: changeArtifacts.deletions,
    patch_mode: changeArtifacts.patch_mode,
    diff_redacted: changeArtifacts.diff_redacted === true,
    diff_redaction_categories: changeArtifacts.diff_redaction_categories ?? [],
    artifact_hygiene: changeArtifacts.artifact_hygiene,
  };
  atomicWriteJsonFileSync(join(dir, "summary.json"), summary);
  atomicWriteFileSync(join(dir, "summary.md"), formatSummaryMd(changeArtifacts));

  return updateDirectSession(sessionId, {
    finalized: true,
    finalized_at: new Date().toISOString(),
    change_artifacts: changeArtifacts,
  });
}

// ── Helpers ────────────────────────────────────────────────────────

export function computeWorkspaceFingerprint(snapshot: RepoSnapshot): string {
  const fileHashes = Object.entries(snapshot.files)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, fp]) => `${path}:${fp.sha256}`)
    .join("\n");
  return createHash("sha256")
    .update(`${snapshot.head || "null"}\n${snapshot.status}\n${fileHashes}`)
    .digest("hex");
}

function computeFallbackManifestHash(config: PatchWardenConfig): string {
  return createHash("sha256")
    .update(`${TOOL_SCHEMA_EPOCH}:${config.toolProfile || "full"}`)
    .digest("hex");
}

function extractReason(error: unknown): string {
  if (error instanceof PatchWardenError) return error.reason;
  if (error instanceof Error) return error.message.slice(0, 80);
  return String(error).slice(0, 80);
}

function invalidDirectSessionRecord(
  sessionId: string,
  detail: string
): PatchWardenError {
  return new PatchWardenError(
    "invalid_session_record",
    `Direct session "${sessionId}" is invalid: ${detail}.`,
    "Create a new direct session and do not modify its internal session.json file.",
    true,
    { session_id: sessionId }
  );
}

function getDirectSessionFile(
  sessionId: string,
  config: PatchWardenConfig = getConfig()
): string {
  const dir = getDirectSessionDir(sessionId, config);
  return guardPath(
    join(dir, "session.json"),
    config.workspaceRoot,
    config.directSessionsDir
  );
}

function mutateDirectSessionRecord(
  sessionId: string,
  mutation: (session: DirectSessionRecord) => DirectSessionRecord,
  config: PatchWardenConfig = getConfig(),
): DirectSessionRecord {
  const file = getDirectSessionFile(sessionId, config);
  if (!existsSync(file)) {
    throw new PatchWardenError(
      "session_not_found",
      `Direct session "${sessionId}" not found.`,
      "Call create_direct_session first to get a valid session_id.",
      true,
      { session_id: sessionId }
    );
  }
  return mutateLockedJsonFileSync<DirectSessionRecord, DirectSessionRecord>(
    file,
    (current) => {
      const session = validateDirectSessionRecord(sessionId, current);
      const next = mutation(session);
      return { next, result: next };
    },
    {
      busyError: () => new PatchWardenError(
        "direct_session_busy",
        `Direct session "${sessionId}" is currently being updated.`,
        "Retry after the current Direct operation completes.",
        true,
        { session_id: sessionId }
      ),
    }
  );
}

function directSessionBusyOptions(sessionId: string) {
  return {
    waitMs: 0,
    busyError: () => new PatchWardenError(
      "direct_session_busy",
      `Direct session "${sessionId}" already has a workspace operation in progress.`,
      "Wait for the active patch, sync, verification, or finalization to finish, then retry.",
      true,
      { session_id: sessionId },
    ),
  };
}

function validateDirectSessionRecord(sessionId: string, value: unknown): DirectSessionRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidDirectSessionRecord(sessionId, "session.json must contain an object");
  }
  const record = value as Partial<DirectSessionRecord>;
  if (record.session_id !== sessionId) {
    throw invalidDirectSessionRecord(sessionId, "session_id does not match its directory");
  }
  if (typeof record.resolved_repo_path !== "string" || record.resolved_repo_path.trim() === "") {
    throw invalidDirectSessionRecord(sessionId, "resolved_repo_path is missing");
  }
  if (typeof record.expires_at !== "string" || !Number.isFinite(Date.parse(record.expires_at))) {
    throw invalidDirectSessionRecord(sessionId, "expires_at is invalid");
  }
  if (typeof record.finalized !== "boolean") {
    throw invalidDirectSessionRecord(sessionId, "finalized must be a boolean");
  }
  if (!Array.isArray(record.operations) || !Array.isArray(record.verification_runs)) {
    throw invalidDirectSessionRecord(sessionId, "operation or verification history is invalid");
  }
  return record as DirectSessionRecord;
}

function formatSummaryMd(artifacts: ChangeArtifacts): string {
  const lines: string[] = [
    "# Direct Session Change Summary",
    "",
    `**Changed files:** ${artifacts.changed_files.length}`,
    `**Additions:** ${artifacts.additions}`,
    `**Deletions:** ${artifacts.deletions}`,
    `**Patch mode:** ${artifacts.patch_mode}`,
    `**Diff redacted:** ${artifacts.diff_redacted === true ? "yes" : "no"}`,
    "",
    "## Artifact Hygiene",
    "",
    `- Source changes: ${artifacts.artifact_hygiene.counts.source_changes}`,
    `- Tracked build artifacts: ${artifacts.artifact_hygiene.counts.tracked_build_artifacts}`,
    `- Runtime generated files: ${artifacts.artifact_hygiene.counts.runtime_generated_files}`,
    `- Suspicious changes: ${artifacts.artifact_hygiene.counts.suspicious_changes}`,
    "",
    "## Changed Files",
    "",
  ];

  for (const file of artifacts.changed_files) {
    lines.push(`- **${file.change}**: ${file.path}${file.old_path ? ` (from ${file.old_path})` : ""}`);
  }

  return lines.join("\n");
}
