import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getConfig } from "../config.js";
import { guardReadPath, guardWorkspacePath } from "../security/pathGuard.js";
import { countRedactionsByCategory, redactSensitiveValue } from "../security/contentRedaction.js";
import { getProjectPolicySummary } from "../policy/projectPolicy.js";
import { getTaskLineage, type SafeTaskLineage } from "./taskLineage.js";
import { getLastToolCatalogSnapshot } from "./toolCatalog.js";
import { PATCHWARDEN_VERSION, TOOL_SCHEMA_EPOCH } from "../version.js";
import { PatchWardenError } from "../errors.js";

export interface SafeEvidencePack {
  evidence_pack_id: string;
  lineage_id: string;
  generated_at: string;
  path: string;
  files: {
    json: string;
    markdown: string;
    risk: string;
    verify: string;
    diffstat: string;
    lineage: string;
    attestation: string;
    redactions: string;
  };
  lineage: SafeTaskLineage;
  policy: {
    valid: boolean;
    issue_count: number;
    release_readiness: unknown;
  };
  catalog: {
    server_version: string;
    schema_epoch: string;
    tool_profile: string | null;
    tool_count: number | null;
    tool_manifest_sha256: string | null;
  };
  omitted: string[];
  next_action: string;
  bounded: true;
}

export function exportTaskEvidencePack(input: { lineage_id: string; max_items?: number }): SafeEvidencePack {
  const lineageId = normalizeLineageId(input.lineage_id);
  const maxItems = normalizeMaxItems(input.max_items);
  const config = getConfig();
  const lineage = getTaskLineage(lineageId, { max_items: maxItems });
  const packDir = resolve(config.workspaceRoot, ".patchwarden", "evidence-packs", lineageId);
  guardWorkspacePath(packDir, config.workspaceRoot);
  mkdirSync(packDir, { recursive: true });

  const policySummary = readPolicySummary(lineage.repo_path);
  const catalog = safeCatalog();
  const generatedAt = new Date().toISOString();

  const filePaths = {
    json: join(packDir, "evidence.json"),
    markdown: join(packDir, "EVIDENCE.md"),
    risk: join(packDir, "risk.json"),
    verify: join(packDir, "verify.json"),
    diffstat: join(packDir, "diffstat.json"),
    lineage: join(packDir, "lineage.json"),
    attestation: join(packDir, "attestation.json"),
    redactions: join(packDir, "redactions.json"),
  };

  // Build v2 structured artifact contents (raw, before redaction).
  const riskContent = buildRiskContent(lineage);
  const verifyContent = buildVerifyContent(lineage);
  const diffstatContent = buildDiffstatContent(lineage, config);
  const lineageSummary = buildLineageSummary(lineage);
  const attestationContent = buildAttestation(catalog, generatedAt);

  // Count redactions across all v2 raw contents for the audit trail.
  const v2RawPayloads = [
    riskContent,
    verifyContent,
    diffstatContent,
    lineageSummary,
    attestationContent,
  ].map((value) => JSON.stringify(value));
  const aggregated = new Map<string, { category: string; reason: string; count: number }>();
  for (const raw of v2RawPayloads) {
    for (const entry of countRedactionsByCategory(raw)) {
      const existing = aggregated.get(entry.category);
      if (existing) existing.count += entry.count;
      else aggregated.set(entry.category, { category: entry.category, reason: entry.reason, count: entry.count });
    }
  }
  const redactionsList = [...aggregated.values()];
  const redactionsContent = {
    redactions: redactionsList,
    total_redacted: redactionsList.reduce((sum, entry) => sum + entry.count, 0),
    bounded: true,
    note: "Only categories and counts are recorded; original secret values are never persisted.",
  };

  // Redact and write each v2 file.
  writeFileSync(filePaths.risk, JSON.stringify(redactSensitiveValue(riskContent).value, null, 2) + "\n", "utf-8");
  writeFileSync(filePaths.verify, JSON.stringify(redactSensitiveValue(verifyContent).value, null, 2) + "\n", "utf-8");
  writeFileSync(filePaths.diffstat, JSON.stringify(redactSensitiveValue(diffstatContent).value, null, 2) + "\n", "utf-8");
  writeFileSync(filePaths.lineage, JSON.stringify(redactSensitiveValue(lineageSummary).value, null, 2) + "\n", "utf-8");
  writeFileSync(filePaths.attestation, JSON.stringify(redactSensitiveValue(attestationContent).value, null, 2) + "\n", "utf-8");
  writeFileSync(filePaths.redactions, JSON.stringify(redactSensitiveValue(redactionsContent).value, null, 2) + "\n", "utf-8");

  const safePack = redactSensitiveValue({
    evidence_pack_id: `evidence_${lineageId}`,
    lineage_id: lineageId,
    generated_at: generatedAt,
    path: packDir,
    files: filePaths,
    lineage,
    policy: {
      valid: policySummary.valid,
      issue_count: policySummary.issues.length,
      release_readiness: policySummary.release_readiness,
    },
    catalog,
    omitted: [
      "stdout",
      "stderr",
      "diff",
      "verification command logs",
      "full artifact markdown",
      "sensitive file contents",
      "raw secret values (redactions.json stores only categories and counts)",
      "full diff content (diffstat.json stores only file-level line counts)",
    ],
    next_action: buildNextAction(lineage),
    bounded: true,
  }).value as SafeEvidencePack;

  writeFileSync(safePack.files.json, JSON.stringify(safePack, null, 2) + "\n", "utf-8");
  writeFileSync(safePack.files.markdown, buildEvidenceMarkdown(safePack), "utf-8");
  return safePack;
}

export function listEvidencePacks(options: { max_items?: number } = {}): { evidence_packs: SafeEvidencePack[]; total: number; truncated: boolean } {
  const maxItems = normalizeMaxItems(options.max_items);
  const config = getConfig();
  const root = resolve(config.workspaceRoot, ".patchwarden", "evidence-packs");
  guardWorkspacePath(root, config.workspaceRoot);
  if (!existsSync(root)) return { evidence_packs: [], total: 0, truncated: false };
  const packs = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readEvidencePack(entry.name))
    .filter((entry): entry is SafeEvidencePack => entry !== null)
    .sort((a, b) => b.generated_at.localeCompare(a.generated_at));
  return {
    evidence_packs: packs.slice(0, maxItems),
    total: packs.length,
    truncated: packs.length > maxItems,
  };
}

export function readEvidencePack(lineageId: string): SafeEvidencePack | null {
  const safeLineageId = normalizeLineageId(lineageId);
  const config = getConfig();
  const filePath = resolve(config.workspaceRoot, ".patchwarden", "evidence-packs", safeLineageId, "evidence.json");
  guardReadPath(filePath, config.workspaceRoot, ".patchwarden/evidence-packs");
  if (!existsSync(filePath)) return null;
  const raw = readFileSync(filePath, "utf-8").replace(/^\uFEFF/, "");
  return redactSensitiveValue(JSON.parse(raw)).value as SafeEvidencePack;
}

function normalizeLineageId(value: string): string {
  const lineageId = String(value || "").trim();
  if (!/^[A-Za-z0-9_-]+$/.test(lineageId)) {
    throw new PatchWardenError(
      "invalid_lineage_id",
      "lineage_id may contain only letters, numbers, underscores, and hyphens.",
      "Pass a lineage_id returned by run_task_loop.",
      true,
      { lineage_id: lineageId }
    );
  }
  return lineageId;
}

function normalizeMaxItems(value: number | undefined): number {
  if (value === undefined) return 12;
  if (!Number.isInteger(value) || value < 1 || value > 50) {
    throw new Error("max_items must be an integer from 1 to 50.");
  }
  return value;
}

function readPolicySummary(repoPath: string): { valid: boolean; issues: unknown[]; release_readiness: unknown } {
  try {
    const policy = getProjectPolicySummary(repoPath || ".");
    return {
      valid: Boolean(policy.valid),
      issues: Array.isArray(policy.issues) ? policy.issues : [],
      release_readiness: policy.release_readiness || null,
    };
  } catch (err) {
    return {
      valid: false,
      issues: [{ code: "policy_unavailable", message: err instanceof Error ? err.message : String(err) }],
      release_readiness: null,
    };
  }
}

function safeCatalog(): SafeEvidencePack["catalog"] {
  try {
    const catalog = getLastToolCatalogSnapshot();
    if (!catalog) throw new Error("catalog snapshot unavailable");
    return {
      server_version: catalog.server_version,
      schema_epoch: catalog.schema_epoch,
      tool_profile: catalog.tool_profile,
      tool_count: catalog.tool_count,
      tool_manifest_sha256: catalog.tool_manifest_sha256,
    };
  } catch {
    return {
      server_version: PATCHWARDEN_VERSION,
      schema_epoch: TOOL_SCHEMA_EPOCH,
      tool_profile: null,
      tool_count: null,
      tool_manifest_sha256: null,
    };
  }
}

function buildNextAction(lineage: SafeTaskLineage): string {
  if (lineage.stop_reason === "success") return "Use this evidence pack for review or release readiness.";
  return lineage.next_action || "Review lineage before exporting release evidence.";
}

type RiskSeverity = "high" | "medium" | "low";

interface RiskItem {
  source: string;
  task_id?: string;
  severity: RiskSeverity;
  category: string;
  detail: string;
}

function buildRiskContent(lineage: SafeTaskLineage): { risks: RiskItem[]; count: number; by_severity: Record<RiskSeverity, number> } {
  const risks: RiskItem[] = [];
  for (const round of lineage.rounds) {
    for (const check of round.fail_checks) {
      risks.push({ source: "round", task_id: round.task_id, severity: "high", category: "fail_check", detail: check });
    }
    for (const check of round.warn_checks) {
      risks.push({ source: "round", task_id: round.task_id, severity: "medium", category: "warn_check", detail: check });
    }
  }
  for (const warning of lineage.warnings) {
    risks.push({ source: "lineage", severity: "low", category: "warning", detail: warning });
  }
  const by_severity: Record<RiskSeverity, number> = {
    high: risks.filter((risk) => risk.severity === "high").length,
    medium: risks.filter((risk) => risk.severity === "medium").length,
    low: risks.filter((risk) => risk.severity === "low").length,
  };
  return { risks, count: risks.length, by_severity };
}

interface VerifyRecord {
  source: string;
  task_id?: string;
  role?: string;
  session_id?: string;
  verification_status: string;
  audit_verdict: string;
  passed: boolean;
  command_count?: number;
  passed_commands?: number;
  failed_commands?: number;
}

function buildVerifyContent(lineage: SafeTaskLineage): {
  records: VerifyRecord[];
  count: number;
  summary: { total: number; passed: number; failed: number };
  latest_status: string;
  overall_passed: boolean;
} {
  const records: VerifyRecord[] = [];
  for (const round of lineage.rounds) {
    records.push({
      source: "round",
      task_id: round.task_id,
      role: round.role,
      verification_status: round.verification_status,
      audit_verdict: round.audit_verdict,
      passed: round.verification_status === "passed",
    });
  }
  for (const session of lineage.tasks.direct_sessions) {
    records.push({
      source: "direct_session",
      session_id: session.session_id,
      verification_status: session.status || "unknown",
      audit_verdict: session.audit_decision || "not_run",
      passed: session.status === "passed",
      command_count: session.command_count,
      passed_commands: session.passed_commands,
      failed_commands: session.failed_commands,
    });
  }
  const passed = records.filter((record) => record.passed).length;
  return {
    records,
    count: records.length,
    summary: { total: records.length, passed, failed: records.length - passed },
    latest_status: lineage.verification.latest_status,
    overall_passed: lineage.verification.passed,
  };
}

interface DiffstatFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  task_id: string;
}

function buildDiffstatContent(
  lineage: SafeTaskLineage,
  config: ReturnType<typeof getConfig>
): { files: DiffstatFile[]; count: number; totals: { additions: number; deletions: number } } {
  const taskIds = [
    lineage.tasks.main,
    ...lineage.tasks.fix,
    ...lineage.tasks.cleanup,
  ].filter((id): id is string => Boolean(id));

  const files: DiffstatFile[] = [];
  let totalAdditions = 0;
  let totalDeletions = 0;

  for (const taskId of taskIds) {
    if (!/^[A-Za-z0-9_-]+$/.test(taskId)) continue;
    const statsPath = resolve(config.workspaceRoot, config.tasksDir, taskId, "file-stats.json");
    try {
      guardWorkspacePath(statsPath, config.workspaceRoot);
      if (!existsSync(statsPath)) continue;
      const raw = readFileSync(statsPath, "utf-8").replace(/^\uFEFF/, "");
      const stats = JSON.parse(raw) as { files?: Array<{ path?: unknown; status?: unknown; additions?: unknown; deletions?: unknown }> };
      if (!Array.isArray(stats.files)) continue;
      for (const file of stats.files) {
        const additions = Number(file.additions) || 0;
        const deletions = Number(file.deletions) || 0;
        files.push({
          path: String(file.path || ""),
          status: String(file.status || "unknown"),
          additions,
          deletions,
          task_id: taskId,
        });
        totalAdditions += additions;
        totalDeletions += deletions;
      }
    } catch {
      // Skip unreadable or malformed file-stats.json entries.
    }
  }

  return {
    files,
    count: files.length,
    totals: { additions: totalAdditions, deletions: totalDeletions },
  };
}

function buildLineageSummary(lineage: SafeTaskLineage): {
  lineage_id: string;
  goal: string;
  final_status: string;
  stop_reason: string;
  iterations_count: number;
  task_counts: { main: number; fix: number; cleanup: number; direct_sessions: number };
  verification: { latest_status: string; passed: boolean };
  worktree: { isolation_mode: string; status: string };
  agent_routing: { selected_agent: string } | null;
  warnings_count: number;
  errors_count: number;
  truncated: boolean;
} {
  return {
    lineage_id: lineage.lineage_id,
    goal: lineage.goal,
    final_status: lineage.final_status,
    stop_reason: lineage.stop_reason,
    iterations_count: lineage.rounds.length,
    task_counts: {
      main: lineage.tasks.main ? 1 : 0,
      fix: lineage.tasks.fix.length,
      cleanup: lineage.tasks.cleanup.length,
      direct_sessions: lineage.tasks.direct_sessions.length,
    },
    verification: lineage.verification,
    worktree: {
      isolation_mode: lineage.worktree.isolation_mode,
      status: lineage.worktree.status,
    },
    agent_routing: lineage.agent_routing ? { selected_agent: lineage.agent_routing.selected_agent } : null,
    warnings_count: lineage.warnings.length,
    errors_count: lineage.errors.length,
    truncated: lineage.truncated,
  };
}

function readGitCommitShort(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf-8", timeout: 5000 }).trim();
  } catch {
    return "unknown";
  }
}

function buildAttestation(
  catalog: SafeEvidencePack["catalog"],
  generatedAt: string
): {
  patchwarden_version: string;
  package_version: string;
  commit: string;
  node_version: string;
  os: { platform: string; arch: string };
  tool_profile: string | null;
  schema_epoch: string;
  generated_at: string;
} {
  return {
    patchwarden_version: PATCHWARDEN_VERSION,
    package_version: PATCHWARDEN_VERSION,
    commit: readGitCommitShort(),
    node_version: process.version,
    os: { platform: process.platform, arch: process.arch },
    tool_profile: catalog.tool_profile,
    schema_epoch: catalog.schema_epoch,
    generated_at: generatedAt,
  };
}

function buildEvidenceMarkdown(pack: SafeEvidencePack): string {
  const direct = pack.lineage.tasks.direct_sessions
    .map((entry) => `- ${entry.session_id}: status=${entry.status || "unknown"}, audit=${entry.audit_decision || "unknown"}`)
    .join("\n");
  const rounds = pack.lineage.rounds
    .map((round) => `- ${round.role} ${round.task_id}: status=${round.status}, verification=${round.verification_status}, audit=${round.audit_verdict}`)
    .join("\n");
  return [
    "# PatchWarden Evidence Pack",
    "",
    `- Evidence pack: ${pack.evidence_pack_id}`,
    `- Lineage: ${pack.lineage_id}`,
    `- Generated: ${pack.generated_at}`,
    `- Final status: ${pack.lineage.final_status}`,
    `- Stop reason: ${pack.lineage.stop_reason}`,
    `- Worktree: ${pack.lineage.worktree.isolation_mode} (${pack.lineage.worktree.status})`,
    `- Tool manifest: ${pack.catalog.tool_manifest_sha256 || "unavailable"}`,
    "",
    "## Verification Rounds",
    rounds || "- None.",
    "",
    "## Direct Evidence",
    direct || "- None.",
    "",
    "## Policy And Release",
    `- Policy valid: ${pack.policy.valid}`,
    `- Policy issue count: ${pack.policy.issue_count}`,
    "",
    "## Evidence Pack v2 Files",
    "- `evidence.json` — full bounded evidence pack (machine-readable).",
    "- `EVIDENCE.md` — human-readable evidence summary.",
    "- `risk.json` — aggregated risk items with severity (high/medium/low).",
    "- `verify.json` — structured verification records per round and direct session.",
    "- `diffstat.json` — file-level additions/deletions without full diff content.",
    "- `lineage.json` — bounded lineage summary (goal, status, task counts).",
    "- `attestation.json` — version, commit, Node/OS, tool profile, schema epoch.",
    "- `redactions.json` — redaction categories and counts (no original secret values).",
    "",
    "## Omitted",
    ...pack.omitted.map((item) => `- ${item}`),
    "",
    `Next action: ${pack.next_action}`,
    "",
  ].join("\n");
}
