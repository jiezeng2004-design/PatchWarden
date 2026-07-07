import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getConfig } from "../config.js";
import { guardReadPath, guardWorkspacePath } from "../security/pathGuard.js";
import { redactSensitiveValue } from "../security/contentRedaction.js";
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
  const safePack = redactSensitiveValue({
    evidence_pack_id: `evidence_${lineageId}`,
    lineage_id: lineageId,
    generated_at: generatedAt,
    path: packDir,
    files: {
      json: join(packDir, "evidence.json"),
      markdown: join(packDir, "EVIDENCE.md"),
    },
    lineage,
    policy: {
      valid: policySummary.valid,
      issue_count: policySummary.issues.length,
      release_readiness: policySummary.release_readiness,
    },
    catalog,
    omitted: ["stdout", "stderr", "diff", "verification command logs", "full artifact markdown", "sensitive file contents"],
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
    "## Omitted",
    ...pack.omitted.map((item) => `- ${item}`),
    "",
    `Next action: ${pack.next_action}`,
    "",
  ].join("\n");
}
