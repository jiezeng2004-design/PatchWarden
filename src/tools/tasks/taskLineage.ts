import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { getConfig, getTasksDir } from "../../config.js";
import { guardReadPath } from "../../security/pathGuard.js";
import { redactSensitiveValue } from "../../security/contentRedaction.js";
import { PatchWardenError } from "../../errors.js";
import { atomicWriteFileSync, atomicWriteJsonFileSync } from "../../utils/atomicFile.js";
import { withFileLockSync } from "../../utils/lockedJsonFile.js";
import { sanitizeModelSelectionEvidence, type ModelSelectionEvidence } from "../../agents/modelSelection.js";

export type TaskLoopStopReason =
  | "success"
  | "verification_passed"
  | "audit_accepted"
  | "audit_failed"
  | "task_queued"
  | "max_iterations_reached"
  | "verification_failed"
  | "high_risk_blocked"
  | "user_confirmation_required"
  | "agent_timeout"
  | "policy_blocked"
  | "watcher_blocked"
  | "direct_profile_disabled"
  | "direct_verification_failed"
  | "direct_audit_failed"
  | "recovery_required";

export interface TaskLineageDirectSession {
  session_id: string;
  status?: "passed" | "failed" | "skipped";
  command_count?: number;
  passed_commands?: number;
  failed_commands?: number;
  timed_out_commands?: number;
  audit_decision?: "pass" | "warn" | "fail" | "not_run";
  changed_files_total?: number;
  next_action?: string;
}

export interface TaskLineageWorktree {
  isolation_mode: "current_repo" | "worktree";
  worktree_id?: string;
  worktree_path?: string;
  branch?: string;
  requested_base_branch?: string;
  cleanup: "keep" | "archive" | "delete_ignored_only";
  status: "not_used" | "active" | "failed";
  next_action: string;
}

export interface TaskLineageAgentRouting {
  requested_agent: string | null;
  selected_agent: string;
  reason: string;
  fallback: boolean;
}

export interface TaskLineageRound {
  iteration: number;
  task_id: string;
  role: "main" | "fix_tests" | "cleanup";
  status: string;
  terminal: boolean;
  verification_status: string;
  audit_verdict: string;
  failure_category?: string | null;
  provider_error_reference?: string | null;
  fail_checks: string[];
  warn_checks: string[];
  next_action: string;
}

export interface TaskLineageRecord {
  lineage_id: string;
  request_id?: string;
  goal: string;
  repo_path: string;
  created_at: string;
  updated_at: string;
  final_status: "running" | "ready_for_audit" | "accepted" | "needs_fix" | "blocked" | "failed";
  stop_reason: TaskLoopStopReason;
  next_action: string;
  main_task: string | null;
  fix_tasks: string[];
  cleanup_tasks: string[];
  direct_sessions: Array<string | TaskLineageDirectSession>;
  rounds: TaskLineageRound[];
  warnings: string[];
  errors: string[];
  worktree?: TaskLineageWorktree;
  agent_routing?: TaskLineageAgentRouting;
  model_selection?: ModelSelectionEvidence;
}

export interface SafeTaskLineage {
  lineage_id: string;
  request_id: string;
  goal: string;
  repo_path: string;
  created_at: string;
  updated_at: string;
  final_status: TaskLineageRecord["final_status"];
  stop_reason: TaskLoopStopReason;
  next_action: string;
  tasks: {
    main: string | null;
    fix: string[];
    cleanup: string[];
    direct_sessions: TaskLineageDirectSession[];
  };
  worktree: TaskLineageWorktree;
  agent_routing: TaskLineageAgentRouting | null;
  model_selection: ModelSelectionEvidence | null;
  verification: {
    latest_status: string;
    passed: boolean;
  };
  rounds: TaskLineageRound[];
  warnings: string[];
  errors: string[];
  continuation_required: boolean;
  truncated: boolean;
}

export function createLineageId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `lineage_${stamp}_${randomBytes(4).toString("hex")}`;
}

export function writeTaskLineage(record: TaskLineageRecord): SafeTaskLineage {
  const config = getConfig();
  const lineageDir = resolve(config.workspaceRoot, ".patchwarden", "lineages", record.lineage_id);
  mkdirSync(lineageDir, { recursive: true });
  const lineageFile = join(lineageDir, "lineage.json");
  return withFileLockSync(lineageFile, () => {
    const next = structuredClone(record);
    if (reconcileStoredAudits(next)) next.updated_at = new Date().toISOString();
    const safeRecord = redactSensitiveValue(next).value as TaskLineageRecord;
    persistLineageRecord(lineageFile, safeRecord);
    return toSafeTaskLineage(safeRecord);
  });
}

export function getTaskLineage(lineageId: string, options: { max_items?: number } = {}): SafeTaskLineage {
  const maxItems = normalizeMaxItems(options.max_items);
  if (!/^[A-Za-z0-9_-]+$/.test(lineageId)) {
    throw new PatchWardenError(
      "invalid_lineage_id",
      "lineage_id may contain only letters, numbers, underscores, and hyphens.",
      "Pass a lineage_id returned by run_task_loop.",
      true,
      { lineage_id: lineageId }
    );
  }
  const config = getConfig();
  const lineageFile = resolve(config.workspaceRoot, ".patchwarden", "lineages", lineageId, "lineage.json");
  guardReadPath(lineageFile, config.workspaceRoot, ".patchwarden/lineages");
  if (!existsSync(lineageFile)) {
    throw new PatchWardenError(
      "lineage_not_found",
      `Task lineage not found: "${lineageId}".`,
      "Pass a lineage_id returned by run_task_loop.",
      true,
      { lineage_id: lineageId }
    );
  }
  return withFileLockSync(lineageFile, () => {
    const raw = readFileSync(lineageFile, "utf-8").replace(/^\uFEFF/, "");
    const record = JSON.parse(raw) as TaskLineageRecord;
    if (reconcileStoredAudits(record)) {
      record.updated_at = new Date().toISOString();
      const safeRecord = redactSensitiveValue(record).value as TaskLineageRecord;
      persistLineageRecord(lineageFile, safeRecord);
      return toSafeTaskLineage(safeRecord, maxItems);
    }
    return toSafeTaskLineage(redactSensitiveValue(record).value as TaskLineageRecord, maxItems);
  });
}

interface LineageAuditEvidence {
  task_id?: unknown;
  verdict?: unknown;
  acceptance?: unknown;
  checks?: unknown;
  fail_checks?: unknown;
  warn_checks?: unknown;
  recommended_next_actions?: unknown;
}

/**
 * Synchronize a completed task audit into every lineage that references it.
 * New loop tasks carry lineage_id directly; the bounded directory scan keeps
 * pre-link lineage files readable and repairable.
 */
export function syncTaskAuditToLineages(
  taskId: string,
  audit: LineageAuditEvidence,
  lineageId?: string | null,
  now = new Date(),
): string[] {
  if (!/^[A-Za-z0-9_-]+$/.test(taskId)) return [];
  const config = getConfig();
  const lineagesDir = resolve(config.workspaceRoot, ".patchwarden", "lineages");
  if (!existsSync(lineagesDir)) return [];
  const candidates = new Set<string>();
  const linkedLineageFile = lineageId && /^[A-Za-z0-9_-]+$/.test(lineageId)
    ? resolve(lineagesDir, lineageId, "lineage.json")
    : null;
  if (lineageId && linkedLineageFile && existsSync(linkedLineageFile)) {
    candidates.add(lineageId);
  } else {
    for (const entry of readdirSync(lineagesDir, { withFileTypes: true }).slice(0, 2_000)) {
      if (entry.isDirectory() && /^[A-Za-z0-9_-]+$/.test(entry.name)) candidates.add(entry.name);
    }
  }

  const updated: string[] = [];
  for (const candidate of candidates) {
    const lineageFile = resolve(lineagesDir, candidate, "lineage.json");
    if (!existsSync(lineageFile)) continue;
    guardReadPath(lineageFile, config.workspaceRoot, ".patchwarden/lineages");
    const changed = withFileLockSync(lineageFile, () => {
      const record = JSON.parse(readFileSync(lineageFile, "utf-8").replace(/^\uFEFF/, "")) as TaskLineageRecord;
      if (!applyAuditEvidence(record, taskId, audit)) return false;
      record.updated_at = now.toISOString();
      const safeRecord = redactSensitiveValue(record).value as TaskLineageRecord;
      persistLineageRecord(lineageFile, safeRecord);
      return true;
    });
    if (changed) updated.push(candidate);
  }
  return updated;
}

export function failInterruptedTaskLineage(lineageId: string, now = new Date()): SafeTaskLineage {
  if (!/^[A-Za-z0-9_-]+$/.test(lineageId)) {
    throw new Error("Invalid lineage ID for interrupted-loop recovery.");
  }
  const config = getConfig();
  const lineageFile = resolve(config.workspaceRoot, ".patchwarden", "lineages", lineageId, "lineage.json");
  guardReadPath(lineageFile, config.workspaceRoot, ".patchwarden/lineages");
  return withFileLockSync(lineageFile, () => {
    const record = JSON.parse(readFileSync(lineageFile, "utf-8").replace(/^\uFEFF/, "")) as TaskLineageRecord;
    if (record.final_status !== "running") return toSafeTaskLineage(record);
    record.final_status = "failed";
    record.stop_reason = "recovery_required";
    record.next_action = "rerun_run_task_loop_with_a_new_request_id";
    record.updated_at = now.toISOString();
    record.errors.push("The previous Core process exited before this task loop reached a terminal state; no tasks were duplicated during recovery.");
    const safeRecord = redactSensitiveValue(record).value as TaskLineageRecord;
    atomicWriteJsonFileSync(lineageFile, safeRecord);
    atomicWriteFileSync(resolve(lineageFile, "..", "SUMMARY.md"), buildSummaryMarkdown(safeRecord));
    return toSafeTaskLineage(safeRecord);
  });
}

export function toSafeTaskLineage(record: TaskLineageRecord, maxItems = 8): SafeTaskLineage {
  const rounds = record.rounds.slice(0, maxItems);
  const latest = record.rounds[record.rounds.length - 1];
  const directSessions = normalizeDirectSessions(record.direct_sessions);
  return {
    lineage_id: record.lineage_id,
    request_id: truncate(String(record.request_id || record.lineage_id), 128),
    goal: record.goal,
    repo_path: record.repo_path,
    created_at: record.created_at,
    updated_at: record.updated_at,
    final_status: record.final_status,
    stop_reason: record.stop_reason,
    next_action: record.next_action,
    tasks: {
      main: record.main_task,
      fix: record.fix_tasks.slice(0, maxItems),
      cleanup: record.cleanup_tasks.slice(0, maxItems),
      direct_sessions: directSessions.slice(0, maxItems),
    },
    worktree: normalizeWorktree(record.worktree),
    agent_routing: record.agent_routing ? {
      requested_agent: record.agent_routing.requested_agent,
      selected_agent: truncate(String(record.agent_routing.selected_agent), 120),
      reason: truncate(String(record.agent_routing.reason), 240),
      fallback: Boolean(record.agent_routing.fallback),
    } : null,
    model_selection: sanitizeModelSelectionEvidence(record.model_selection),
    verification: {
      latest_status: latest?.verification_status || "not_available",
      passed: latest?.verification_status === "passed",
    },
    rounds,
    warnings: record.warnings.slice(0, maxItems).map((value) => truncate(value, 240)),
    errors: record.errors.slice(0, maxItems).map((value) => truncate(value, 240)),
    continuation_required: record.final_status === "running",
    truncated:
      record.rounds.length > maxItems ||
      record.fix_tasks.length > maxItems ||
      record.cleanup_tasks.length > maxItems ||
      directSessions.length > maxItems ||
      record.warnings.length > maxItems ||
      record.errors.length > maxItems,
  };
}

function buildSummaryMarkdown(record: TaskLineageRecord): string {
  const rounds = record.rounds.map((round) =>
    `- ${round.role} ${round.task_id}: ${round.status}, verification=${round.verification_status}, audit=${round.audit_verdict}, failure=${round.failure_category || "none"}`
  );
  return [
    "# PatchWarden Task Lineage",
    "",
    `- Lineage: ${record.lineage_id}`,
    `- Request: ${record.request_id || record.lineage_id}`,
    `- Goal: ${record.goal}`,
    `- Repo: ${record.repo_path}`,
    `- Final status: ${record.final_status}`,
    `- Stop reason: ${record.stop_reason}`,
    `- Next action: ${record.next_action}`,
    `- Isolation: ${normalizeWorktree(record.worktree).isolation_mode}`,
    `- Worktree: ${formatWorktree(record.worktree)}`,
    `- Agent routing: ${formatAgentRouting(record.agent_routing)}`,
    "",
    "## Tasks",
    `- Main: ${record.main_task || "none"}`,
    `- Fix tasks: ${record.fix_tasks.length > 0 ? record.fix_tasks.join(", ") : "none"}`,
    `- Cleanup tasks: ${record.cleanup_tasks.length > 0 ? record.cleanup_tasks.join(", ") : "none"}`,
    `- Direct sessions: ${formatDirectSessions(record.direct_sessions)}`,
    "",
    "## Rounds",
    ...(rounds.length > 0 ? rounds : ["- None."]),
    "",
  ].join("\n");
}

function persistLineageRecord(lineageFile: string, record: TaskLineageRecord): void {
  atomicWriteJsonFileSync(lineageFile, record);
  atomicWriteFileSync(resolve(lineageFile, "..", "SUMMARY.md"), buildSummaryMarkdown(record));
}

function reconcileStoredAudits(record: TaskLineageRecord): boolean {
  let changed = false;
  for (const round of record.rounds) {
    const audit = readStoredAudit(round.task_id);
    if (audit && applyAuditEvidence(record, round.task_id, audit)) changed = true;
  }
  return changed;
}

function readStoredAudit(taskId: string): LineageAuditEvidence | null {
  if (!/^[A-Za-z0-9_-]+$/.test(taskId)) return null;
  const config = getConfig();
  const auditPath = resolve(getTasksDir(config), taskId, "audit.json");
  if (!existsSync(auditPath)) return null;
  guardReadPath(auditPath, config.workspaceRoot, config.tasksDir);
  try {
    const parsed: unknown = JSON.parse(readFileSync(auditPath, "utf-8").replace(/^\uFEFF/, ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as LineageAuditEvidence
      : null;
  } catch {
    return null;
  }
}

function applyAuditEvidence(record: TaskLineageRecord, taskId: string, audit: LineageAuditEvidence): boolean {
  let roundIndex = -1;
  for (let index = record.rounds.length - 1; index >= 0; index--) {
    if (record.rounds[index].task_id === taskId) {
      roundIndex = index;
      break;
    }
  }
  if (roundIndex < 0) return false;
  const round = record.rounds[roundIndex];
  const acceptance = asRecord(audit.acceptance);
  const acceptanceStatus = String(acceptance.status || "").toLowerCase();
  const auditVerdict = normalizeAuditVerdict(audit.verdict);
  const acceptanceVerdict = normalizeAuditVerdict(acceptance.verdict);
  // Acceptance is the authoritative gate: a summary "pass" cannot accept a
  // task that still requires explicit approval (for example, release claims).
  const verdict = acceptanceStatus === "blocked" || acceptanceVerdict === "fail"
    ? "fail"
    : acceptanceVerdict === "warn"
      ? "warn"
      : auditVerdict ?? acceptanceVerdict;
  if (!verdict || verdict === "not_run") return false;
  const failChecks = collectCheckNames(audit, acceptance, "fail");
  const warnChecks = collectCheckNames(audit, acceptance, "warn");
  const nextAction = verdict === "pass"
    ? "none"
    : firstBoundedString(acceptance.next_suggested_task, audit.recommended_next_actions, "review_task");
  const before = JSON.stringify({
    audit_verdict: round.audit_verdict,
    fail_checks: round.fail_checks,
    warn_checks: round.warn_checks,
    next_action: round.next_action,
    final_status: record.final_status,
    stop_reason: record.stop_reason,
    lineage_next_action: record.next_action,
  });
  round.audit_verdict = verdict;
  round.fail_checks = failChecks;
  round.warn_checks = warnChecks;
  round.next_action = nextAction;

  if (roundIndex === record.rounds.length - 1) {
    if (verdict === "pass" && isVerifiedSuccessfulRound(round)) {
      record.final_status = "accepted";
      record.stop_reason = "audit_accepted";
      record.next_action = "none";
    } else if (verdict === "fail" || verdict === "warn") {
      const highRisk = [...failChecks, ...warnChecks].some((name) =>
        /scope|policy|sensitive|secret|forbidden|publish|release|remote/.test(name.toLowerCase())
      );
      record.final_status = acceptanceStatus === "blocked" || highRisk ? "blocked" : "needs_fix";
      record.stop_reason = "audit_failed";
      record.next_action = nextAction;
    }
  }

  const after = JSON.stringify({
    audit_verdict: round.audit_verdict,
    fail_checks: round.fail_checks,
    warn_checks: round.warn_checks,
    next_action: round.next_action,
    final_status: record.final_status,
    stop_reason: record.stop_reason,
    lineage_next_action: record.next_action,
  });
  return before !== after;
}

function normalizeAuditVerdict(value: unknown): "pass" | "warn" | "fail" | "not_run" | null {
  const normalized = String(value || "").toLowerCase();
  if (normalized === "pass" || normalized === "accepted") return "pass";
  if (normalized === "warn" || normalized === "needs_fix") return "warn";
  if (normalized === "fail" || normalized === "rejected" || normalized === "blocked_by_approval") return "fail";
  if (normalized === "not_run" || normalized === "unknown" || normalized === "") return "not_run";
  return null;
}

function collectCheckNames(
  audit: LineageAuditEvidence,
  acceptance: Record<string, unknown>,
  result: "fail" | "warn",
): string[] {
  const names = new Set<string>();
  const add = (value: unknown) => {
    for (const entry of Array.isArray(value) ? value : []) {
      const record = asRecord(entry);
      const name = String(record.name || entry || "").trim();
      if (name) names.add(truncate(name, 160));
    }
  };
  add(result === "fail" ? audit.fail_checks : audit.warn_checks);
  add(result === "fail" ? acceptance.fail_checks : acceptance.warn_checks);
  for (const entry of Array.isArray(audit.checks) ? audit.checks : []) {
    const check = asRecord(entry);
    if (String(check.result || "").toLowerCase() === result) add([entry]);
  }
  return [...names].slice(0, 50);
}

function firstBoundedString(primary: unknown, list: unknown, fallback: string): string {
  if (typeof primary === "string" && primary.trim()) return truncate(primary.trim(), 240);
  const first = Array.isArray(list) ? list.find((entry) => typeof entry === "string" && entry.trim()) : undefined;
  return truncate(typeof first === "string" ? first.trim() : fallback, 240);
}

function isVerifiedSuccessfulRound(round: TaskLineageRound): boolean {
  return round.terminal
    && ["done_by_agent", "done", "accepted"].includes(round.status)
    && round.verification_status === "passed"
    && round.fail_checks.length === 0;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizeWorktree(value: TaskLineageWorktree | undefined): TaskLineageWorktree {
  if (!value) {
    return {
      isolation_mode: "current_repo",
      cleanup: "keep",
      status: "not_used",
      next_action: "none",
    };
  }
  return {
    isolation_mode: value.isolation_mode === "worktree" ? "worktree" : "current_repo",
    worktree_id: value.worktree_id ? truncate(String(value.worktree_id), 120) : undefined,
    worktree_path: value.worktree_path ? truncate(String(value.worktree_path), 260) : undefined,
    branch: value.branch ? truncate(String(value.branch), 160) : undefined,
    requested_base_branch: value.requested_base_branch ? truncate(String(value.requested_base_branch), 160) : undefined,
    cleanup: value.cleanup,
    status: value.status,
    next_action: truncate(String(value.next_action || "review_worktree"), 240),
  };
}

function formatWorktree(value: TaskLineageWorktree | undefined): string {
  const worktree = normalizeWorktree(value);
  if (worktree.isolation_mode !== "worktree") return "not used";
  const id = worktree.worktree_id || "unknown";
  const status = worktree.status || "unknown";
  const branch = worktree.branch ? ` branch=${worktree.branch}` : "";
  return `${id} status=${status}${branch}`;
}

function formatAgentRouting(value: TaskLineageAgentRouting | undefined): string {
  if (!value) return "not recorded";
  const requested = value.requested_agent ? ` requested=${value.requested_agent}` : "";
  return `${value.selected_agent}${requested} reason=${truncate(value.reason, 160)}`;
}

function normalizeDirectSessions(value: Array<string | TaskLineageDirectSession>): TaskLineageDirectSession[] {
  return value.map((entry) => {
    if (typeof entry === "string") return { session_id: entry };
    return {
      session_id: String(entry.session_id || ""),
      status: entry.status,
      command_count: entry.command_count,
      passed_commands: entry.passed_commands,
      failed_commands: entry.failed_commands,
      timed_out_commands: entry.timed_out_commands,
      audit_decision: entry.audit_decision,
      changed_files_total: entry.changed_files_total,
      next_action: entry.next_action ? truncate(String(entry.next_action), 240) : undefined,
    };
  }).filter((entry) => entry.session_id !== "");
}

function formatDirectSessions(value: Array<string | TaskLineageDirectSession>): string {
  const sessions = normalizeDirectSessions(value);
  if (sessions.length === 0) return "none";
  return sessions.map((entry) => {
    const status = entry.status ? ` status=${entry.status}` : "";
    const audit = entry.audit_decision ? ` audit=${entry.audit_decision}` : "";
    return `${entry.session_id}${status}${audit}`;
  }).join(", ");
}

function normalizeMaxItems(value: number | undefined): number {
  if (value === undefined) return 8;
  if (!Number.isInteger(value) || value < 1 || value > 50) {
    throw new Error("max_items must be an integer from 1 to 50.");
  }
  return value;
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}...`;
}
