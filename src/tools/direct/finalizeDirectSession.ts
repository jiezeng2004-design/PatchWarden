import { join, resolve, relative, isAbsolute } from "node:path";
import {
  readDirectSession,
  finalizeDirectSessionRecord,
  getDirectSessionDir,
  withDirectSessionMutationLockAsync,
} from "../../direct/directSessionStore.js";
import { guardDirectSessionActive } from "../../direct/directGuards.js";
import {
  captureRepoSnapshot,
  buildChangeArtifacts,
  type ChangeArtifacts,
  type ClassifiedChange,
  type ChangedFile,
} from "../../runner/changeCapture.js";

// ── Types ──────────────────────────────────────────────────────────

export interface FinalizeDirectSessionInput {
  session_id: string;
}

export interface FinalizeDirectSessionOutput {
  session_id: string;
  changed_files_total: number;
  source_changes: ClassifiedChange[];
  tracked_build_artifacts: ClassifiedChange[];
  runtime_generated_files: ClassifiedChange[];
  suspicious_changes: ClassifiedChange[];
  out_of_scope_changes: ClassifiedChange[];
  verification_summary: Record<string, "passed" | "failed">;
  diff_path: string;
  summary_path: string;
  finalized: boolean;
  next_action: string;
}

// ── Main function ──────────────────────────────────────────────────

export async function finalizeDirectSession(
  input: FinalizeDirectSessionInput
): Promise<FinalizeDirectSessionOutput> {
  const { session_id } = input;
  return withDirectSessionMutationLockAsync(session_id, async () => {

  // 1. Read session and guard active (not expired, not finalized)
  const session = readDirectSession(session_id);
  guardDirectSessionActive(session);

  // 2. Capture after snapshot
  const afterSnapshot = await captureRepoSnapshot(session.resolved_repo_path);

  // 3. Build change artifacts from before/after snapshots
  const changeArtifacts = await buildChangeArtifacts(
    session.resolved_repo_path,
    session.workspace_snapshot_before,
    afterSnapshot
  );

  // 4. Finalize session record — writes changed-files.json, diff.patch,
  //    summary.json, summary.md and marks the session as finalized.
  finalizeDirectSessionRecord(session_id, changeArtifacts);

  // 5. Build verification summary from session.verification_runs
  const verification_summary: Record<string, "passed" | "failed"> = {};
  for (const run of session.verification_runs) {
    verification_summary[run.command] = run.passed ? "passed" : "failed";
  }

  // 6. Identify out-of-scope changes (paths outside resolved_repo_path)
  const out_of_scope_changes = findOutOfScopeChanges(
    changeArtifacts,
    session.resolved_repo_path
  );

  // 7. Build compact summary with categorized changes
  const sessionDir = getDirectSessionDir(session_id);

  return {
    session_id,
    changed_files_total: changeArtifacts.changed_files.length,
    source_changes: changeArtifacts.artifact_hygiene.source_changes,
    tracked_build_artifacts:
      changeArtifacts.artifact_hygiene.tracked_build_artifacts,
    runtime_generated_files:
      changeArtifacts.artifact_hygiene.runtime_generated_files,
    suspicious_changes: changeArtifacts.artifact_hygiene.suspicious_changes,
    out_of_scope_changes,
    verification_summary,
    diff_path: join(sessionDir, "diff.patch"),
    summary_path: join(sessionDir, "summary.md"),
    finalized: true,
    next_action: "Call audit_session to independently review the changes.",
  };
  });
}

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Filter changeArtifacts.changed_files for paths that resolve outside the
 * session's resolved_repo_path and map them to ClassifiedChange format.
 */
function findOutOfScopeChanges(
  artifacts: ChangeArtifacts,
  resolvedRepoPath: string
): ClassifiedChange[] {
  const normalizedRepo = resolve(resolvedRepoPath);
  return artifacts.changed_files
    .filter((file) => {
      const fullPath = resolve(normalizedRepo, file.path);
      const rel = relative(normalizedRepo, fullPath);
      return isAbsolute(rel) || rel.startsWith("..");
    })
    .map((file) => toClassifiedChange(file));
}

/**
 * Map a ChangedFile to the ClassifiedChange format by adding a reason string.
 */
function toClassifiedChange(file: ChangedFile): ClassifiedChange {
  return {
    path: file.path,
    change: file.change,
    tracked: file.tracked,
    ignored: file.ignored,
    kind: file.kind,
    reason: classificationReason(file),
  };
}

/**
 * Produce a human-readable reason for a changed file classification.
 * Mirrors the logic in changeCapture.ts classifyArtifactHygiene.
 */
function classificationReason(change: ChangedFile): string {
  if (change.ignored)
    return "untracked path is ignored by repository Git rules";
  if (change.kind === "build_artifact" && change.tracked)
    return "artifact-like path is tracked by Git and requires review";
  if (change.kind === "build_artifact")
    return "artifact-like path is not ignored and requires review";
  if (change.kind === "runtime_generated")
    return "runtime-generated path is not ignored and requires review";
  return change.tracked ? "tracked source change" : "untracked source change";
}
