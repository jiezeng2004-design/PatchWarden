import {
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
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
import { getLastToolCatalogSnapshot } from "../tools/toolCatalog.js";
import {
  captureRepoSnapshot,
  buildChangeArtifacts,
  type RepoSnapshot,
  type ChangeArtifacts,
} from "../runner/changeCapture.js";

// ── Types ──────────────────────────────────────────────────────────

export interface DirectSessionOperation {
  index: number;
  timestamp: string;
  path: string;
  before_sha256: string;
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

// ── Directory management ───────────────────────────────────────────

export function createDirectSessionDir(sessionId: string): string {
  const config = getConfig();
  const sessionsDir = getDirectSessionsDir(config);
  guardPath(sessionsDir, config.workspaceRoot, config.directSessionsDir);
  mkdirSync(sessionsDir, { recursive: true });
  const dir = resolve(sessionsDir, sessionId);
  guardPath(dir, config.workspaceRoot, config.directSessionsDir);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function getDirectSessionDir(sessionId: string): string {
  const config = getConfig();
  const sessionsDir = getDirectSessionsDir(config);
  return resolve(sessionsDir, sessionId);
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
    title: input.title || "",
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

  writeFileSync(
    join(dir, "session.json"),
    JSON.stringify(record, null, 2),
    "utf-8"
  );

  return record;
}

export function readDirectSession(sessionId: string): DirectSessionRecord {
  const config = getConfig();
  const sessionsDir = getDirectSessionsDir(config);
  const dir = resolve(sessionsDir, sessionId);
  const file = join(dir, "session.json");
  guardPath(file, config.workspaceRoot, config.directSessionsDir);

  if (!existsSync(file)) {
    throw new PatchWardenError(
      "session_not_found",
      `Direct session "${sessionId}" not found.`,
      "Call create_direct_session first to get a valid session_id.",
      true,
      { session_id: sessionId }
    );
  }

  return JSON.parse(readFileSync(file, "utf-8")) as DirectSessionRecord;
}

export function updateDirectSession(
  sessionId: string,
  updates: Partial<DirectSessionRecord>
): DirectSessionRecord {
  const session = readDirectSession(sessionId);
  const updated: DirectSessionRecord = { ...session, ...updates };
  const dir = getDirectSessionDir(sessionId);
  writeFileSync(
    join(dir, "session.json"),
    JSON.stringify(updated, null, 2),
    "utf-8"
  );
  return updated;
}

export function appendDirectSessionOperation(
  sessionId: string,
  operation: DirectSessionOperation
): DirectSessionRecord {
  const session = readDirectSession(sessionId);
  const operations = [...session.operations, operation];
  return updateDirectSession(sessionId, { operations });
}

export function appendDirectSessionVerificationRun(
  sessionId: string,
  run: DirectSessionVerificationRun
): DirectSessionRecord {
  const session = readDirectSession(sessionId);
  const verification_runs = [...session.verification_runs, run];
  return updateDirectSession(sessionId, { verification_runs });
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
  afterSnapshot: RepoSnapshot,
  changeArtifacts: ChangeArtifacts
): DirectSessionRecord {
  const dir = getDirectSessionDir(sessionId);

  // Write change artifacts to session directory
  writeFileSync(
    join(dir, "changed-files.json"),
    JSON.stringify(changeArtifacts.changed_files, null, 2),
    "utf-8"
  );
  writeFileSync(join(dir, "diff.patch"), changeArtifacts.diff, "utf-8");

  const summary = {
    changed_files_total: changeArtifacts.changed_files.length,
    additions: changeArtifacts.additions,
    deletions: changeArtifacts.deletions,
    patch_mode: changeArtifacts.patch_mode,
    artifact_hygiene: changeArtifacts.artifact_hygiene,
  };
  writeFileSync(
    join(dir, "summary.json"),
    JSON.stringify(summary, null, 2),
    "utf-8"
  );
  writeFileSync(join(dir, "summary.md"), formatSummaryMd(changeArtifacts), "utf-8");

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

function formatSummaryMd(artifacts: ChangeArtifacts): string {
  const lines: string[] = [
    "# Direct Session Change Summary",
    "",
    `**Changed files:** ${artifacts.changed_files.length}`,
    `**Additions:** ${artifacts.additions}`,
    `**Deletions:** ${artifacts.deletions}`,
    `**Patch mode:** ${artifacts.patch_mode}`,
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
