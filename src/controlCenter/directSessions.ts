import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { errorMessage, fileMtimeIso, readJsonFileSafe, readTextFileSafe } from "./helpers.js";

// ── Direct sessions ───────────────────────────────────────────────

export interface DirectSessionSummary {
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

export function readDirectSessionSummary(sessionDir: string, sessionId: string): DirectSessionSummary | null {
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

export function handleDirectSessions(res: import("node:http").ServerResponse, sessionsDir: string): void {
  const sendJson = (status: number, body: unknown) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    let payload: string;
    try {
      payload = JSON.stringify(body);
    } catch {
      payload = JSON.stringify({ error: "serialization failed" });
      status = 500;
    }
    res.end(payload);
  };

  try {
    if (!existsSync(sessionsDir)) {
      // Directory missing -> empty list, never 500.
      sendJson(200, { sessions: [], total: 0, reason: null });
      return;
    }
    let entries: import("node:fs").Dirent[] = [];
    try {
      entries = readdirSync(sessionsDir, { withFileTypes: true }).filter((e) => e.isDirectory());
    } catch (err) {
      sendJson(200, { sessions: [], total: 0, reason: errorMessage(err) });
      return;
    }
    const summaries: DirectSessionSummary[] = [];
    for (const entry of entries) {
      const summary = readDirectSessionSummary(join(sessionsDir, entry.name), entry.name);
      if (summary) summaries.push(summary);
    }
    // Sort by created_at descending.
    summaries.sort((a, b) => b.created_at.localeCompare(a.created_at));
    sendJson(200, { sessions: summaries, total: summaries.length, reason: null });
  } catch (err) {
    sendJson(200, { sessions: [], total: 0, reason: errorMessage(err) });
  }
}

export function handleDirectSessionDetail(res: import("node:http").ServerResponse, sessionId: string, sessionsDir: string): void {
  const sendJson = (status: number, body: unknown) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    let payload: string;
    try {
      payload = JSON.stringify(body);
    } catch {
      payload = JSON.stringify({ error: "serialization failed" });
      status = 500;
    }
    res.end(payload);
  };

  try {
    if (
      sessionId === "." ||
      sessionId === ".." ||
      sessionId.includes("/") ||
      sessionId.includes("\\") ||
      sessionId.includes("\0")
    ) {
      sendJson(400, { error: "Invalid session id" });
      return;
    }
    const sessionDir = join(sessionsDir, sessionId);
    if (!existsSync(sessionDir) || !statSync(sessionDir).isDirectory()) {
      sendJson(404, { error: "Direct session not found" });
      return;
    }
    const summary = readDirectSessionSummary(sessionDir, sessionId);
    sendJson(200, {
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
    sendJson(200, { session_id: sessionId, error: errorMessage(err) });
  }
}