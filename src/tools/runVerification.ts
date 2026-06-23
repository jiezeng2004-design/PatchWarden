import {
  readDirectSession,
  appendDirectSessionVerificationRun,
} from "../direct/directSessionStore.js";
import { guardDirectSessionActive } from "../direct/directGuards.js";
import { runDirectVerification } from "../direct/directVerification.js";

export interface RunVerificationInput {
  session_id: string;
  command: string;
  timeout_seconds?: number;
}

export interface RunVerificationOutput {
  command: string;
  exit_code: number | null;
  passed: boolean;
  timed_out: boolean;
  stdout_tail: string;
  stderr_tail: string;
  log_path: string;
  next_action: string;
}

export async function runVerification(
  input: RunVerificationInput
): Promise<RunVerificationOutput> {
  // 1. Read session and guard active
  const session = readDirectSession(input.session_id);
  guardDirectSessionActive(session);

  // 2. Call runDirectVerification with command, resolvedRepoPath,
  //    sessionId, and timeoutSeconds
  const timeoutSeconds = input.timeout_seconds ?? 120;
  const result = await runDirectVerification({
    command: input.command,
    resolvedRepoPath: session.resolved_repo_path,
    sessionId: input.session_id,
    timeoutSeconds,
  });

  // 3. Append verification run to session
  appendDirectSessionVerificationRun(input.session_id, result.run);

  // 4. Return result
  return {
    command: result.run.command,
    exit_code: result.run.exit_code,
    passed: result.run.passed,
    timed_out: result.run.timed_out,
    stdout_tail: result.run.stdout_tail,
    stderr_tail: result.run.stderr_tail,
    log_path: result.run.log_path,
    next_action: result.run.passed
      ? "Call finalize_direct_session to complete the session."
      : "Review the verification output and apply_patch to fix issues.",
  };
}
