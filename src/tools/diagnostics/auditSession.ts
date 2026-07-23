import {
  auditDirectSession,
  type DirectSessionAuditOutput,
} from "../../direct/directAudit.js";
import { updateDirectSession } from "../../direct/directSessionStore.js";

// ── Types ──────────────────────────────────────────────────────────

export interface AuditSessionInput {
  session_id: string;
}

// ── Main function ──────────────────────────────────────────────────

export function auditSession(
  input: AuditSessionInput
): DirectSessionAuditOutput {
  const { session_id } = input;

  // 1. Perform independent audit (16 audit checks)
  const output = auditDirectSession(session_id);

  // 2. Mark session as audited
  updateDirectSession(session_id, { audited: true });

  // 3. Return the audit output
  return output;
}
