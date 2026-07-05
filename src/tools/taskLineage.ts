import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getConfig } from "../config.js";
import { guardReadPath } from "../security/pathGuard.js";
import { redactSensitiveValue } from "../security/contentRedaction.js";
import { PatchWardenError } from "../errors.js";

export type TaskLoopStopReason =
  | "success"
  | "max_iterations_reached"
  | "verification_failed"
  | "high_risk_blocked"
  | "user_confirmation_required"
  | "agent_timeout"
  | "policy_blocked"
  | "watcher_blocked"
  | "direct_profile_disabled"
  | "direct_verification_failed"
  | "direct_audit_failed";

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
  fail_checks: string[];
  warn_checks: string[];
  next_action: string;
}

export interface TaskLineageRecord {
  lineage_id: string;
  goal: string;
  repo_path: string;
  created_at: string;
  updated_at: string;
  final_status: "accepted" | "needs_fix" | "blocked" | "failed";
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
}

export interface SafeTaskLineage {
  lineage_id: string;
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
  verification: {
    latest_status: string;
    passed: boolean;
  };
  rounds: TaskLineageRound[];
  warnings: string[];
  errors: string[];
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
  const safeRecord = redactSensitiveValue(record).value as TaskLineageRecord;
  writeFileSync(join(lineageDir, "lineage.json"), JSON.stringify(safeRecord, null, 2) + "\n", "utf-8");
  writeFileSync(join(lineageDir, "SUMMARY.md"), buildSummaryMarkdown(safeRecord), "utf-8");
  return toSafeTaskLineage(safeRecord);
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
  const raw = readFileSync(lineageFile, "utf-8").replace(/^\uFEFF/, "");
  const record = JSON.parse(raw) as TaskLineageRecord;
  return toSafeTaskLineage(redactSensitiveValue(record).value as TaskLineageRecord, maxItems);
}

export function toSafeTaskLineage(record: TaskLineageRecord, maxItems = 8): SafeTaskLineage {
  const rounds = record.rounds.slice(0, maxItems);
  const latest = record.rounds[record.rounds.length - 1];
  const directSessions = normalizeDirectSessions(record.direct_sessions);
  return {
    lineage_id: record.lineage_id,
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
    verification: {
      latest_status: latest?.verification_status || "not_available",
      passed: latest?.verification_status === "passed",
    },
    rounds,
    warnings: record.warnings.slice(0, maxItems).map((value) => truncate(value, 240)),
    errors: record.errors.slice(0, maxItems).map((value) => truncate(value, 240)),
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
    `- ${round.role} ${round.task_id}: ${round.status}, verification=${round.verification_status}, audit=${round.audit_verdict}`
  );
  return [
    "# PatchWarden Task Lineage",
    "",
    `- Lineage: ${record.lineage_id}`,
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
