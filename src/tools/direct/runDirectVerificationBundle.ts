import { getConfig } from "../../config.js";
import {
  readDirectSession,
  withDirectSessionMutationLockAsync,
} from "../../direct/directSessionStore.js";
import { guardDirectSessionActive } from "../../direct/directGuards.js";
import {
  authorizeDirectOperation,
  buildDirectReviewProposalForCurrentWorkspace,
  completeDirectReview,
  validateDirectReviewProposal,
} from "../../direct/directReviewGate.js";
import { runVerificationWithinLockedSession } from "../tasks/runVerification.js";

export interface RunDirectVerificationBundleInput {
  session_id: string;
  commands: string[];
  timeout_seconds?: number;
  review_id?: string;
}

export interface RunDirectVerificationBundleOutput {
  session_id: string;
  status: "passed" | "failed";
  command_count: number;
  passed_commands: number;
  failed_commands: number;
  timed_out_commands: number;
  commands: Array<{
    command: string;
    passed: boolean;
    exit_code: number | null;
    timed_out: boolean;
    redacted: boolean;
    redaction_categories: string[];
    started_at: string;
    finished_at: string;
  }>;
  large_logs_omitted: true;
  next_action: string;
}

export async function runDirectVerificationBundle(
  input: RunDirectVerificationBundleInput
): Promise<RunDirectVerificationBundleOutput> {
  const normalized = normalizeInput(input);
  return withDirectSessionMutationLockAsync(normalized.session_id, async () => {
    const session = readDirectSession(normalized.session_id);
    guardDirectSessionActive(session);
    const proposal = await buildDirectReviewProposalForCurrentWorkspace(session, {
      operation_type: "verification_bundle",
      commands: normalized.commands,
      timeout_seconds: input.timeout_seconds,
    });
    validateDirectReviewProposal(session, proposal);
    const authorization = authorizeDirectOperation(session, proposal, normalized.review_id);
    const results: RunDirectVerificationBundleOutput["commands"] = [];

    try {
      for (const command of normalized.commands) {
        const result = await runVerificationWithinLockedSession({
          session_id: normalized.session_id,
          command,
          timeout_seconds: normalized.timeout_seconds,
        }, session);
        results.push({
          command: result.command,
          passed: result.passed,
          exit_code: result.exit_code,
          timed_out: result.timed_out,
          redacted: result.redacted,
          redaction_categories: result.redaction_categories,
          started_at: result.started_at,
          finished_at: result.finished_at,
        });
      }
      completeDirectReview(normalized.session_id, authorization, true);
    } catch (error) {
      try {
        completeDirectReview(normalized.session_id, authorization, false, error);
      } catch {
        // Preserve the primary verification failure; the audit reports an incomplete receipt.
      }
      throw error;
    }

    const failedCommands = results.filter((entry) => !entry.passed).length;
    const timedOutCommands = results.filter((entry) => entry.timed_out).length;
    return {
      session_id: normalized.session_id,
      status: failedCommands === 0 ? "passed" : "failed",
      command_count: results.length,
      passed_commands: results.length - failedCommands,
      failed_commands: failedCommands,
      timed_out_commands: timedOutCommands,
      commands: results,
      large_logs_omitted: true,
      next_action: failedCommands === 0
        ? "Call safe_finalize_direct_session, then safe_audit_direct_session."
        : "Review bounded verification status and create a normal follow-up task if fixes are needed.",
    };
  });
}

function normalizeInput(input: RunDirectVerificationBundleInput): Omit<Required<RunDirectVerificationBundleInput>, "review_id"> & Pick<RunDirectVerificationBundleInput, "review_id"> {
  const sessionId = String(input.session_id || "").trim();
  if (!sessionId) throw new Error("session_id is required.");
  if (!Array.isArray(input.commands) || input.commands.length === 0) {
    throw new Error("commands must contain at least one command.");
  }
  if (input.commands.length > 20) {
    throw new Error("commands may contain at most 20 commands.");
  }
  const commands = input.commands.map((command) => String(command).trim());
  if (commands.some((command) => command === "")) {
    throw new Error("commands must contain only non-empty strings.");
  }

  const config = getConfig();
  const maxTimeout = Math.min(config.maxTaskTimeoutSeconds, config.directSessionTtlSeconds);
  const timeoutSeconds = input.timeout_seconds ?? 120;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > maxTimeout) {
    throw new Error(`timeout_seconds must be an integer from 1 to ${maxTimeout}.`);
  }

  return {
    session_id: sessionId,
    commands,
    timeout_seconds: timeoutSeconds,
    review_id: input.review_id,
  };
}
