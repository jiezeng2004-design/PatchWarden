import { existsSync, statSync } from "node:fs";
import { getConfig } from "../../config.js";
import { PatchWardenError } from "../../errors.js";
import { guardWorkspacePath } from "../../security/pathGuard.js";
import { guardRuntimeSelfModification } from "../../security/runtimeGuard.js";
import { captureRepoSnapshot } from "../../runner/changeCapture.js";
import {
  createDirectSession as createDirectSessionRecord,
} from "../../direct/directSessionStore.js";

// ── Types ──────────────────────────────────────────────────────────

export interface CreateDirectSessionInput {
  repo_path: string;
  title?: string;
  expected_changes?: boolean;
  requester_agent?: string;
}

export interface CreateDirectSessionOutput {
  session_id: string;
  repo_path: string;
  resolved_repo_path: string;
  workspace_clean: boolean;
  allowed_commands: string[];
  expected_changes: boolean;
  requester_agent: string;
  expires_at: string;
  next_action: string;
}

// ── Tool implementation ────────────────────────────────────────────

export async function createDirectSession(
  input: CreateDirectSessionInput
): Promise<CreateDirectSessionOutput> {
  const config = getConfig();

  // ── Validate repo_path ───────────────────────────────────────────

  if (!input.repo_path || input.repo_path.trim() === "") {
    throw new PatchWardenError(
      "invalid_input",
      "repo_path is required and must be a non-empty string.",
      "Provide a repository path inside the configured workspaceRoot.",
      true,
      { operation: "create_direct_session" }
    );
  }

  const resolvedRepoPath = guardWorkspacePath(
    input.repo_path,
    config.workspaceRoot
  );

  // ── Verify existence ─────────────────────────────────────────────

  if (!existsSync(resolvedRepoPath)) {
    throw new PatchWardenError(
      "repo_not_found",
      `repo_path "${input.repo_path}" does not exist (resolved: "${resolvedRepoPath}").`,
      "Provide a valid repository path inside the configured workspaceRoot.",
      true,
      {
        repo_path: input.repo_path,
        resolved_repo_path: resolvedRepoPath,
        operation: "create_direct_session",
      }
    );
  }

  // ── Verify it is a directory ─────────────────────────────────────

  const stat = statSync(resolvedRepoPath);
  if (!stat.isDirectory()) {
    throw new PatchWardenError(
      "repo_not_directory",
      `repo_path "${input.repo_path}" is not a directory.`,
      "Provide a directory path, not a file path.",
      true,
      {
        repo_path: input.repo_path,
        resolved_repo_path: resolvedRepoPath,
        operation: "create_direct_session",
      }
    );
  }

  // ── Runtime self-modification protection ─────────────────────────

  guardRuntimeSelfModification(resolvedRepoPath);

  const requesterAgent = resolveDirectRequesterAgent(input.requester_agent, config);

  // ── Capture repo snapshot ────────────────────────────────────────

  const snapshot = await captureRepoSnapshot(resolvedRepoPath);

  // ── Create session record ────────────────────────────────────────

  const session = createDirectSessionRecord({
    repo_path: input.repo_path,
    resolved_repo_path: resolvedRepoPath,
    title: input.title,
    expected_changes: input.expected_changes,
    requester_agent: requesterAgent,
    snapshot,
  });

  return {
    session_id: session.session_id,
    repo_path: session.repo_path,
    resolved_repo_path: session.resolved_repo_path,
    workspace_clean: !snapshot.workspace_dirty,
    allowed_commands: session.allowed_commands,
    expected_changes: session.expected_changes,
    requester_agent: session.requester_agent,
    expires_at: session.expires_at,
    next_action:
      "Use search_workspace/read_workspace_file, then apply_patch to make file changes within this session. " +
      "After editing, call run_verification, finalize_direct_session, and audit_session.",
  };
}

function resolveDirectRequesterAgent(
  callerValue: string | undefined,
  config: ReturnType<typeof getConfig>,
): string | undefined {
  if (config.directReview.mode === "off") return callerValue;
  const configured = config.directReview.requesterAgentName;
  if (!configured) {
    throw new PatchWardenError(
      "direct_requester_identity_unconfigured",
      "Direct review requires a server-configured requester Agent identity.",
      "Set directReview.requesterAgentName to a registered Agent that differs from reviewerAgentName.",
      true,
      { direct_review_mode: config.directReview.mode },
    );
  }
  if (callerValue && callerValue.trim() !== configured) {
    throw new PatchWardenError(
      "direct_requester_identity_mismatch",
      "The caller-supplied requester Agent does not match the server-configured Direct requester identity.",
      "Do not override requester identity through MCP; use the configured Direct requester Agent.",
      true,
      { configured_requester_agent: configured },
    );
  }
  return configured;
}
