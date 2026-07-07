import { writeFileSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { getConfig } from "../config.js";
import { isSensitivePath } from "../security/sensitiveGuard.js";
import { PatchWardenError } from "../errors.js";
import {
  readDirectSession,
  getDirectSessionDir,
  type DirectSessionRecord,
  type DirectSessionVerificationRun,
} from "./directSessionStore.js";
import type { ChangedFile, ChangeArtifacts } from "../runner/changeCapture.js";

// ── Types ──────────────────────────────────────────────────────────

export interface AuditCheck {
  name: string;
  result: "pass" | "warn" | "fail";
  detail: string;
  reason_code?: string;
}

export interface DirectSessionAuditOutput {
  session_id: string;
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
  };
  next_action: string;
}

// ── Main audit function ────────────────────────────────────────────

export function auditDirectSession(sessionId: string): DirectSessionAuditOutput {
  const config = getConfig();
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
  checks.push({
    name: "diff_empty",
    result: changedFilesTotal === 0 ? "warn" : "pass",
    detail:
      changedFilesTotal === 0
        ? "No file changes detected in this session."
        : `${changedFilesTotal} file(s) changed.`,
    reason_code: changedFilesTotal === 0 ? "empty_diff" : undefined,
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
    const releaseChanges = findPathChanges(artifacts, "release");
    const distChanges = findPathChanges(artifacts, "dist");
    const artifactDirChanges = [...releaseChanges, ...distChanges];
    const hasBuildArtifacts = artifacts.artifact_hygiene.counts.tracked_build_artifacts > 0;
    checks.push({
      name: "release_dist_modified",
      result: artifactDirChanges.length === 0
        ? "pass"
        : hasBuildArtifacts
        ? "warn"
        : "fail",
      detail:
        artifactDirChanges.length === 0
          ? "No release/dist modifications."
          : `release/dist modified: ${artifactDirChanges.join(", ")}${hasBuildArtifacts ? " (build-generated)" : " (not build-generated)"}`,
      reason_code: artifactDirChanges.length > 0
        ? hasBuildArtifacts
          ? "build_artifact_modified"
          : "release_dist_manually_modified"
        : undefined,
    });

    // Check 7: file deletion
    const deletedFiles = artifacts.changed_files.filter((f) => f.change === "deleted");
    checks.push({
      name: "file_deletion",
      result: deletedFiles.length === 0 ? "pass" : "fail",
      detail:
        deletedFiles.length === 0
          ? "No files deleted."
          : `Files deleted: ${deletedFiles.map((f) => f.path).join(", ")}`,
      reason_code: deletedFiles.length > 0 ? "file_deleted" : undefined,
    });

    // Check 8: file rename
    const renamedFiles = artifacts.changed_files.filter((f) => f.change === "renamed");
    checks.push({
      name: "file_rename",
      result: renamedFiles.length === 0 ? "pass" : "fail",
      detail:
        renamedFiles.length === 0
          ? "No files renamed."
          : `Files renamed: ${renamedFiles.map((f) => `${f.old_path} → ${f.path}`).join(", ")}`,
      reason_code: renamedFiles.length > 0 ? "file_renamed" : undefined,
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
    const suspiciousCount = artifacts.artifact_hygiene.counts.suspicious_changes;
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
  const hasSourceChanges = artifacts
    ? artifacts.changed_files.some((f) => f.kind === "source")
    : false;

  checks.push({
    name: "verification_run",
    result: hasVerification
      ? "pass"
      : hasSourceChanges
      ? "fail"
      : "warn",
    detail: hasVerification
      ? `${verificationRuns.length} verification command(s) run.`
      : hasSourceChanges
      ? "Source files were modified but no verification commands were run."
      : "No verification commands were run (no source changes detected).",
    reason_code: !hasVerification
      ? hasSourceChanges
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
    },
    next_action: decision === "pass"
      ? "Audit passed. Changes are safe to accept."
      : decision === "warn"
      ? "Audit completed with warnings. Review the warnings before accepting changes."
      : "Audit failed. Review the blocking findings and create a new session to fix issues.",
  };

  // Write audit.json and audit.md
  writeFileSync(
    join(sessionDir, "audit.json"),
    JSON.stringify(output, null, 2),
    "utf-8"
  );
  writeFileSync(auditPath, formatAuditMd(output, checks, session), "utf-8");

  return output;
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

function formatAuditMd(
  output: DirectSessionAuditOutput,
  checks: AuditCheck[],
  session: DirectSessionRecord
): string {
  const lines: string[] = [
    "# Direct Session Audit Report",
    "",
    `**Session ID:** ${output.session_id}`,
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

  if (output.evidence.verification_runs.length > 0) {
    lines.push("", "### Verification Results", "");
    for (const run of output.evidence.verification_runs) {
      lines.push(`- **${run.command}**: ${run.passed ? "PASSED" : "FAILED"} (exit code: ${run.exit_code})`);
    }
  }

  lines.push("", `**Next action:** ${output.next_action}`);

  return lines.join("\n");
}
