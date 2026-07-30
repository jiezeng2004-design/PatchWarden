import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { getConfig, type PatchWardenConfig } from "../config.js";
import { PatchWardenError } from "../errors.js";
import { guardDirectCommand } from "../security/commandGuard.js";
import { redactSensitiveContent } from "../security/contentRedaction.js";
import { resolveTrustedCommandLine } from "../runner/processSecurity.js";
import { stableJsonStringify } from "../utils/stableJson.js";
import { atomicWriteJsonFileSync } from "../utils/atomicFile.js";
import { readJsonObjectFileSync, withFileLockSync, type LockedJsonOptions } from "../utils/lockedJsonFile.js";
import {
  guardDirectFileSize,
  guardDirectPatchSize,
  guardDirectReadPath,
  guardDirectSessionActive,
  guardDirectWritePath,
} from "./directGuards.js";
import {
  getDirectSessionDir,
  readDirectSession,
  upsertDirectReviewEvent,
  validateDirectSessionFreshness,
  type DirectReviewEvent,
  type DirectReviewOperationType,
  type DirectSessionRecord,
} from "./directSessionStore.js";
import { computeDirectReviewPolicyHash } from "./directReviewPolicy.js";
import { runDirectReviewer, type DirectReviewerInput, type DirectReviewerResult } from "./directReviewer.js";
import { captureDirectVerificationWorkspaceSha256 } from "./directVerificationFingerprint.js";

const REVIEW_ID_PATTERN = /^direct_review_\d{8}_\d{6}_[a-f0-9]{32}$/;
const REVIEW_RECORD_VERSION = "direct-review-v2";
const REVIEW_HMAC_PATTERN = /^[a-f0-9]{64}$/;
const MAX_CONSUMED_REVIEW_IDS = 100_000;
const SHADOW_UNBOUND_WORKSPACE_SHA256 = createHash("sha256")
  .update("patchwarden-direct-review-shadow-unbound-workspace-v1", "utf-8")
  .digest("hex");
// Deliberately process-local: a restart invalidates every outstanding grant.
// This keeps the signing secret out of the workspace and away from reviewer
// subprocesses, at the cost of requiring a fresh review after a restart.
const REVIEW_HMAC_KEY = randomBytes(32);
const consumedReviewIds = new Set<string>();

export interface DirectOperationRequest {
  operation_type: DirectReviewOperationType;
  path?: unknown;
  source_path?: unknown;
  target_path?: unknown;
  expected_sha256?: unknown;
  expected_source_sha256?: unknown;
  operations?: unknown;
  content?: unknown;
  command?: unknown;
  commands?: unknown;
  timeout_seconds?: unknown;
  verification_workspace_sha256?: unknown;
  verification_workspace_incomplete?: unknown;
}

export interface DirectReviewProposal {
  operation_type: DirectReviewOperationType;
  affected_paths: string[];
  proposal_sha256: string;
  normalized: Record<string, unknown>;
  content_preview: string;
  summary: string;
}

export interface DirectReviewRecord {
  record_version: typeof REVIEW_RECORD_VERSION;
  review_id: string;
  session_id: string;
  operation_type: DirectReviewOperationType;
  mode: "off" | "shadow" | "enforce";
  nonce: string;
  proposal_sha256: string;
  precondition_sha256: string | null;
  session_state_sha256: string;
  policy_sha256: string;
  tool_manifest_sha256: string;
  deterministic_risk_level: "low" | "medium" | "high";
  risk_level: "low" | "medium" | "high";
  decision: "allow" | "needs_approval" | "blocked";
  reason_codes: string[];
  reviewer_agent: string | null;
  reviewer_status: DirectReviewerResult["status"] | "not_requested";
  reviewer_confidence: number | null;
  reviewer_notes: string;
  outer_approval_required: boolean;
  outer_approval_attested: false;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  execution_status: "pending" | "executed" | "failed";
  execution_error: string | null;
  integrity_hmac_sha256: string;
}

export interface RequestDirectReviewInput extends DirectOperationRequest {
  session_id: string;
}

export interface RequestDirectReviewOutput {
  review_id: string;
  operation_type: DirectReviewOperationType;
  risk_level: DirectReviewRecord["risk_level"];
  decision: DirectReviewRecord["decision"];
  reason_codes: string[];
  reviewer: {
    agent: string | null;
    status: DirectReviewRecord["reviewer_status"];
    confidence: number | null;
  };
  outer_approval_required: boolean;
  outer_approval_attested: false;
  expires_at: string;
  next_action: string;
}

export interface DirectReviewAuthorization {
  review: DirectReviewRecord | null;
  mode: "off" | "shadow" | "enforce";
}

export interface DirectReviewAuditReceipt {
  review_id: string;
  session_id: string;
  operation_type: DirectReviewOperationType;
  proposal_sha256: string;
  mode: DirectReviewRecord["mode"];
  risk_level: DirectReviewRecord["risk_level"];
  decision: DirectReviewRecord["decision"];
  reviewer_agent: string | null;
  reviewer_status: DirectReviewRecord["reviewer_status"];
  outer_approval_required: boolean;
  reason_codes: string[];
  used_at: string | null;
  execution_status: DirectReviewRecord["execution_status"];
  integrity_hmac_sha256: string;
}

export interface DirectReviewDependencies {
  reviewer: (input: DirectReviewerInput) => Promise<DirectReviewerResult>;
  now: () => Date;
}

const defaultDependencies: DirectReviewDependencies = {
  reviewer: runDirectReviewer,
  now: () => new Date(),
};

export async function requestDirectReview(
  input: RequestDirectReviewInput,
  dependencies: DirectReviewDependencies = defaultDependencies,
): Promise<RequestDirectReviewOutput> {
  const config = getConfig();
  const freshness = validateDirectSessionFreshness(input.session_id);
  if (!freshness.valid || !freshness.session) {
    throw reviewError(
      freshness.failure_reason || "direct_review_session_invalid",
      `Direct session cannot be reviewed: ${freshness.failure_reason || "unknown"}.`,
      "Create a fresh Direct session before requesting an operation review.",
    );
  }
  const session = freshness.session;
  guardDirectSessionActive(session);
  const proposal = await buildDirectReviewProposalForCurrentWorkspace(session, input, config);
  validateDirectReviewProposal(session, proposal, config);
  const reviewedSessionStateSha256 = computeSessionStateHash(session);

  const reviewId = generateDirectReviewId(dependencies.now());
  const reviewDir = prepareDirectReviewStorage(input.session_id, reviewId);
  const base = assessDeterministicRisk(proposal);
  let reviewer: DirectReviewerResult = {
    status: "not_requested",
    risk_level: "low",
    reason_codes: [],
    confidence: null,
    notes: "Direct review is disabled.",
    read_only_violation: false,
  };

  if (config.directReview.mode !== "off" && base.risk_level !== "high") {
    const reviewerName = config.directReview.reviewerAgentName || "";
    if (!reviewerName || reviewerName === session.requester_agent) {
      reviewer = {
        status: "not_independent",
        risk_level: "high",
        reason_codes: ["reviewer_not_independent"],
        confidence: null,
        notes: "A Direct reviewer must be configured separately from the requesting Agent.",
        read_only_violation: false,
      };
    } else {
      try {
        reviewer = await dependencies.reviewer({
          reviewerAgentName: reviewerName,
          requesterAgentName: session.requester_agent,
          repoPath: session.resolved_repo_path,
          sessionTitle: session.title,
          proposal: {
            operation_type: proposal.operation_type,
            affected_paths: proposal.affected_paths,
            content_preview: proposal.content_preview,
            summary: proposal.summary,
          },
          reviewDir,
          timeoutSeconds: config.agentAssessmentTimeoutSeconds || 120,
          maxOutputBytes: config.agentAssessmentMaxOutputBytes || 524_288,
          config,
        });
      } catch {
        reviewer = {
          status: "spawn_failed",
          risk_level: "high",
          reason_codes: ["reviewer_unavailable"],
          confidence: null,
          notes: "The configured reviewer did not return a usable decision.",
          read_only_violation: false,
        };
      }
    }
  }

  const currentSession = readDirectSession(input.session_id);
  if (computeSessionStateHash(currentSession) !== reviewedSessionStateSha256) {
    reviewer = {
      status: "session_changed",
      risk_level: "high",
      reason_codes: ["direct_session_changed_during_review"],
      confidence: null,
      notes: "The Direct session changed while the independent review was running.",
      read_only_violation: false,
    };
  }
  const merged = mergeRisk(base, reviewer, config.directReview.mode);
  const now = dependencies.now();
  const nonce = reviewId.slice(reviewId.lastIndexOf("_") + 1);
  const unsignedRecord: Omit<DirectReviewRecord, "integrity_hmac_sha256"> = {
    record_version: REVIEW_RECORD_VERSION,
    review_id: reviewId,
    session_id: input.session_id,
    operation_type: proposal.operation_type,
    mode: config.directReview.mode,
    nonce,
    proposal_sha256: proposal.proposal_sha256,
    precondition_sha256: proposalPreconditionSha256(proposal),
    session_state_sha256: computeSessionStateHash(currentSession),
    policy_sha256: computeDirectReviewPolicyHash(config.directReview),
    tool_manifest_sha256: currentSession.tool_manifest_sha256,
    deterministic_risk_level: base.risk_level,
    risk_level: merged.risk_level,
    decision: merged.decision,
    reason_codes: merged.reason_codes,
    reviewer_agent: config.directReview.mode === "off" ? null : config.directReview.reviewerAgentName || null,
    reviewer_status: reviewer.status,
    reviewer_confidence: reviewer.confidence,
    reviewer_notes: redactSensitiveContent(reviewer.notes).content.slice(0, 1000),
    outer_approval_required: merged.decision === "needs_approval" && config.directReview.autoReviewRequired,
    outer_approval_attested: false,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + config.directReview.ttlSeconds * 1000).toISOString(),
    used_at: null,
    execution_status: "pending",
    execution_error: null,
  };
  const record = signDirectReviewRecord(unsignedRecord);
  const reviewFile = guardDirectReviewFile(input.session_id, reviewId, true);
  atomicWriteJsonFileSync(reviewFile, record);
  upsertDirectReviewEvent(input.session_id, eventFromRecord(record, record.decision === "blocked" ? "blocked" : "requested"));

  return {
    review_id: record.review_id,
    operation_type: record.operation_type,
    risk_level: record.risk_level,
    decision: record.decision,
    reason_codes: record.reason_codes,
    reviewer: {
      agent: record.reviewer_agent,
      status: record.reviewer_status,
      confidence: record.reviewer_confidence,
    },
    outer_approval_required: record.outer_approval_required,
    outer_approval_attested: false,
    expires_at: record.expires_at,
    next_action: nextAction(record, config.directReview.mode),
  };
}

export function buildDirectReviewProposal(
  session: DirectSessionRecord,
  input: DirectOperationRequest,
): DirectReviewProposal {
  const type = input.operation_type;
  const normalized: Record<string, unknown> = { operation_type: type, session_id: session.session_id };
  let paths: string[] = [];
  let preview = "";
  let summary: string = type;
  if (type === "patch") {
    const path = requiredString(input.path, "path");
    const expected = requiredString(input.expected_sha256, "expected_sha256");
    if (!Array.isArray(input.operations) || input.operations.length === 0) throw reviewError("direct_review_invalid_operation", "Patch review requires at least one operation.", "Provide the same patch operations intended for apply_patch.");
    normalized.path = path;
    normalized.expected_sha256 = expected;
    normalized.operations = input.operations;
    paths = [path];
    const redacted = redactSensitiveContent(stableJsonStringify(input.operations));
    preview = redacted.content.slice(0, 4_000);
    summary = `Patch ${path} with ${input.operations.length} operation(s).`;
  } else if (type === "create") {
    const path = requiredString(input.path, "path");
    if (typeof input.content !== "string") throw reviewError("direct_review_invalid_operation", "Create review requires string content.", "Provide the exact UTF-8 content intended for create_file.");
    normalized.path = path;
    normalized.content = input.content;
    paths = [path];
    preview = redactSensitiveContent(input.content).content.slice(0, 4_000);
    summary = `Create ${path} (${Buffer.byteLength(input.content, "utf-8")} bytes).`;
  } else if (type === "mkdir") {
    const path = requiredString(input.path, "path");
    normalized.path = path;
    paths = [path];
    summary = `Create directory ${path}.`;
  } else if (type === "move") {
    const source = requiredString(input.source_path, "source_path");
    const target = requiredString(input.target_path, "target_path");
    normalized.source_path = source;
    normalized.target_path = target;
    normalized.expected_source_sha256 = requiredString(input.expected_source_sha256, "expected_source_sha256");
    paths = [source, target];
    summary = `Move ${source} to ${target}.`;
  } else if (type === "delete") {
    const path = requiredString(input.path, "path");
    normalized.path = path;
    normalized.expected_sha256 = requiredString(input.expected_sha256, "expected_sha256");
    paths = [path];
    summary = `Delete ${path}.`;
  } else if (type === "verification") {
    const command = requiredString(input.command, "command");
    normalized.command = command;
    normalized.timeout_seconds = normalizeTimeout(input.timeout_seconds);
    normalized.workspace_sha256 = input.verification_workspace_incomplete === true
      ? SHADOW_UNBOUND_WORKSPACE_SHA256
      : normalizeOptionalWorkspaceSha256(input.verification_workspace_sha256);
    normalized.workspace_snapshot_status = input.verification_workspace_incomplete === true ? "incomplete" : "complete";
    summary = `Run allow-listed verification command ${command}.`;
  } else if (type === "verification_bundle") {
    if (!Array.isArray(input.commands) || input.commands.length === 0 || input.commands.some((entry) => typeof entry !== "string" || !entry.trim())) {
      throw reviewError("direct_review_invalid_operation", "Verification bundle requires non-empty command strings.", "Provide the exact allow-listed commands intended for the bundle.");
    }
    normalized.commands = input.commands.map((entry) => (entry as string).trim());
    normalized.timeout_seconds = normalizeTimeout(input.timeout_seconds);
    normalized.workspace_sha256 = input.verification_workspace_incomplete === true
      ? SHADOW_UNBOUND_WORKSPACE_SHA256
      : normalizeOptionalWorkspaceSha256(input.verification_workspace_sha256);
    normalized.workspace_snapshot_status = input.verification_workspace_incomplete === true ? "incomplete" : "complete";
    summary = `Run ${input.commands.length} allow-listed verification command(s).`;
  } else {
    throw reviewError("direct_review_invalid_operation", `Unsupported Direct operation type "${String(type)}".`, "Use a supported Direct operation type.");
  }
  bindCanonicalDirectPaths(session, normalized);
  const proposal_sha256 = createHash("sha256").update(stableJsonStringify(normalized)).digest("hex");
  return { operation_type: type, affected_paths: paths, proposal_sha256, normalized, content_preview: preview, summary };
}

export async function buildDirectReviewProposalForCurrentWorkspace(
  session: DirectSessionRecord,
  input: DirectOperationRequest,
  config: PatchWardenConfig = getConfig(),
): Promise<DirectReviewProposal> {
  if ((input.operation_type === "verification" || input.operation_type === "verification_bundle")
    && config.directReview.mode !== "off") {
    try {
      const verificationWorkspaceSha256 = await captureDirectVerificationWorkspaceSha256(
        session.resolved_repo_path,
      );
      return buildDirectReviewProposal(session, {
        ...input,
        verification_workspace_sha256: verificationWorkspaceSha256,
      });
    } catch (error) {
      // Shadow must preserve the original Direct operation while retaining a
      // truthful would-block event. Enforce keeps the fingerprint failure
      // fail-closed and never receives an unbound grant.
      if (config.directReview.mode === "shadow" && isWorkspaceSnapshotIncomplete(error)) {
        return buildDirectReviewProposal(session, {
          ...input,
          verification_workspace_incomplete: true,
        });
      }
      throw error;
    }
  }
  return buildDirectReviewProposal(session, input);
}

export function validateDirectReviewProposal(
  session: DirectSessionRecord,
  proposal: DirectReviewProposal,
  config: PatchWardenConfig = getConfig(),
): void {
  guardDirectSessionActive(session);
  const freshness = validateDirectSessionFreshness(session.session_id);
  if (!freshness.valid) throw reviewError(freshness.failure_reason || "direct_review_stale_config", "The Direct session is no longer fresh for review.", "Create a fresh session and request a new review.");
  const n = proposal.normalized;
  if (proposal.operation_type === "patch") {
    guardDirectWritePath(String(n.path), session.resolved_repo_path, config.workspaceRoot);
    assertSha256(n.expected_sha256, "expected_sha256");
    const bytes = Buffer.byteLength(stableJsonStringify(n.operations), "utf-8");
    guardDirectPatchSize(bytes);
    blockSensitiveProposedContent(stableJsonStringify(n.operations), String(n.path));
  } else if (proposal.operation_type === "create") {
    guardDirectWritePath(String(n.path), session.resolved_repo_path, config.workspaceRoot);
    const content = String(n.content);
    guardDirectFileSize(Buffer.byteLength(content, "utf-8"), config);
    blockSensitiveProposedContent(content, String(n.path));
  } else if (proposal.operation_type === "mkdir") {
    guardDirectWritePath(String(n.path), session.resolved_repo_path, config.workspaceRoot);
  } else if (proposal.operation_type === "move") {
    guardDirectReadPath(String(n.source_path), session.resolved_repo_path, config.workspaceRoot);
    guardDirectWritePath(String(n.source_path), session.resolved_repo_path, config.workspaceRoot);
    guardDirectWritePath(String(n.target_path), session.resolved_repo_path, config.workspaceRoot);
    assertSha256(n.expected_source_sha256, "expected_source_sha256");
  } else if (proposal.operation_type === "delete") {
    guardDirectReadPath(String(n.path), session.resolved_repo_path, config.workspaceRoot);
    guardDirectWritePath(String(n.path), session.resolved_repo_path, config.workspaceRoot);
    assertSha256(n.expected_sha256, "expected_sha256");
  } else if (proposal.operation_type === "verification") {
    validateVerificationWorkspaceBinding(n, config);
    const command = guardDirectCommand(String(n.command), config, session.resolved_repo_path);
    validateDirectCommandSyntax(command, session.resolved_repo_path);
  } else if (proposal.operation_type === "verification_bundle") {
    validateVerificationWorkspaceBinding(n, config);
    for (const value of n.commands as string[]) {
      const command = guardDirectCommand(value, config, session.resolved_repo_path);
      validateDirectCommandSyntax(command, session.resolved_repo_path);
    }
  }
}

function validateVerificationWorkspaceBinding(
  normalized: Record<string, unknown>,
  config: PatchWardenConfig,
): void {
  if (config.directReview.mode === "off") return;
  assertSha256(normalized.workspace_sha256, "workspace_sha256");
  const status = normalized.workspace_snapshot_status;
  if (status === "complete") return;
  if (status === "incomplete" && config.directReview.mode === "shadow") return;
  throw reviewError(
    "direct_review_workspace_snapshot_incomplete",
    "A Direct verification workspace fingerprint is incomplete.",
    "Use shadow mode only to record the would-block outcome, or repair the workspace and request a fresh enforce review.",
  );
}

export function authorizeDirectOperation(
  session: DirectSessionRecord,
  proposal: DirectReviewProposal,
  reviewId: string | undefined,
): DirectReviewAuthorization {
  const config = getConfig();
  if (config.directReview.mode === "off") return { review: null, mode: "off" };
  if (config.directReview.mode === "shadow") {
    const record = reviewId ? tryReadDirectReview(session.session_id, reviewId) : null;
    const wouldBlock = !record || !reviewMatches(session, proposal, record) || record.decision === "blocked";
    const event: DirectReviewEvent = record
      ? eventFromRecord(record, wouldBlock ? "would_block" : "authorized")
      : syntheticEvent(session, proposal, "would_block", shadowReasonCodes(proposal));
    upsertDirectReviewEvent(session.session_id, event);
    // A shadow-only would-block event must remain visible after the operation;
    // do not attach the rejected/mismatched ticket to execution completion.
    return { review: wouldBlock ? null : record, mode: "shadow" };
  }
  if (!reviewId) {
    throw reviewError("direct_review_required", "This Direct operation requires a fresh review_id in enforce mode.", "Call request_direct_review with the exact operation first.");
  }
  const record = consumeDirectReview(session, proposal, reviewId);
  upsertDirectReviewEvent(session.session_id, eventFromRecord(record, "authorized"));
  return { review: record, mode: "enforce" };
}

export function completeDirectReview(
  sessionId: string,
  authorization: DirectReviewAuthorization,
  success: boolean,
  error?: unknown,
): void {
  if (!authorization.review) return;
  const current = updateDirectReviewExecution(sessionId, authorization.review.review_id, success, error);
  upsertDirectReviewEvent(sessionId, eventFromRecord(current, success ? "executed" : "failed"));
}

function mergeRisk(
  base: { risk_level: "low" | "medium" | "high"; reason_codes: string[] },
  reviewer: DirectReviewerResult,
  mode: "off" | "shadow" | "enforce",
): { risk_level: "low" | "medium" | "high"; decision: DirectReviewRecord["decision"]; reason_codes: string[] } {
  const order = { low: 0, medium: 1, high: 2 } as const;
  const reviewerRisk = reviewer.status === "completed" ? reviewer.risk_level : mode === "off" ? "low" : "high";
  const risk_level = order[reviewerRisk] > order[base.risk_level] ? reviewerRisk : base.risk_level;
  const reason_codes = [...new Set([...base.reason_codes, ...reviewer.reason_codes])].slice(0, 30);
  if (risk_level === "high") return { risk_level, decision: "blocked", reason_codes };
  return { risk_level, decision: risk_level === "medium" ? "needs_approval" : "allow", reason_codes };
}

function assessDeterministicRisk(proposal: DirectReviewProposal): { risk_level: "low" | "medium" | "high"; reason_codes: string[] } {
  if (proposal.operation_type === "delete") return { risk_level: "high", reason_codes: ["direct_delete_high_risk"] };
  const paths = proposal.affected_paths.map((path) => path.replace(/\\/g, "/").toLowerCase());
  if (proposal.operation_type === "move") return { risk_level: "medium", reason_codes: ["direct_move_needs_review"] };
  if (proposal.operation_type === "verification" || proposal.operation_type === "verification_bundle") {
    if (proposal.normalized.workspace_snapshot_status === "incomplete") {
      return { risk_level: "high", reason_codes: ["direct_verification_workspace_snapshot_incomplete"] };
    }
    const commands = proposal.operation_type === "verification"
      ? [String(proposal.normalized.command)]
      : proposal.normalized.commands as string[];
    if (commands.some(isHighRiskDirectCommand)) {
      return { risk_level: "high", reason_codes: ["direct_command_hard_boundary"] };
    }
    return { risk_level: "medium", reason_codes: ["direct_command_needs_review"] };
  }
  if (paths.some((path) => /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(path))) {
    return { risk_level: "medium", reason_codes: ["dependency_file_needs_review"] };
  }
  const operations = proposal.normalized.operations;
  if (Array.isArray(operations) && operations.some((entry) => entry && typeof entry === "object" && (entry as Record<string, unknown>).type === "replace_whole_file")) {
    return { risk_level: "medium", reason_codes: ["whole_file_replace_needs_review"] };
  }
  if (proposal.content_preview.length >= 4_000) return { risk_level: "medium", reason_codes: ["large_content_needs_review"] };
  return { risk_level: "low", reason_codes: ["direct_scoped_operation"] };
}

function isHighRiskDirectCommand(command: string): boolean {
  const normalized = command.trim().toLowerCase();
  return /(?:^|\s)(?:npm(?:\.cmd)?\s+publish|pnpm\s+publish|yarn\s+npm\s+publish|git\s+(?:push|tag)|gh\s+release|docker\s+push|kubectl\s+(?:apply|delete|rollout|scale)|helm\s+(?:install|upgrade|uninstall)|systemctl|service|sc(?:\.exe)?\s+(?:start|stop|delete|create)|net\s+(?:start|stop)|taskkill|shutdown)(?:\s|$)/i.test(normalized)
    || /(?:^|[^a-z0-9_])(?:deploy|publish)(?=$|[^a-z0-9_])/i.test(normalized);
}

function validateDirectCommandSyntax(command: string, repoPath: string): void {
  try {
    resolveTrustedCommandLine(command, repoPath);
  } catch {
    throw reviewError(
      "direct_review_invalid_command",
      "The Direct verification command cannot be executed by the shell-free command runner.",
      "Use an exact allow-listed command without shell metacharacters, redirection, or chaining.",
    );
  }
}

function consumeDirectReview(session: DirectSessionRecord, proposal: DirectReviewProposal, reviewId: string): DirectReviewRecord {
  if (consumedReviewIds.has(reviewId)) {
    throw reviewError("direct_review_used", "This Direct review grant has already been consumed.", "Request a new review for a retry.");
  }
  const file = guardDirectReviewFile(session.session_id, reviewId, false);
  if (!existsSync(file)) throw reviewError("direct_review_not_found", `Direct review "${reviewId}" was not found.`, "Request a new review for the exact operation.");
  return mutateDirectReviewRecord(session.session_id, reviewId, (raw) => {
    const record = validateReviewRecord(raw);
    if (consumedReviewIds.has(record.review_id)) {
      throw reviewError("direct_review_used", "This Direct review grant has already been consumed.", "Request a new review for a retry.");
    }
    if (record.session_id !== session.session_id
      || record.operation_type !== proposal.operation_type
      || record.proposal_sha256 !== proposal.proposal_sha256) {
      throw reviewError("direct_review_mismatch", "The review does not match this session or exact operation.", "Request a new review for the exact normalized parameters.");
    }
    if (record.used_at) throw reviewError("direct_review_used", "This Direct review grant has already been consumed.", "Request a new review for a retry.");
    if (Date.parse(record.expires_at) <= Date.now()) {
      throw reviewError("direct_review_expired", "This Direct review grant has expired.", "Request a fresh review for the exact operation.");
    }
    if (record.policy_sha256 !== computeDirectReviewPolicyHash(getConfig().directReview)) {
      throw reviewError("direct_review_stale_policy", "The Direct review policy changed after this grant was issued.", "Create a fresh Direct session and request a new review.");
    }
    if (record.tool_manifest_sha256 !== session.tool_manifest_sha256) {
      throw reviewError("direct_review_stale_manifest", "The Direct tool manifest changed after this grant was issued.", "Create a fresh Direct session and request a new review.");
    }
    if (record.session_state_sha256 !== computeSessionStateHash(session)) {
      throw reviewError("direct_review_state_drift", "The Direct session changed after this grant was issued.", "Re-read the current state and request a new review.");
    }
    if (record.decision === "blocked") throw reviewError("direct_review_blocked", "This Direct operation was blocked by the review policy.", "Choose a safer operation or use a separate trusted local workflow.");
    if (consumedReviewIds.size >= MAX_CONSUMED_REVIEW_IDS) {
      throw reviewError("direct_review_nonce_store_full", "The local Direct review nonce store is full.", "Restart PatchWarden and request a fresh review; outstanding tickets are intentionally invalidated on restart.");
    }
    consumedReviewIds.add(record.review_id);
    return { ...record, used_at: new Date().toISOString() };
  }, { waitMs: 0, busyError: () => reviewError("direct_review_busy", "The Direct review is being consumed by another operation.", "Retry only after the current operation completes.") });
}

function updateDirectReviewExecution(sessionId: string, reviewId: string, success: boolean, error?: unknown): DirectReviewRecord {
  return mutateDirectReviewRecord(sessionId, reviewId, (raw) => {
    const record = validateReviewRecord(raw);
    return {
      ...record,
      execution_status: success ? "executed" : "failed",
      execution_error: success ? null : redactSensitiveContent(error instanceof Error ? error.message : String(error || "operation_failed")).content.slice(0, 300),
    };
  });
}

function reviewMatches(session: DirectSessionRecord, proposal: DirectReviewProposal, record: DirectReviewRecord): boolean {
  return record.session_id === session.session_id
    && record.operation_type === proposal.operation_type
    && record.proposal_sha256 === proposal.proposal_sha256
    && record.session_state_sha256 === computeSessionStateHash(session)
    && record.policy_sha256 === computeDirectReviewPolicyHash(getConfig().directReview)
    && record.tool_manifest_sha256 === session.tool_manifest_sha256
    && !record.used_at
    && Date.parse(record.expires_at) > Date.now();
}

function bindCanonicalDirectPaths(
  session: DirectSessionRecord,
  normalized: Record<string, unknown>,
): void {
  const config = getConfig();
  const repoPath = session.resolved_repo_path;
  if (normalized.operation_type === "patch" || normalized.operation_type === "create" || normalized.operation_type === "mkdir") {
    normalized.canonical_path = guardDirectWritePath(String(normalized.path), repoPath, config.workspaceRoot);
  } else if (normalized.operation_type === "delete") {
    guardDirectReadPath(String(normalized.path), repoPath, config.workspaceRoot);
    normalized.canonical_path = guardDirectWritePath(String(normalized.path), repoPath, config.workspaceRoot);
  } else if (normalized.operation_type === "move") {
    normalized.canonical_source_path = guardDirectReadPath(String(normalized.source_path), repoPath, config.workspaceRoot);
    normalized.canonical_target_path = guardDirectWritePath(String(normalized.target_path), repoPath, config.workspaceRoot);
  }
}

function tryReadDirectReview(sessionId: string, reviewId: string): DirectReviewRecord | null {
  try {
    if (!REVIEW_ID_PATTERN.test(reviewId)) return null;
    const file = guardDirectReviewFile(sessionId, reviewId, false);
    if (!existsSync(file)) return null;
    return validateReviewRecord(readJsonObjectFileSync<DirectReviewRecord>(file));
  } catch {
    return null;
  }
}

export function readDirectReviewAuditReceipt(
  sessionId: string,
  reviewId: string,
): DirectReviewAuditReceipt | null {
  const record = tryReadDirectReview(sessionId, reviewId);
  if (!record) return null;
  return {
    review_id: record.review_id,
    session_id: record.session_id,
    operation_type: record.operation_type,
    proposal_sha256: record.proposal_sha256,
    mode: record.mode,
    risk_level: record.risk_level,
    decision: record.decision,
    reviewer_agent: record.reviewer_agent,
    reviewer_status: record.reviewer_status,
    outer_approval_required: record.outer_approval_required,
    reason_codes: record.reason_codes,
    used_at: record.used_at,
    execution_status: record.execution_status,
    integrity_hmac_sha256: record.integrity_hmac_sha256,
  };
}

function validateReviewRecord(value: unknown): DirectReviewRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw reviewError("invalid_direct_review", "Direct review record is invalid.", "Request a new Direct review.");
  const record = value as Partial<DirectReviewRecord>;
  verifyDirectReviewHmac(record);
  if (record.record_version !== REVIEW_RECORD_VERSION || typeof record.review_id !== "string" || !REVIEW_ID_PATTERN.test(record.review_id)) {
    throw reviewError("invalid_direct_review", "Direct review identity is invalid.", "Request a new Direct review.");
  }
  const expectedNonce = record.review_id.slice(record.review_id.lastIndexOf("_") + 1);
  if (record.nonce !== expectedNonce || !/^[a-f0-9]{32}$/.test(expectedNonce)) {
    throw reviewError("invalid_direct_review", "Direct review nonce is invalid.", "Request a new Direct review.");
  }
  if (typeof record.session_id !== "string" || typeof record.proposal_sha256 !== "string" || typeof record.session_state_sha256 !== "string" || typeof record.policy_sha256 !== "string" || typeof record.tool_manifest_sha256 !== "string") {
    throw reviewError("invalid_direct_review", "Direct review binding is invalid.", "Request a new Direct review.");
  }
  if (!isOperationType(record.operation_type) || !isReviewMode(record.mode) || !isRiskLevel(record.risk_level) || !isRiskLevel(record.deterministic_risk_level) || !isDecision(record.decision)) {
    throw reviewError("invalid_direct_review", "Direct review decision is invalid.", "Request a new Direct review.");
  }
  if ((record.precondition_sha256 !== null && (typeof record.precondition_sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(record.precondition_sha256)))
    || !Array.isArray(record.reason_codes)
    || record.reason_codes.some((entry) => typeof entry !== "string" || entry.length > 100)
    || !Number.isFinite(Date.parse(String(record.created_at)))
    || !Number.isFinite(Date.parse(String(record.expires_at)))
    || (record.used_at !== null && !Number.isFinite(Date.parse(String(record.used_at))))
    || typeof record.outer_approval_required !== "boolean"
    || record.outer_approval_attested !== false
    || !isExecutionStatus(record.execution_status)) {
    throw reviewError("invalid_direct_review", "Direct review evidence is invalid.", "Request a new Direct review.");
  }
  return record as DirectReviewRecord;
}

function eventFromRecord(record: DirectReviewRecord, status: DirectReviewEvent["status"]): DirectReviewEvent {
  const now = new Date().toISOString();
  return {
    review_id: record.review_id,
    review_record_hmac_sha256: record.integrity_hmac_sha256,
    operation_type: record.operation_type,
    proposal_sha256: record.proposal_sha256,
    mode: record.mode,
    risk_level: record.risk_level,
    decision: record.decision,
    status,
    reviewer_agent: record.reviewer_agent,
    reviewer_status: record.reviewer_status,
    outer_approval_required: record.outer_approval_required,
    reason_codes: record.reason_codes,
    created_at: record.created_at,
    updated_at: now,
  };
}

function syntheticEvent(session: DirectSessionRecord, proposal: DirectReviewProposal, status: DirectReviewEvent["status"], reasonCodes: string[]): DirectReviewEvent {
  const now = new Date().toISOString();
  return {
    review_id: null,
    review_record_hmac_sha256: null,
    operation_type: proposal.operation_type,
    proposal_sha256: proposal.proposal_sha256,
    mode: getConfig().directReview.mode,
    risk_level: "medium",
    decision: "needs_approval",
    status,
    reviewer_agent: null,
    reviewer_status: "not_requested",
    outer_approval_required: false,
    reason_codes: reasonCodes,
    created_at: now,
    updated_at: now,
  };
}

function shadowReasonCodes(proposal: DirectReviewProposal): string[] {
  return proposal.normalized.workspace_snapshot_status === "incomplete"
    ? ["direct_verification_workspace_snapshot_incomplete"]
    : ["direct_review_missing"];
}

function nextAction(record: DirectReviewRecord, mode: "off" | "shadow" | "enforce"): string {
  if (record.decision === "blocked") return "Choose a safer Direct operation; this review cannot be confirmed through MCP.";
  if (mode === "off") return "Direct review is disabled; execute the operation through the normal Direct tool.";
  if (record.outer_approval_required) return "Invoke the matching side-effecting Direct tool with review_id; Codex may require an outer approval before the tool runs.";
  return "Invoke the matching Direct tool with review_id before this review expires.";
}

function computeSessionStateHash(session: DirectSessionRecord): string {
  return createHash("sha256").update(stableJsonStringify({
    session_id: session.session_id,
    created_at: session.created_at,
    expires_at: session.expires_at,
    repo_path: session.repo_path,
    resolved_repo_path: session.resolved_repo_path,
    requester_agent: session.requester_agent,
    expected_changes: session.expected_changes,
    workspace_fingerprint_before: session.workspace_fingerprint_before,
    finalized: session.finalized,
    operations: session.operations.map((entry) => ({
      index: entry.index,
      operation_type: entry.operation_type || null,
      timestamp: entry.timestamp,
      path: entry.path,
      source_path: entry.source_path || null,
      before: entry.before_sha256,
      after: entry.after_sha256,
      operations_applied: entry.operations_applied,
      bytes_changed: entry.bytes_changed,
    })),
    verification_runs: session.verification_runs.map((entry) => ({
      command: entry.command,
      started_at: entry.started_at,
      finished_at: entry.finished_at,
      exit_code: entry.exit_code,
      passed: entry.passed,
      timed_out: entry.timed_out,
    })),
  })).digest("hex");
}

function proposalPreconditionSha256(proposal: DirectReviewProposal): string | null {
  const value = proposal.normalized.expected_sha256 ?? proposal.normalized.expected_source_sha256;
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : null;
}

function generateDirectReviewId(now: Date): string {
  const timestamp = now.toISOString().replace(/[-:]/g, "").replace("T", "_").slice(0, 15);
  return `direct_review_${timestamp}_${randomBytes(16).toString("hex")}`;
}

function signDirectReviewRecord(
  record: Omit<DirectReviewRecord, "integrity_hmac_sha256"> | DirectReviewRecord,
): DirectReviewRecord {
  const payload = directReviewHmacPayload(record);
  return {
    ...payload,
    integrity_hmac_sha256: computeDirectReviewHmac(payload),
  } as DirectReviewRecord;
}

function verifyDirectReviewHmac(record: Partial<DirectReviewRecord>): void {
  const provided = record.integrity_hmac_sha256;
  const expected = Buffer.from(computeDirectReviewHmac(directReviewHmacPayload(record)), "hex");
  const wellFormed = typeof provided === "string" && REVIEW_HMAC_PATTERN.test(provided);
  const candidate = wellFormed ? Buffer.from(provided, "hex") : Buffer.alloc(expected.length);
  const matches = timingSafeEqual(expected, candidate);
  if (!wellFormed || !matches) {
    throw reviewError(
      "invalid_direct_review",
      "Direct review integrity verification failed.",
      "Request a new Direct review; modified or pre-restart tickets cannot be used.",
    );
  }
}

function computeDirectReviewHmac(record: Record<string, unknown>): string {
  return createHmac("sha256", REVIEW_HMAC_KEY)
    .update(stableJsonStringify(record))
    .digest("hex");
}

function directReviewHmacPayload(
  record: Partial<DirectReviewRecord> | Omit<DirectReviewRecord, "integrity_hmac_sha256">,
): Record<string, unknown> {
  const { integrity_hmac_sha256: _ignored, ...payload } = record as Partial<DirectReviewRecord>;
  return payload as Record<string, unknown>;
}

function mutateDirectReviewRecord(
  sessionId: string,
  reviewId: string,
  mutation: (current: DirectReviewRecord) => DirectReviewRecord,
  options: LockedJsonOptions = {},
): DirectReviewRecord {
  const file = guardDirectReviewFile(sessionId, reviewId, false);
  return withFileLockSync(file, () => {
    // Re-check after acquiring the lock so a path replacement between lock
    // acquisition attempts and the actual read cannot redirect evidence I/O.
    const safeReadFile = guardDirectReviewFile(sessionId, reviewId, false);
    const current = readJsonObjectFileSync<DirectReviewRecord>(safeReadFile);
    const next = signDirectReviewRecord(mutation(current));
    const safeWriteFile = guardDirectReviewFile(sessionId, reviewId, false);
    atomicWriteJsonFileSync(safeWriteFile, next);
    return next;
  }, options);
}

function prepareDirectReviewStorage(sessionId: string, reviewId: string): string {
  const sessionDir = getDirectSessionDir(sessionId);
  const sessionReal = guardSafeReviewDirectory(sessionDir, "Direct session");
  const root = getDirectReviewDir(sessionId);
  createReviewDirectory(root);
  const rootReal = guardSafeReviewDirectory(root, "Direct review root");
  assertWithinReviewSession(sessionReal, rootReal);
  const reviewDir = getDirectReviewDir(sessionId, reviewId);
  createReviewDirectory(reviewDir);
  const reviewReal = guardSafeReviewDirectory(reviewDir, "Direct review directory");
  assertWithinReviewSession(sessionReal, reviewReal);
  assertWithinReviewSession(rootReal, reviewReal);
  return reviewDir;
}

function guardDirectReviewFile(sessionId: string, reviewId: string, allowMissingFile: boolean): string {
  const sessionDir = getDirectSessionDir(sessionId);
  const sessionReal = guardSafeReviewDirectory(sessionDir, "Direct session");
  const root = getDirectReviewDir(sessionId);
  const rootReal = guardSafeReviewDirectory(root, "Direct review root");
  assertWithinReviewSession(sessionReal, rootReal);
  const reviewDir = getDirectReviewDir(sessionId, reviewId);
  const reviewReal = guardSafeReviewDirectory(reviewDir, "Direct review directory");
  assertWithinReviewSession(sessionReal, reviewReal);
  assertWithinReviewSession(rootReal, reviewReal);

  const file = getDirectReviewFile(sessionId, reviewId);
  let metadata;
  try {
    metadata = lstatSync(file);
  } catch (error) {
    if (allowMissingFile && errorCode(error) === "ENOENT") return file;
    throw reviewError("direct_review_not_found", `Direct review "${reviewId}" was not found.`, "Request a new review for the exact operation.");
  }
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1) {
    throw unsafeReviewStorage("Direct review file is a link or is not a regular file.");
  }
  const fileReal = realpathSync(file);
  assertWithinReviewSession(sessionReal, fileReal);
  assertWithinReviewSession(reviewReal, fileReal);
  return file;
}

function createReviewDirectory(path: string): void {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
}

function guardSafeReviewDirectory(path: string, label: string): string {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch {
    throw unsafeReviewStorage(`${label} is missing or cannot be inspected.`);
  }
  // Node reports Windows directory junctions as symbolic links here.
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw unsafeReviewStorage(`${label} is a link or is not a directory.`);
  }
  try {
    return realpathSync(path);
  } catch {
    throw unsafeReviewStorage(`${label} cannot be resolved safely.`);
  }
}

function assertWithinReviewSession(parent: string, candidate: string): void {
  const child = relative(parent, candidate);
  if (child === "" || (!child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && child !== ".." && !isAbsolute(child))) return;
  throw unsafeReviewStorage("Direct review storage resolves outside its expected session directory.");
}

function unsafeReviewStorage(message: string): PatchWardenError {
  return reviewError(
    "direct_review_storage_unsafe",
    message,
    "Remove the linked or replaced review storage and request a fresh Direct session.",
  );
}

function errorCode(error: unknown): string | null {
  return error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code || "")
    : null;
}

function getDirectReviewDir(sessionId: string, reviewId?: string): string {
  const root = join(getDirectSessionDir(sessionId), "reviews");
  return reviewId ? join(root, reviewId) : root;
}

function getDirectReviewFile(sessionId: string, reviewId: string): string {
  if (!REVIEW_ID_PATTERN.test(reviewId)) throw reviewError("invalid_direct_review_id", "Direct review ID is invalid.", "Use the review_id returned by request_direct_review.");
  return join(getDirectReviewDir(sessionId, reviewId), "review.json");
}

function blockSensitiveProposedContent(content: string, path: string): void {
  const result = redactSensitiveContent(content);
  if (result.redacted) throw reviewError("sensitive_content_blocked", `Proposed Direct content for "${path}" contains credential-like material.`, "Remove sensitive values and retry with placeholders or environment-variable references.");
}

function assertSha256(value: unknown, field: string): void {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) {
    throw reviewError("direct_review_invalid_operation", `${field} must be a SHA-256 value.`, "Re-read the file and use its current sha256.");
  }
}

function normalizeOptionalWorkspaceSha256(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  assertSha256(value, "workspace_sha256");
  return String(value).toLowerCase();
}

function isWorkspaceSnapshotIncomplete(error: unknown): boolean {
  return error instanceof PatchWardenError
    && error.reason === "direct_review_workspace_snapshot_incomplete";
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw reviewError("direct_review_invalid_operation", `${field} is required.`, "Provide the exact value intended for the Direct operation.");
  return value;
}

function normalizeTimeout(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1 || result > 86_400) throw reviewError("direct_review_invalid_operation", "timeout_seconds is invalid.", "Use a positive bounded timeout in seconds.");
  return result;
}

function isOperationType(value: unknown): value is DirectReviewOperationType {
  return value === "patch" || value === "create" || value === "mkdir" || value === "move" || value === "delete" || value === "verification" || value === "verification_bundle";
}

function isRiskLevel(value: unknown): value is "low" | "medium" | "high" {
  return value === "low" || value === "medium" || value === "high";
}

function isDecision(value: unknown): value is DirectReviewRecord["decision"] {
  return value === "allow" || value === "needs_approval" || value === "blocked";
}

function isReviewMode(value: unknown): value is DirectReviewRecord["mode"] {
  return value === "off" || value === "shadow" || value === "enforce";
}

function isExecutionStatus(value: unknown): value is DirectReviewRecord["execution_status"] {
  return value === "pending" || value === "executed" || value === "failed";
}

function reviewError(reason: string, message: string, suggestion: string): PatchWardenError {
  return new PatchWardenError(reason, message, suggestion, true);
}
