import { getConfig } from "../config.js";
import {
  readDirectSession,
  appendDirectSessionOperation,
} from "../direct/directSessionStore.js";
import {
  guardDirectSessionActive,
  guardDirectWritePath,
  guardDirectPatchSize,
} from "../direct/directGuards.js";
import {
  applyPatchOperations,
  validateExpectedSha256,
  computeFileSha256,
  type PatchOperation,
} from "../direct/directPatch.js";

export interface ApplyPatchInput {
  session_id: string;
  path: string;
  expected_sha256: string;
  operations: PatchOperation[];
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

  // 1. Read session and guard active (not expired, not finalized)
  const session = readDirectSession(input.session_id);
  guardDirectSessionActive(session);

  // 2. Guard write path (inside repo, not sensitive, not binary,
  //    not node_modules/release/dist)
  const resolvedPath = guardDirectWritePath(
    input.path,
    session.resolved_repo_path,
    config.workspaceRoot
  );

  // 3. Calculate patch size and guard against directMaxPatchBytes
  const patchBytes = JSON.stringify(input.operations).length;
  guardDirectPatchSize(patchBytes);

  // 4. Validate expected_sha256 matches current file hash
  const beforeSha256 = validateExpectedSha256(
    resolvedPath,
    input.expected_sha256
  );

  // 5. Apply patch operations
  const patchResult = applyPatchOperations(resolvedPath, input.operations);

  // Re-read the file from disk to compute the authoritative after_sha256
  const afterSha256 = computeFileSha256(resolvedPath);

  // 6. Append operation record to session
  appendDirectSessionOperation(input.session_id, {
    index: session.operations.length,
    timestamp: new Date().toISOString(),
    path: input.path,
    before_sha256: beforeSha256,
    after_sha256: afterSha256,
    operations_applied: patchResult.operations_applied,
    bytes_changed: patchResult.bytes_changed,
  });

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
}
