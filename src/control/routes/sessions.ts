/**
 * Control Center routes — Direct sessions (/api/direct-sessions/*).
 *
 * Lists, inspects, finalizes, audits, and hides Direct editing sessions. The
 * list/detail endpoints are read-only and fault-tolerant (missing dir returns
 * an empty list, never 500). The finalize/audit/hide endpoints are POST routes
 * gated by the control token in the server router.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { type ServerResponse } from "node:http";
import { getDirectSessionsDir } from "../../config.js";
import { safeAuditDirectSession, safeDirectSummary, safeFinalizeDirectSession } from "../../tools/diagnostics/safeViews.js";
import {
  fileMtimeIso,
  isValidDirectSessionId,
  readHiddenDirectSessionIds,
  recordEvent,
  writeHiddenDirectSessionIds,
} from "../runtime.js";
import { config, errorMessage, guardControlPath, readJsonFileSafe, readTextFileSafe, sendJson } from "../shared.js";

interface DirectSessionSummary {
  session_id: string;
  repo_path: string;
  resolved_repo_path: string;
  created_at: string;
  expires_at: string;
  finalized: boolean;
  finalized_at: string | null;
  audited: boolean;
  changed_files_total: number | null;
  verification_summary: unknown | null;
  audit_decision: string | null;
  audit_checked_at: string | null;
  title: string;
}

function readDirectSessionSummary(sessionDir: string, sessionId: string): DirectSessionSummary | null {
  const sessionFile = join(sessionDir, "session.json");
  if (!existsSync(sessionFile)) return null;
  const data = readJsonFileSafe<Record<string, unknown>>(sessionFile);
  if (!data) return null;

  // summary.json holds the finalized change summary (changed_files_total, etc.)
  const summaryFile = join(sessionDir, "summary.json");
  const summary = readJsonFileSafe<Record<string, unknown>>(summaryFile);
  const changedFilesTotal = summary
    ? typeof summary.changed_files_total === "number"
      ? summary.changed_files_total
      : null
    : null;

  // audit.json (written by audit_session) holds the audit decision
  const auditFile = join(sessionDir, "audit.json");
  const audit = readJsonFileSafe<Record<string, unknown>>(auditFile);
  const auditDecision = audit
    ? typeof audit.decision === "string"
      ? audit.decision
      : typeof audit.verdict === "string"
        ? audit.verdict
        : null
    : null;
  const auditCheckedAt = audit
    ? typeof audit.checked_at === "string"
      ? audit.checked_at
      : fileMtimeIso(auditFile)
    : null;

  // verification summary: read from session.json verification_runs (last run)
  let verificationSummary: unknown | null = null;
  if (Array.isArray(data.verification_runs) && data.verification_runs.length > 0) {
    const runs = data.verification_runs as Array<Record<string, unknown>>;
    verificationSummary = runs[runs.length - 1];
  }

  return {
    session_id: sessionId,
    repo_path: typeof data.repo_path === "string" ? data.repo_path : "",
    resolved_repo_path: typeof data.resolved_repo_path === "string" ? data.resolved_repo_path : "",
    created_at: typeof data.created_at === "string" ? data.created_at : "",
    expires_at: typeof data.expires_at === "string" ? data.expires_at : "",
    finalized: Boolean(data.finalized),
    finalized_at: typeof data.finalized_at === "string" ? data.finalized_at : null,
    audited: Boolean(data.audited),
    changed_files_total: changedFilesTotal,
    verification_summary: verificationSummary,
    audit_decision: auditDecision,
    audit_checked_at: auditCheckedAt,
    title: typeof data.title === "string" ? data.title : "",
  };
}

export function handleDirectSessions(res: ServerResponse): void {
  try {
    const sessionsDir = getDirectSessionsDir(config);
    if (!existsSync(sessionsDir)) {
      // Directory missing -> empty list, never 500.
      sendJson(res, 200, { sessions: [], total: 0, reason: null });
      return;
    }
    let entries: import("node:fs").Dirent[] = [];
    try {
      entries = readdirSync(sessionsDir, { withFileTypes: true }).filter((e) => e.isDirectory());
    } catch (err) {
      sendJson(res, 200, { sessions: [], total: 0, reason: errorMessage(err) });
      return;
    }
    // Filter out sessions hidden from the dashboard via POST .../hide.
    const hiddenIds = new Set(readHiddenDirectSessionIds());
    const summaries: DirectSessionSummary[] = [];
    for (const entry of entries) {
      if (hiddenIds.has(entry.name)) continue;
      const sessionDir = guardControlPath(join(sessionsDir, entry.name), config.directSessionsDir);
      if (!sessionDir) continue;
      const summary = readDirectSessionSummary(sessionDir, entry.name);
      if (summary) summaries.push(summary);
    }
    // Sort by created_at descending.
    summaries.sort((a, b) => b.created_at.localeCompare(a.created_at));
    sendJson(res, 200, { sessions: summaries, total: summaries.length, reason: null });
  } catch (err) {
    sendJson(res, 200, { sessions: [], total: 0, reason: errorMessage(err) });
  }
}

export function handleDirectSessionDetail(res: ServerResponse, sessionId: string): void {
  try {
    if (!isValidDirectSessionId(sessionId)) {
      sendJson(res, 400, { error: "Invalid session id" });
      return;
    }
    const sessionsDir = getDirectSessionsDir(config);
    const sessionDir = guardControlPath(join(sessionsDir, sessionId), config.directSessionsDir);
    if (!sessionDir || !existsSync(sessionDir) || !statSync(sessionDir).isDirectory()) {
      sendJson(res, 404, { error: "Direct session not found" });
      return;
    }
    const summary = readDirectSessionSummary(sessionDir, sessionId);
    sendJson(res, 200, {
      session_id: sessionId,
      summary,
      session: readJsonFileSafe(join(sessionDir, "session.json")),
      summary_md: readTextFileSafe(join(sessionDir, "summary.md")),
      diff_patch: readTextFileSafe(join(sessionDir, "diff.patch")),
      audit_json: readJsonFileSafe(join(sessionDir, "audit.json")),
      audit_md: readTextFileSafe(join(sessionDir, "audit.md")),
      changed_files: readJsonFileSafe(join(sessionDir, "changed-files.json")),
    });
  } catch (err) {
    sendJson(res, 200, { session_id: sessionId, error: errorMessage(err) });
  }
}

export function handleDirectSessionSafeSummary(res: ServerResponse, sessionId: string): void {
  try {
    if (!isValidDirectSessionId(sessionId)) {
      sendJson(res, 400, { error: "Invalid session id" });
      return;
    }
    sendJson(res, 200, safeDirectSummary(sessionId, { max_items: 12 }));
  } catch (err) {
    sendJson(res, 200, {
      session_id: sessionId,
      error: errorMessage(err),
      large_logs_omitted: true,
      diff_omitted: true,
    });
  }
}

/**
 * Finalize a direct session via safeFinalizeDirectSession. Returns the safe
 * summary on success, or { error } on failure with HTTP 200 (fault tolerance:
 * the UI always gets a JSON body it can render).
 */
export async function handleDirectSessionFinalize(res: ServerResponse, sessionId: string): Promise<void> {
  try {
    if (!isValidDirectSessionId(sessionId)) {
      sendJson(res, 400, { error: "Invalid session id" });
      return;
    }
    const result = await safeFinalizeDirectSession(sessionId, { max_items: 12 });
    recordEvent("direct_session.finalized", { session_id: sessionId });
    sendJson(res, 200, result);
  } catch (err) {
    sendJson(res, 200, {
      session_id: sessionId,
      error: errorMessage(err),
      large_logs_omitted: true,
      diff_omitted: true,
    });
  }
}

/**
 * Audit a direct session via safeAuditDirectSession. Returns the safe audit
 * result on success, or { error } on failure (HTTP 200 for fault tolerance).
 */
export function handleDirectSessionAudit(res: ServerResponse, sessionId: string): void {
  try {
    if (!isValidDirectSessionId(sessionId)) {
      sendJson(res, 400, { error: "Invalid session id" });
      return;
    }
    const result = safeAuditDirectSession(sessionId, { max_items: 12 });
    recordEvent("direct_session.audited", { session_id: sessionId });
    sendJson(res, 200, result);
  } catch (err) {
    sendJson(res, 200, {
      session_id: sessionId,
      error: errorMessage(err),
      large_logs_omitted: true,
      diff_omitted: true,
    });
  }
}

/**
 * Hide a direct session from the dashboard list. The session itself is NOT
 * deleted or modified — only the control-center's local
 * hidden-direct-session-ids.json state file is updated. Requires control token
 * (enforced by the POST router).
 */
export function handleDirectSessionHide(res: ServerResponse, sessionId: string): void {
  try {
    if (!isValidDirectSessionId(sessionId)) {
      sendJson(res, 400, { error: "Invalid session id" });
      return;
    }
    const ids = readHiddenDirectSessionIds();
    if (!ids.includes(sessionId)) {
      ids.push(sessionId);
      writeHiddenDirectSessionIds(ids);
    }
    recordEvent("direct_session.hidden", { session_id: sessionId });
    sendJson(res, 200, { ok: true, hidden: sessionId });
  } catch (err) {
    sendJson(res, 500, { error: errorMessage(err) });
  }
}
