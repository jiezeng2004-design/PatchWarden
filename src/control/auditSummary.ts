export type AuditVerdict = "pass" | "warn" | "fail" | "unknown";

export interface AuditCheckCounts {
  pass: number;
  warn: number;
  fail: number;
  total: number;
}

export interface AuditSummaryEntry {
  audit_id: string;
  subject_type: "task" | "direct_session";
  subject_id: string;
  task_id: string | null;
  session_id: string | null;
  source: "audit.json" | "independent-review.md" | "direct-session";
  verdict: AuditVerdict;
  checked_at: string | null;
  summary: string;
  check_counts: AuditCheckCounts;
  findings: string[];
  recommended_actions: string[];
  manual_verification_required: boolean;
  acceptance_status: string | null;
  scope_change_status: "none_detected" | "attention" | "not_reported";
  requires_action: boolean;
  detail_url: string;
}

export interface AuditOverview {
  total: number;
  returned: number;
  truncated: boolean;
  pass: number;
  warn: number;
  fail: number;
  unknown: number;
  needs_action: number;
  manual_verification: number;
  attention_groups: Array<{
    type: "failed" | "warning" | "manual_verification" | "unknown";
    severity: "error" | "warning" | "info";
    count: number;
    subjects: Array<{ id: string; detail_url: string }>;
    recommended_action: string;
  }>;
}

const MAX_TEXT = 500;
const MAX_ITEM_TEXT = 300;
const MAX_ITEMS = 8;

export function summarizeTaskAudit(
  taskId: string,
  data: Record<string, unknown>,
  checkedAt: string | null,
): AuditSummaryEntry {
  const checks = normalizeChecks(data.checks);
  const verdict = normalizeVerdict(data.verdict ?? asRecord(data.acceptance)?.verdict);
  const acceptance = asRecord(data.acceptance);
  const manualItems = stringItems(data.manual_verification_items);
  const findings = uniqueStrings([
    ...checks.filter((check) => check.result === "fail" || check.result === "warn").map(formatCheck),
    ...objectDescriptions(data.risks),
    ...objectDescriptions(data.confirmed_failures),
    ...manualItems,
  ]);
  const actions = normalizeActions(uniqueStrings([
    ...stringItems(data.recommended_next_actions),
    stringValue(acceptance?.next_suggested_task),
  ]), verdict, "task");
  const manual = data.manual_verification_required === true || manualItems.length > 0;
  return {
    audit_id: `task:${taskId}`,
    subject_type: "task",
    subject_id: taskId,
    task_id: taskId,
    session_id: null,
    source: "audit.json",
    verdict,
    checked_at: checkedAt,
    summary: boundedText(stringValue(data.summary) || stringValue(acceptance?.reason) || fallbackSummary(verdict)),
    check_counts: countChecks(checks),
    findings,
    recommended_actions: actions,
    manual_verification_required: manual,
    acceptance_status: stringValue(acceptance?.status) || null,
    scope_change_status: scopeStatus(checks),
    requires_action: verdict === "fail" || verdict === "warn" || manual,
    detail_url: `/pages/task-detail.html?id=${encodeURIComponent(taskId)}`,
  };
}

export function summarizeIndependentReview(
  taskId: string,
  content: string,
  checkedAt: string | null,
): AuditSummaryEntry {
  const verdict = normalizeVerdict(content.match(/\*\*Verdict\*\*\s*:\s*([A-Za-z]+)/i)?.[1]);
  const summarySection = section(content, "Summary");
  const counts = parseMarkdownCounts(summarySection);
  const confirmedFailures = markdownList(section(content, "Confirmed Failures"));
  const risks = markdownList(section(content, "Risks"));
  const manualItems = markdownList(section(content, "Manual Verification Required"))
    .filter((item) => !/no additional manual verification/i.test(item));
  const actions = normalizeActions(markdownList(section(content, "Recommended Actions")), verdict, "task");
  const checksSection = section(content, "Checks");
  const scopeMention = /(?:out[_ -]?of[_ -]?scope|forbidden[_ -]?scope)/i.test(checksSection);
  const scopeAttention = scopeMention && /- \[ \].*(?:out[_ -]?of[_ -]?scope|forbidden[_ -]?scope)/i.test(checksSection);
  const findings = uniqueStrings([...confirmedFailures, ...risks, ...manualItems]);
  return {
    audit_id: `task:${taskId}`,
    subject_type: "task",
    subject_id: taskId,
    task_id: taskId,
    session_id: null,
    source: "independent-review.md",
    verdict,
    checked_at: checkedAt,
    summary: boundedText(stripMarkdown(summarySection) || fallbackSummary(verdict)),
    check_counts: counts,
    findings,
    recommended_actions: actions,
    manual_verification_required: manualItems.length > 0,
    acceptance_status: null,
    scope_change_status: scopeAttention ? "attention" : scopeMention ? "none_detected" : "not_reported",
    requires_action: verdict === "fail" || verdict === "warn" || manualItems.length > 0,
    detail_url: `/pages/task-detail.html?id=${encodeURIComponent(taskId)}`,
  };
}

export function summarizeDirectAudit(
  sessionId: string,
  data: Record<string, unknown>,
  checkedAt: string | null,
): AuditSummaryEntry {
  const verdict = normalizeVerdict(data.decision ?? data.verdict);
  const failures = stringItems(data.blocking_findings);
  const warnings = stringItems(data.warnings);
  const manualItems = stringItems(data.manual_verification_items);
  const manual = data.manual_verification_required === true || manualItems.length > 0;
  const evidence = asRecord(data.evidence);
  const changedFiles = numberValue(evidence?.changed_files_total);
  const findings = uniqueStrings([...failures, ...warnings, ...manualItems]);
  const nextAction = stringValue(data.next_action);
  return {
    audit_id: `direct:${sessionId}`,
    subject_type: "direct_session",
    subject_id: sessionId,
    task_id: null,
    session_id: sessionId,
    source: "direct-session",
    verdict,
    checked_at: checkedAt,
    summary: boundedText(nextAction || fallbackSummary(verdict)),
    check_counts: {
      pass: verdict === "pass" ? 1 : 0,
      warn: warnings.length,
      fail: failures.length,
      total: Math.max(1, failures.length + warnings.length),
    },
    findings,
    recommended_actions: nextAction ? [boundedText(nextAction, MAX_ITEM_TEXT)] : defaultActions(verdict, "direct_session"),
    manual_verification_required: manual,
    acceptance_status: null,
    scope_change_status: changedFiles === null ? "not_reported" : changedFiles > 0 ? "attention" : "none_detected",
    requires_action: verdict === "fail" || verdict === "warn" || manual,
    detail_url: `/pages/direct-sessions.html?id=${encodeURIComponent(sessionId)}`,
  };
}

export function buildAuditOverview(entries: AuditSummaryEntry[], returned: number): AuditOverview {
  const pass = entries.filter((entry) => entry.verdict === "pass").length;
  const warn = entries.filter((entry) => entry.verdict === "warn").length;
  const fail = entries.filter((entry) => entry.verdict === "fail").length;
  const unknown = entries.filter((entry) => entry.verdict === "unknown").length;
  const manual = entries.filter((entry) => entry.manual_verification_required).length;
  const groups: AuditOverview["attention_groups"] = [];
  addGroup(groups, entries.filter((entry) => entry.verdict === "fail"), "failed", "error", "Open the failed audits, fix the confirmed findings, then run acceptance again.");
  addGroup(groups, entries.filter((entry) => entry.verdict === "warn"), "warning", "warning", "Review each warning and its evidence before accepting the result.");
  addGroup(groups, entries.filter((entry) => entry.manual_verification_required), "manual_verification", "warning", "Complete the listed manual checks and record the result before acceptance.");
  addGroup(groups, entries.filter((entry) => entry.verdict === "unknown"), "unknown", "info", "Run audit again to produce a current structured conclusion.");
  return {
    total: entries.length,
    returned,
    truncated: returned < entries.length,
    pass,
    warn,
    fail,
    unknown,
    needs_action: entries.filter((entry) => entry.requires_action).length,
    manual_verification: manual,
    attention_groups: groups,
  };
}

function addGroup(
  groups: AuditOverview["attention_groups"],
  entries: AuditSummaryEntry[],
  type: AuditOverview["attention_groups"][number]["type"],
  severity: AuditOverview["attention_groups"][number]["severity"],
  recommendedAction: string,
): void {
  if (entries.length === 0) return;
  groups.push({
    type,
    severity,
    count: entries.length,
    subjects: entries.slice(0, 12).map((entry) => ({ id: entry.subject_id, detail_url: entry.detail_url })),
    recommended_action: recommendedAction,
  });
}

function normalizeChecks(value: unknown): Array<{ name: string; result: AuditVerdict; detail: string }> {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).flatMap((item) => {
    const record = asRecord(item);
    if (!record) return [];
    return [{
      name: boundedText(stringValue(record.name) || "unnamed_check", 120),
      result: normalizeVerdict(record.result),
      detail: boundedText(stringValue(record.detail), MAX_ITEM_TEXT),
    }];
  });
}

function countChecks(checks: Array<{ result: AuditVerdict }>): AuditCheckCounts {
  return {
    pass: checks.filter((check) => check.result === "pass").length,
    warn: checks.filter((check) => check.result === "warn").length,
    fail: checks.filter((check) => check.result === "fail").length,
    total: checks.length,
  };
}

function parseMarkdownCounts(summary: string): AuditCheckCounts {
  const match = summary.match(/(\d+)\s+pass,\s*(\d+)\s+warn,\s*(\d+)\s+fail\s+across\s+(\d+)\s+checks/i);
  if (!match) return { pass: 0, warn: 0, fail: 0, total: 0 };
  return { pass: Number(match[1]), warn: Number(match[2]), fail: Number(match[3]), total: Number(match[4]) };
}

function section(content: string, name: string): string {
  const lines = content.split(/\r?\n/);
  const heading = `## ${name}`.toLowerCase();
  const start = lines.findIndex((line) => line.trim().toLowerCase() === heading);
  if (start < 0) return "";
  const output: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) break;
    output.push(lines[index]);
  }
  return output.join("\n").trim();
}

function markdownList(value: string): string[] {
  return uniqueStrings(value.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*-\s+(?:\[[^\]]+\]\s*)?(.*)$/);
    if (!match) return [];
    const item = stripMarkdown(match[1]);
    return !item || /^none(?:\.| identified\.)?$/i.test(item) ? [] : [item];
  }));
}

function stripMarkdown(value: string): string {
  return value.replace(/\*\*/g, "").replace(/`/g, "").replace(/\s+/g, " ").trim();
}

function scopeStatus(checks: Array<{ name: string; result: AuditVerdict }>): AuditSummaryEntry["scope_change_status"] {
  const scopeChecks = checks.filter((check) => /scope|out_of_scope/i.test(check.name));
  if (scopeChecks.length === 0) return "not_reported";
  return scopeChecks.some((check) => check.result === "fail" || check.result === "warn") ? "attention" : "none_detected";
}

function objectDescriptions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string") return [boundedText(item, MAX_ITEM_TEXT)];
    const record = asRecord(item);
    if (!record) return [];
    const name = stringValue(record.name) || stringValue(record.check);
    const detail = stringValue(record.detail) || stringValue(record.description) || stringValue(record.reason);
    return [boundedText(name && detail ? `${name}: ${detail}` : detail || name, MAX_ITEM_TEXT)].filter(Boolean);
  });
}

function stringItems(value: unknown): string[] {
  if (!Array.isArray(value)) return typeof value === "string" ? [boundedText(value, MAX_ITEM_TEXT)] : [];
  return value.filter((item): item is string => typeof item === "string").map((item) => boundedText(item, MAX_ITEM_TEXT));
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.trim() !== ""))].slice(0, MAX_ITEMS);
}

function formatCheck(check: { name: string; detail: string }): string {
  return boundedText(check.detail ? `${check.name}: ${check.detail}` : check.name, MAX_ITEM_TEXT);
}

function normalizeVerdict(value: unknown): AuditVerdict {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "pass" || normalized === "accepted") return "pass";
  if (normalized === "warn" || normalized === "warning" || normalized === "needs_fix" || normalized === "blocked") return "warn";
  if (normalized === "fail" || normalized === "failed" || normalized === "rejected") return "fail";
  return "unknown";
}

function defaultActions(verdict: AuditVerdict, type: AuditSummaryEntry["subject_type"]): string[] {
  if (verdict === "pass") return [type === "task" ? "No action required; the task can be accepted." : "No action required; the Direct session can be accepted."];
  if (verdict === "warn") return ["Review the warning evidence before accepting the result."];
  if (verdict === "fail") return ["Fix the confirmed findings and run the audit again."];
  return ["Run the audit again to generate a structured conclusion."];
}

function normalizeActions(
  actions: string[],
  verdict: AuditVerdict,
  type: AuditSummaryEntry["subject_type"],
): string[] {
  const meaningful = verdict === "pass"
    ? actions
    : actions.filter((action) => !/^(?:no specific actions? recommended|no (?:further )?action required)\.?$/i.test(action.trim()));
  return meaningful.length > 0 ? meaningful : defaultActions(verdict, type);
}

function fallbackSummary(verdict: AuditVerdict): string {
  if (verdict === "pass") return "Audit passed with no blocking findings.";
  if (verdict === "warn") return "Audit completed with findings that require review.";
  if (verdict === "fail") return "Audit found blocking issues that must be fixed.";
  return "This legacy audit does not contain a structured conclusion.";
}

function boundedText(value: string, max = MAX_TEXT): string {
  const normalized = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ").replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max)}...` : normalized;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
