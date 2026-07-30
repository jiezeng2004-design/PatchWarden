import { getConfig } from "../../config.js";
import { PatchWardenError } from "../../errors.js";
import {
  readDirectSession,
  appendDirectSessionOperation,
  withDirectSessionMutationLock,
} from "../../direct/directSessionStore.js";
import {
  guardDirectSessionActive,
  guardDirectWritePath,
  guardDirectPatchSize,
} from "../../direct/directGuards.js";
import {
  applyPatchOperations,
  computeFileSha256,
  type PatchOperation,
} from "../../direct/directPatch.js";
import {
  authorizeDirectOperation,
  buildDirectReviewProposal,
  completeDirectReview,
  validateDirectReviewProposal,
} from "../../direct/directReviewGate.js";

export interface ApplyPatchInput {
  session_id: string;
  path: string;
  expected_sha256: string;
  operations: PatchOperation[];
  review_id?: string;
}

export interface ApplyPatchOutput {
  path: string;
  before_sha256: string;
  after_sha256: string;
  operations_applied: number;
  bytes_changed: number;
  next_action: string;
}

export function applyPatch(input: ApplyPatchInput): ApplyPatchOutput {
  const config = getConfig();
  return withDirectSessionMutationLock(input.session_id, () => {

  // 1. Read session and guard active (not expired, not finalized)
  const session = readDirectSession(input.session_id);
  guardDirectSessionActive(session);
  const proposal = buildDirectReviewProposal(session, {
    operation_type: "patch",
    path: input.path,
    expected_sha256: input.expected_sha256,
    operations: input.operations,
  });
  validateDirectReviewProposal(session, proposal, config);

  // 2. Guard write path (inside repo, not sensitive, not binary,
  //    not node_modules/release/dist)
  const resolvedPath = guardDirectWritePath(
    input.path,
    session.resolved_repo_path,
    config.workspaceRoot
  );

  // 3. Calculate patch size and guard against directMaxPatchBytes
  const patchBytes = Buffer.byteLength(JSON.stringify(input.operations), "utf-8");
  guardDirectPatchSize(patchBytes);

  const currentSha256 = computeFileSha256(resolvedPath);
  if (currentSha256 !== input.expected_sha256.toLowerCase()) {
    throw new PatchWardenError(
      "file_hash_mismatch",
      `File hash mismatch for "${input.path}".`,
      "Re-read the file and request a new Direct review with its current sha256.",
      true,
      { path: input.path, expected_sha256: input.expected_sha256, actual_sha256: currentSha256 },
    );
  }

  const authorization = authorizeDirectOperation(session, proposal, input.review_id);

  // 4. Apply against the same bytes whose hash is validated. Re-resolve the
  // target immediately before replacement to detect link/reparse-point swaps.
  let patchResult: ReturnType<typeof applyPatchOperations>;
  try {
    patchResult = applyPatchOperations(resolvedPath, input.operations, {
      expectedSha256: input.expected_sha256,
      maxFileBytes: config.directMaxFileBytes,
      revalidatePath: () => guardDirectWritePath(
        input.path,
        session.resolved_repo_path,
        config.workspaceRoot,
      ),
    });
    const beforeSha256 = patchResult.before_sha256;

    // Re-read the file from disk to compute the authoritative after_sha256.
    const finalPath = guardDirectWritePath(
      input.path,
      session.resolved_repo_path,
      config.workspaceRoot,
    );
    const afterSha256 = computeFileSha256(finalPath);
    if (afterSha256 !== patchResult.after_sha256) {
      throw new PatchWardenError(
        "direct_target_changed_after_write",
        `Patch target "${input.path}" changed before the operation could be recorded.`,
        "Inspect the file and retry only after concurrent filesystem changes stop.",
        true,
        { path: input.path, expected_sha256: patchResult.after_sha256, actual_sha256: afterSha256 },
      );
    }

    // 6. Append operation record to session and close the one-time review receipt.
    appendDirectSessionOperation(input.session_id, {
      index: 0,
      timestamp: new Date().toISOString(),
      path: input.path,
      operation_type: "patch",
      before_sha256: beforeSha256,
      after_sha256: afterSha256,
      operations_applied: patchResult.operations_applied,
      bytes_changed: patchResult.bytes_changed,
    });
    completeDirectReview(input.session_id, authorization, true);

    // 7. Return result
    return {
      path: input.path,
      before_sha256: beforeSha256,
      after_sha256: afterSha256,
      operations_applied: patchResult.operations_applied,
      bytes_changed: patchResult.bytes_changed,
      next_action:
        "Call run_verification to test the changes, or apply_patch for more edits.",
    };
  } catch (error) {
    try {
      completeDirectReview(input.session_id, authorization, false, error);
    } catch {
      // Preserve the primary mutation failure; the audit reports an incomplete receipt.
    }
    throw error;
  }
  }, config);
}
