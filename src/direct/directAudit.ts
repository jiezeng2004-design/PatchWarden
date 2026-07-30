import { join, resolve, relative, isAbsolute } from "node:path";
import { isSensitivePath } from "../security/sensitiveGuard.js";
import { PatchWardenError } from "../errors.js";
import {
  readDirectSession,
  getDirectSessionDir,
  updateDirectSession,
  withDirectSessionMutationLock,
  type DirectReviewEvent,
  type DirectSessionRecord,
  type DirectSessionVerificationRun,
} from "./directSessionStore.js";
import type { ChangedFile, ChangeArtifacts } from "../runner/changeCapture.js";
import { atomicWriteFileSync, atomicWriteJsonFileSync } from "../utils/atomicFile.js";
import { redactSensitiveContent } from "../security/contentRedaction.js";
import { getConfig } from "../config.js";
import {
  readDirectReviewAuditReceipt,
  type DirectReviewAuditReceipt,
} from "./directReviewGate.js";

const MAX_AUDIT_REVIEW_EVENTS = 25;
const MAX_REVIEW_REASON_CODES = 20;

// ── Types ──────────────────────────────────────────────────────────

export interface AuditCheck {
  name: string;
  result: "pass" | "warn" | "fail";
  detail: string;
  reason_code?: string;
}

export interface DirectSessionAuditOutput {
  session_id: string;
  expected_changes: boolean;
  decision: "pass" | "warn" | "fail";
  reason_codes: string[];
  blocking_findings: string[];
  warnings: string[];
  evidence: {
    changed_files_total: number;
    verification_runs: DirectSessionVerificationRun[];
    diff_path: string;
    summary_path: string;
    audit_path: string;
    direct_review: DirectReviewEventSummary;
  };
  next_action: string;
}

export interface SafeDirectReviewEvent {
  review_id: string | null;
  operation_type: DirectReviewEvent["operation_type"];
  mode: DirectReviewEvent["mode"];
  risk_level: DirectReviewEvent["risk_level"];
  decision: DirectReviewEvent["decision"];
  status: DirectReviewEvent["status"];
  reviewer_agent: string | null;
  reviewer_status: string;
  outer_approval_required: boolean;
  outer_approval_attested: false;
  reason_codes: string[];
  created_at: string;
  updated_at: string;
}

export interface DirectReviewEventSummary {
  total: number;
  returned: number;
  truncated: boolean;
  invalid_dropped: number;
  counts: Record<DirectReviewEvent["status"], number>;
  outer_approval_required_unattested: number;
  attestation_scope: "external_mcp_client_not_server_verifiable";
  events: SafeDirectReviewEvent[];
}

// ── Main audit function ────────────────────────────────────────────

export function auditDirectSession(sessionId: string): DirectSessionAuditOutput {
  return withDirectSessionMutationLock(sessionId, () => {
  const session = readDirectSession(sessionId);
  const sessionDir = getDirectSessionDir(sessionId);

  const checks: AuditCheck[] = [];
  const reasonCodes: string[] = [];
  const blockingFindings: string[] = [];
  const warnings: string[] = [];

  // Check 1: session finalized
  checks.push({
    name: "session_finalized",
    result: session.finalized ? "pass" : "fail",
    detail: session.finalized
      ? "Session has been finalized."
      : "Session has not been finalized. Call finalize_direct_session first.",
    reason_code: session.finalized ? undefined : "session_not_finalized",
  });

  // Get change artifacts if available
  const artifacts = session.change_artifacts;

  // Check 2: diff empty
  const changedFilesTotal = artifacts?.changed_files?.length ?? 0;
  const expectsChanges = session.expected_changes !== false;
  checks.push({
    name: "diff_empty",
    result: changedFilesTotal === 0 && expectsChanges ? "warn" : "pass",
    detail:
      changedFilesTotal === 0
        ? expectsChanges
          ? "No file changes detected in this session."
          : "No file changes were expected for this read-only or verification-only session."
        : `${changedFilesTotal} file(s) changed.`,
    reason_code: changedFilesTotal === 0 && expectsChanges ? "empty_diff" : undefined,
  });

  if (artifacts) {
    // Check 3: out-of-scope changes
    const outOfScope = findOutOfScopeChanges(artifacts, session.resolved_repo_path);
    checks.push({
      name: "out_of_scope_changes",
      result: outOfScope.length === 0 ? "pass" : "fail",
      detail:
        outOfScope.length === 0
          ? "All changes are within the session repo_path."
          : `${outOfScope.length} file(s) modified outside session repo_path: ${outOfScope.join(", ")}`,
      reason_code: outOfScope.length > 0 ? "out_of_scope_changes" : undefined,
    });

    // Check 4: sensitive files
    const sensitiveFiles = findSensitiveChanges(artifacts);
    checks.push({
      name: "sensitive_file_access",
      result: sensitiveFiles.length === 0 ? "pass" : "fail",
      detail:
        sensitiveFiles.length === 0
          ? "No sensitive files modified."
          : `Sensitive files modified: ${sensitiveFiles.join(", ")}`,
      reason_code: sensitiveFiles.length > 0 ? "sensitive_file_modified" : undefined,
    });

    checks.push({
      name: "sensitive_content",
      result: artifacts.diff_redacted ? "fail" : "pass",
      detail: artifacts.diff_redacted
        ? `Credential-like content was redacted from diff evidence (${(artifacts.diff_redaction_categories ?? []).join(", ") || "sensitive_content"}).`
        : "No credential-like content was detected in diff evidence.",
      reason_code: artifacts.diff_redacted ? "sensitive_content_detected" : undefined,
    });

    // Check 5: node_modules modification
    const nodeModulesChanges = findPathChanges(artifacts, "node_modules");
    checks.push({
      name: "node_modules_modified",
      result: nodeModulesChanges.length === 0 ? "pass" : "fail",
      detail:
        nodeModulesChanges.length === 0
          ? "No node_modules modifications."
          : `node_modules modified: ${nodeModulesChanges.join(", ")}`,
      reason_code: nodeModulesChanges.length > 0 ? "node_modules_modified" : undefined,
    });

    // Check 6: release/dist modification
    const artifactDirEntries = artifacts.changed_files.filter((file) =>
      isPathInsideDirectory(file.path, "release") || isPathInsideDirectory(file.path, "dist")
    );
    const artifactDirChanges = artifactDirEntries.map((file) => file.path);
    const manualArtifactDirChanges = artifactDirEntries.filter((file) => file.kind !== "build_artifact");
    const reviewArtifactDirChanges = artifactDirEntries.filter((file) => file.kind === "build_artifact" && !file.ignored);
    checks.push({
      name: "release_dist_modified",
      result: artifactDirChanges.length === 0
        ? "pass"
        : manualArtifactDirChanges.length > 0
        ? "fail"
        : reviewArtifactDirChanges.length > 0
        ? "warn"
        : "pass",
      detail:
        artifactDirChanges.length === 0
          ? "No release/dist modifications."
          : manualArtifactDirChanges.length > 0
          ? `release/dist contains non-generated changes: ${manualArtifactDirChanges.map((file) => file.path).join(", ")}`
          : reviewArtifactDirChanges.length > 0
          ? `release/dist generated changes are tracked or not ignored: ${reviewArtifactDirChanges.map((file) => file.path).join(", ")}`
          : `${artifactDirChanges.length} ignored release/dist generated change(s) retained as build evidence.`,
      reason_code: artifactDirChanges.length > 0
        ? manualArtifactDirChanges.length > 0
          ? "release_dist_manually_modified"
          : reviewArtifactDirChanges.length > 0
          ? "build_artifact_modified"
          : undefined
        : undefined,
    });

    // Check 7: file deletion
    const deletedFiles = artifacts.changed_files.filter((f) => f.change === "deleted");
    const authorizedDeletedPaths = new Set(session.operations.filter((operation) => operation.operation_type === "delete").map((operation) => operation.path));
    const authorizedDeletedFiles = deletedFiles.filter((file) => authorizedDeletedPaths.has(file.path));
    const blockingDeletedFiles = deletedFiles.filter((f) => (f.kind === "source" || f.kind === "dependency") && !authorizedDeletedPaths.has(f.path));
    const reviewDeletedFiles = deletedFiles.filter((f) =>
      (f.kind === "build_artifact" || f.kind === "runtime_generated") && !f.ignored
    );
    checks.push({
      name: "file_deletion",
      result: blockingDeletedFiles.length > 0 ? "fail" : reviewDeletedFiles.length > 0 || authorizedDeletedFiles.length > 0 ? "warn" : "pass",
      detail:
        deletedFiles.length === 0
          ? "No files deleted."
          : blockingDeletedFiles.length > 0
          ? `Source or dependency files deleted: ${blockingDeletedFiles.map((f) => f.path).join(", ")}`
          : authorizedDeletedFiles.length > 0
          ? `Explicitly confirmed Direct deletions require review: ${authorizedDeletedFiles.map((f) => f.path).join(", ")}`
          : reviewDeletedFiles.length > 0
          ? `Generated files deleted but are tracked or not ignored: ${reviewDeletedFiles.map((f) => f.path).join(", ")}`
          : `${deletedFiles.length} ignored generated file(s) deleted; retained as build evidence only.`,
      reason_code: blockingDeletedFiles.length > 0
        ? "file_deleted"
        : authorizedDeletedFiles.length > 0
        ? "confirmed_file_deleted"
        : reviewDeletedFiles.length > 0
        ? "generated_file_deleted"
        : undefined,
    });

    // Check 8: file rename
    const renamedFiles = artifacts.changed_files.filter((f) => f.change === "renamed");
    const authorizedMoves = session.operations.filter((operation) => operation.operation_type === "move");
    const isAuthorizedMove = (file: ChangedFile) => authorizedMoves.some((operation) => operation.path === file.path && operation.source_path === file.old_path);
    const authorizedRenamedFiles = renamedFiles.filter(isAuthorizedMove);
    const blockingRenamedFiles = renamedFiles.filter((f) => (f.kind === "source" || f.kind === "dependency") && !isAuthorizedMove(f));
    const reviewRenamedFiles = renamedFiles.filter((f) =>
      (f.kind === "build_artifact" || f.kind === "runtime_generated") && !f.ignored
    );
    checks.push({
      name: "file_rename",
      result: blockingRenamedFiles.length > 0 ? "fail" : reviewRenamedFiles.length > 0 || authorizedRenamedFiles.length > 0 ? "warn" : "pass",
      detail:
        renamedFiles.length === 0
          ? "No files renamed."
          : blockingRenamedFiles.length > 0
          ? `Source or dependency files renamed: ${blockingRenamedFiles.map((f) => `${f.old_path} -> ${f.path}`).join(", ")}`
          : authorizedRenamedFiles.length > 0
          ? `Explicit Direct moves recorded: ${authorizedRenamedFiles.map((f) => `${f.old_path} -> ${f.path}`).join(", ")}`
          : reviewRenamedFiles.length > 0
          ? `Generated files renamed but are tracked or not ignored: ${reviewRenamedFiles.map((f) => `${f.old_path} -> ${f.path}`).join(", ")}`
          : `${renamedFiles.length} ignored generated file(s) renamed; retained as build evidence only.`,
      reason_code: blockingRenamedFiles.length > 0
        ? "file_renamed"
        : authorizedRenamedFiles.length > 0
        ? "direct_file_moved"
        : reviewRenamedFiles.length > 0
        ? "generated_file_renamed"
        : undefined,
    });

    // Check 9: package-lock / dependency changes
    const packageLockChanges = artifacts.changed_files.filter(
      (f) =>
        f.path === "package-lock.json" ||
        f.path === "package.json" ||
        f.path === "yarn.lock" ||
        f.path === "pnpm-lock.yaml"
    );
    checks.push({
      name: "dependency_changes",
      result: packageLockChanges.length === 0 ? "pass" : "warn",
      detail:
        packageLockChanges.length === 0
          ? "No dependency file changes."
          : `Dependency files changed: ${packageLockChanges.map((f) => f.path).join(", ")}`,
      reason_code: packageLockChanges.length > 0 ? "dependency_file_changed" : undefined,
    });

    // Check 13: title vs changed files consistency (warning only)
    if (session.title && changedFilesTotal > 0) {
      checks.push({
        name: "title_change_consistency",
        result: "pass",
        detail: `Session title: "${session.title}", ${changedFilesTotal} file(s) changed. (Semantic check not performed - deterministic audit only.)`,
        reason_code: undefined,
      });
    } else {
      checks.push({
        name: "title_change_consistency",
        result: "pass",
        detail: "No title provided or no changes to compare.",
      });
    }

    // Check 14: suspicious changes
    const suspiciousCount = artifacts.artifact_hygiene.counts.unexpected_changes
      ?? artifacts.artifact_hygiene.counts.suspicious_changes;
    checks.push({
      name: "suspicious_changes",
      result: suspiciousCount === 0 ? "pass" : "warn",
      detail:
        suspiciousCount === 0
          ? "No suspicious changes detected."
          : `${suspiciousCount} suspicious change(s) detected.`,
      reason_code: suspiciousCount > 0 ? "suspicious_changes" : undefined,
    });

    // Check 15: runtime generated files
    const runtimeCount = artifacts.artifact_hygiene.counts.runtime_generated_files;
    checks.push({
      name: "runtime_generated_files",
      result: runtimeCount === 0 ? "pass" : "warn",
      detail:
        runtimeCount === 0
          ? "No runtime-generated files detected."
          : `${runtimeCount} runtime-generated file(s) detected.`,
      reason_code: runtimeCount > 0 ? "runtime_generated_files" : undefined,
    });

    // Check 16: tracked build artifacts
    const buildArtifactCount = artifacts.artifact_hygiene.counts.tracked_build_artifacts;
    checks.push({
      name: "tracked_build_artifacts",
      result: buildArtifactCount === 0 ? "pass" : "warn",
      detail:
        buildArtifactCount === 0
          ? "No tracked build artifacts detected."
          : `${buildArtifactCount} tracked build artifact(s) detected.`,
      reason_code: buildArtifactCount > 0 ? "tracked_build_artifacts" : undefined,
    });
  }

  // Check 10: at least one verification command run
  const verificationRuns = session.verification_runs || [];
  const hasVerification = verificationRuns.length > 0;
  const hasVerificationRequiredChanges = artifacts
    ? artifacts.changed_files.some((f) => f.kind === "source" || f.kind === "dependency")
    : false;

  checks.push({
    name: "verification_run",
    result: hasVerification
      ? "pass"
      : hasVerificationRequiredChanges
      ? "fail"
      : "warn",
    detail: hasVerification
      ? `${verificationRuns.length} verification command(s) run.`
      : hasVerificationRequiredChanges
          ? "Source or dependency files were modified but no verification commands were run."
          : "No source or dependency changes require verification.",
    reason_code: !hasVerification
      ? hasVerificationRequiredChanges
        ? "source_changes_without_verification"
        : "no_verification_run"
      : undefined,
  });

  // Check 11: verification commands passed
  if (hasVerification) {
    const allPassed = verificationRuns.every((r) => r.passed);
    checks.push({
      name: "verification_passed",
      result: allPassed ? "pass" : "fail",
      detail: allPassed
        ? "All verification commands passed."
        : `${verificationRuns.filter((r) => !r.passed).length} verification command(s) failed.`,
      reason_code: !allPassed ? "verification_failed" : undefined,
    });
  }
  const directReview = summarizeDirectReviewEvents(session.review_events || [], MAX_AUDIT_REVIEW_EVENTS);
  const missingRequiredReviews = countMissingRequiredReviews(session);
  checks.push({
    name: "direct_review_required_gate",
    result: missingRequiredReviews > 0 ? "fail" : "pass",
    detail: missingRequiredReviews > 0
      ? `${missingRequiredReviews} enforce-mode Direct operation group(s) lack executed review evidence.`
      : "All enforce-mode Direct operations have matching execution review evidence.",
    reason_code: missingRequiredReviews > 0 ? "direct_review_gate_missing" : undefined,
  });
  const receiptIntegrity = assessDirectReviewReceiptIntegrity(session);
  checks.push({
    name: "direct_review_receipt_integrity",
    result: receiptIntegrity.invalid === 0 ? "pass" : receiptIntegrity.enforce_required ? "fail" : "warn",
    detail: receiptIntegrity.invalid === 0
      ? "Recorded Direct review receipts match their audit events."
      : `${receiptIntegrity.invalid} Direct review event(s) do not match an authenticated receipt.`,
    reason_code: receiptIntegrity.invalid === 0
      ? undefined
      : receiptIntegrity.enforce_required ? "direct_review_receipt_invalid" : "direct_review_receipt_unverified",
  });
  const incompleteReviews = directReview.counts.requested + directReview.counts.authorized;
  checks.push({
    name: "direct_review_completion",
    result: incompleteReviews > 0 ? "warn" : "pass",
    detail: incompleteReviews > 0
      ? `${incompleteReviews} Direct review(s) remain requested or authorized without a terminal operation result.`
      : "All recorded Direct reviews have terminal state.",
    reason_code: incompleteReviews > 0 ? "direct_review_incomplete" : undefined,
  });
  checks.push({
    name: "direct_review_execution",
    result: directReview.counts.blocked > 0 || directReview.counts.failed > 0 ? "fail" : directReview.counts.would_block > 0 ? "warn" : "pass",
    detail: directReview.counts.blocked > 0 || directReview.counts.failed > 0
      ? "A Direct review blocked or a reviewed operation failed."
      : directReview.counts.would_block > 0
      ? "Shadow-mode Direct review recorded operation(s) that enforce mode would block."
      : "No Direct review blocked or failed an operation.",
    reason_code: directReview.counts.blocked > 0 ? "direct_review_blocked"
      : directReview.counts.failed > 0 ? "direct_review_execution_failed"
      : directReview.counts.would_block > 0 ? "direct_review_shadow_would_block"
      : undefined,
  });

  // Collect results
  for (const check of checks) {
    if (check.reason_code) reasonCodes.push(check.reason_code);
    if (check.result === "fail") blockingFindings.push(`${check.name}: ${check.detail}`);
    if (check.result === "warn") warnings.push(`${check.name}: ${check.detail}`);
  }

  // Determine decision
  const hasFail = checks.some((c) => c.result === "fail");
  const hasWarn = checks.some((c) => c.result === "warn");
  const decision: "pass" | "warn" | "fail" = hasFail ? "fail" : hasWarn ? "warn" : "pass";

  const diffPath = join(sessionDir, "diff.patch");
  const summaryPath = join(sessionDir, "summary.md");
  const auditPath = join(sessionDir, "audit.md");

  const output: DirectSessionAuditOutput = {
    session_id: sessionId,
    expected_changes: expectsChanges,
    decision,
    reason_codes: reasonCodes,
    blocking_findings: blockingFindings,
    warnings,
    evidence: {
      changed_files_total: changedFilesTotal,
      verification_runs: verificationRuns,
      diff_path: diffPath,
      summary_path: summaryPath,
      audit_path: auditPath,
      direct_review: directReview,
    },
    next_action: decision === "pass"
      ? "Audit passed. Changes are safe to accept."
      : decision === "warn"
      ? "Audit completed with warnings. Review the warnings before accepting changes."
      : "Audit failed. Review the blocking findings and create a new session to fix issues.",
  };

  // Write audit.json and audit.md
  atomicWriteJsonFileSync(join(sessionDir, "audit.json"), output);
  atomicWriteFileSync(auditPath, formatAuditMd(output, checks, session));
  updateDirectSession(sessionId, { audited: true });

  return output;
  });
}

// ── Helper functions ───────────────────────────────────────────────

function findOutOfScopeChanges(
  artifacts: ChangeArtifacts,
  resolvedRepoPath: string
): string[] {
  const normalizedRepo = resolve(resolvedRepoPath);
  return artifacts.changed_files
    .filter((f) => {
      const fullPath = resolve(normalizedRepo, f.path);
      const rel = relative(normalizedRepo, fullPath);
      return isAbsolute(rel) || rel.startsWith("..");
    })
    .map((f) => f.path);
}

function findSensitiveChanges(artifacts: ChangeArtifacts): string[] {
  return artifacts.changed_files
    .filter((f) => isSensitivePath(f.path))
    .map((f) => f.path);
}

function findPathChanges(artifacts: ChangeArtifacts, dirName: string): string[] {
  return artifacts.changed_files
    .filter((f) => {
      const normalized = f.path.replace(/\\/g, "/");
      return normalized.startsWith(`${dirName}/`) || normalized.includes(`/${dirName}/`);
    })
    .map((f) => f.path);
}

export function summarizeDirectReviewEvents(
  events: unknown[],
  maxItems = MAX_AUDIT_REVIEW_EVENTS,
): DirectReviewEventSummary {
  const limit = Number.isFinite(maxItems) ? Math.max(1, Math.min(50, Math.floor(maxItems))) : MAX_AUDIT_REVIEW_EVENTS;
  const validEvents = events.filter(isDirectReviewEvent);
  const counts: DirectReviewEventSummary["counts"] = {
    requested: 0, authorized: 0, would_block: 0, blocked: 0, executed: 0, failed: 0,
  };
  for (const event of validEvents) counts[event.status] += 1;
  const selected = validEvents.slice(-limit);
  return {
    total: events.length,
    returned: selected.length,
    truncated: validEvents.length > selected.length,
    invalid_dropped: events.length - validEvents.length,
    counts,
    outer_approval_required_unattested: validEvents.filter((event) => event.outer_approval_required).length,
    attestation_scope: "external_mcp_client_not_server_verifiable",
    events: selected.map((event) => ({
      review_id: event.review_id ? boundedRedacted(event.review_id, 96) : null,
      operation_type: event.operation_type,
      mode: event.mode,
      risk_level: event.risk_level,
      decision: event.decision,
      status: event.status,
      reviewer_agent: event.reviewer_agent ? boundedRedacted(event.reviewer_agent, 100) : null,
      reviewer_status: boundedRedacted(event.reviewer_status, 100),
      outer_approval_required: Boolean(event.outer_approval_required),
      outer_approval_attested: false,
      reason_codes: event.reason_codes.slice(0, MAX_REVIEW_REASON_CODES).map((reason) => boundedRedacted(reason, 100)).filter(Boolean),
      created_at: boundedRedacted(event.created_at, 40),
      updated_at: boundedRedacted(event.updated_at, 40),
    })),
  };
}

function isDirectReviewEvent(value: unknown): value is DirectReviewEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Partial<DirectReviewEvent>;
  return (event.review_id === null || typeof event.review_id === "string")
    && (event.review_record_hmac_sha256 === undefined || event.review_record_hmac_sha256 === null || /^[a-f0-9]{64}$/i.test(event.review_record_hmac_sha256))
    && isOneOf(event.operation_type, ["patch", "create", "mkdir", "move", "delete", "verification", "verification_bundle"])
    && typeof event.proposal_sha256 === "string"
    && isOneOf(event.mode, ["off", "shadow", "enforce"])
    && isOneOf(event.risk_level, ["low", "medium", "high"])
    && isOneOf(event.decision, ["allow", "needs_approval", "blocked"])
    && isOneOf(event.status, ["requested", "authorized", "would_block", "blocked", "executed", "failed"])
    && (event.reviewer_agent === null || typeof event.reviewer_agent === "string")
    && typeof event.reviewer_status === "string"
    && typeof event.outer_approval_required === "boolean"
    && Array.isArray(event.reason_codes)
    && event.reason_codes.every((reason) => typeof reason === "string")
    && typeof event.created_at === "string"
    && typeof event.updated_at === "string";
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && allowed.includes(value as T);
}

function boundedRedacted(value: string, maxLength: number): string {
  return redactSensitiveContent(String(value)).content.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, maxLength);
}

function assessDirectReviewReceiptIntegrity(session: DirectSessionRecord): {
  invalid: number;
  enforce_required: boolean;
} {
  const events = (session.review_events || []).filter(isDirectReviewEvent);
  const enforceRequired = getConfig().directReview.mode === "enforce" || events.some((event) => event.mode === "enforce");
  let invalid = 0;
  for (const event of events) {
    if (event.review_id === null) {
      if (event.mode === "enforce") invalid += 1;
      continue;
    }
    const receipt = readDirectReviewAuditReceipt(session.session_id, event.review_id);
    if (!receipt
      || event.review_record_hmac_sha256 !== receipt.integrity_hmac_sha256
      || receipt.session_id !== session.session_id
      || receipt.operation_type !== event.operation_type
      || receipt.proposal_sha256 !== event.proposal_sha256
      || receipt.mode !== event.mode
      || receipt.decision !== event.decision
      || receipt.reviewer_agent !== event.reviewer_agent
      || receipt.reviewer_status !== event.reviewer_status
      || !sameStringArray(receipt.reason_codes, event.reason_codes)
      || !receiptMatchesEventStatus(receipt, event.status)) invalid += 1;
  }
  return { invalid, enforce_required: enforceRequired };
}

function receiptMatchesEventStatus(receipt: DirectReviewAuditReceipt, status: DirectReviewEvent["status"]): boolean {
  if (status === "requested") return receipt.used_at === null && receipt.execution_status === "pending";
  if (status === "authorized") return receipt.used_at !== null && receipt.execution_status === "pending";
  if (status === "executed") return receipt.used_at !== null && receipt.execution_status === "executed";
  if (status === "failed") return receipt.used_at !== null && receipt.execution_status === "failed";
  if (status === "blocked") return receipt.decision === "blocked" && receipt.used_at === null && receipt.execution_status === "pending";
  return receipt.execution_status === "pending";
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function countMissingRequiredReviews(session: DirectSessionRecord): number {
  const events = (session.review_events || []).filter(isDirectReviewEvent);
  const enforceRequired = getConfig().directReview.mode === "enforce" || events.some((event) => event.mode === "enforce");
  if (!enforceRequired) return 0;
  let missing = 0;
  for (const operationType of ["patch", "create", "mkdir", "move", "delete"] as const) {
    const executed = session.operations.filter((operation) => operation.operation_type === operationType).length;
    const reviewed = events.filter((event) => event.mode === "enforce" && event.operation_type === operationType && event.status === "executed").length;
    missing += Math.max(0, executed - reviewed);
  }
  if (session.verification_runs.length > 0 && !events.some((event) =>
    event.mode === "enforce"
    && (event.operation_type === "verification" || event.operation_type === "verification_bundle")
    && event.status === "executed"
  )) missing += 1;
  return missing;
}

function isPathInsideDirectory(path: string, dirName: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return normalized.startsWith(`${dirName}/`) || normalized.includes(`/${dirName}/`);
}

function formatAuditMd(
  output: DirectSessionAuditOutput,
  checks: AuditCheck[],
  session: DirectSessionRecord
): string {
  const lines: string[] = [
    "# Direct Session Audit Report",
    "",
    `**Session ID:** ${output.session_id}`,
    `**Expected changes:** ${output.expected_changes ? "yes" : "no"}`,
    `**Decision:** ${output.decision.toUpperCase()}`,
    `**Changed files:** ${output.evidence.changed_files_total}`,
    "",
    "## Checks",
    "",
    "| Check | Result | Detail |",
    "|---|---|---|",
  ];

  for (const check of checks) {
    const emoji = check.result === "pass" ? "PASS" : check.result === "warn" ? "WARN" : "FAIL";
    lines.push(`| ${check.name} | ${emoji} | ${check.detail.replace(/\|/g, "\\|")} |`);
  }

  if (output.blocking_findings.length > 0) {
    lines.push("", "## Blocking Findings", "");
    for (const finding of output.blocking_findings) {
      lines.push(`- ${finding}`);
    }
  }

  if (output.warnings.length > 0) {
    lines.push("", "## Warnings", "");
    for (const warning of output.warnings) {
      lines.push(`- ${warning}`);
    }
  }

  lines.push("", "## Evidence", "");
  lines.push(`- Diff: \`${output.evidence.diff_path}\``);
  lines.push(`- Summary: \`${output.evidence.summary_path}\``);
  lines.push(`- Verification runs: ${output.evidence.verification_runs.length}`);
  lines.push(`- Direct review events: ${output.evidence.direct_review.total}`);
  lines.push(`- Invalid Direct review events excluded: ${output.evidence.direct_review.invalid_dropped}`);
  lines.push(`- Shadow would-block events: ${output.evidence.direct_review.counts.would_block}`);
  lines.push(`- Blocked review events: ${output.evidence.direct_review.counts.blocked}`);
  lines.push(`- Failed reviewed executions: ${output.evidence.direct_review.counts.failed}`);
  lines.push(`- Outer approvals required but not server-attested: ${output.evidence.direct_review.outer_approval_required_unattested}`);

  if (output.evidence.verification_runs.length > 0) {
    lines.push("", "### Verification Results", "");
    for (const run of output.evidence.verification_runs) {
      lines.push(`- **${run.command}**: ${run.passed ? "PASSED" : "FAILED"} (exit code: ${run.exit_code})`);
    }
  }

  lines.push("", `**Next action:** ${output.next_action}`);

  return lines.join("\n");
}
