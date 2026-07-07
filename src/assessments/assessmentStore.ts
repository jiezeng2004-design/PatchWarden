import {
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  renameSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { resolve, join } from "node:path";
import { getAssessmentsDir, getConfig, getRepoAllowedTestCommands, PatchWardenConfig } from "../config.js";
import { guardPath } from "../security/pathGuard.js";
import { PatchWardenError } from "../errors.js";
import { TOOL_SCHEMA_EPOCH } from "../version.js";
import { getLastToolCatalogSnapshot } from "../tools/toolCatalog.js";
import { captureRepoSnapshot, type RepoSnapshot } from "../runner/changeCapture.js";
import type { RiskAssessmentResult } from "../security/riskEngine.js";
import type { TaskTemplateName, ChangePolicy } from "../tools/taskTemplates.js";

const SENSITIVE_PATH_RULES_SIGNATURE = "v1";
const ARTIFACT_RULES_SIGNATURE = "v1";

export interface AgentAssessmentSummary {
  attempted: boolean;
  status: "completed" | "timed_out" | "non_zero_exit" | "parse_failed" | "read_only_violation" | "spawn_failed" | "not_run";
  output: AgentAssessmentOutput | null;
  merged_risk: "low" | "medium" | "high";
  merged_decision: "allow" | "needs_confirm" | "blocked";
  merged_reason_codes: string[];
  timed_out: boolean;
  exit_code: number | null;
  read_only_violation: boolean;
  violation_files: string[];
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  log_paths: {
    stdout: string;
    stderr: string;
    assessment: string;
    prompt?: string;
    violation?: string;
  };
}

export interface AgentAssessmentOutput {
  risk_level: "low" | "medium" | "high";
  reason_codes: string[];
  affected_paths: string[];
  destructive_actions: string[];
  requires_user_confirm: boolean;
  confidence: number;
  notes: string;
  assessed_at: string;
}

export interface AssessmentRecord {
  assessment_id: string;
  assessment_short_id: string;
  decision: "allow" | "needs_confirm" | "blocked";
  risk_level: "low" | "medium" | "high";
  risk_hints: string[];
  hard_rule_hits: string[];
  reason_codes: string[];
  plan_hash: string | null;
  plan_id: string | null;
  policy_hash: string;
  tool_manifest_sha256: string;
  workspace_fingerprint: string;
  workspace_snapshot_summary: {
    head: string | null;
    file_count: number;
    workspace_dirty: boolean;
    snapshot_truncated: boolean;
  };
  expires_at: string;
  created_at: string;
  repo_path: string;
  resolved_repo_path: string;
  template?: TaskTemplateName | null;
  goal?: string | null;
  test_command?: string | null;
  verify_commands?: string[];
  agent: string;
  timeout_seconds?: number;
  change_policy?: ChangePolicy;
  requires_confirm: boolean;
  confirmed: boolean;
  confirmed_at: string | null;
  confirm_code: string | null;
  agent_assessment_summary?: AgentAssessmentSummary | null;
}

export interface AssessmentCreateInput {
  decision: RiskAssessmentResult["decision"];
  risk_level: RiskAssessmentResult["risk_level"];
  risk_hints: string[];
  hard_rule_hits: string[];
  reason_codes: string[];
  repo_path: string;
  resolved_repo_path: string;
  plan_id: string | null;
  plan_content: string | null;
  template?: TaskTemplateName | null;
  goal?: string | null;
  test_command?: string | null;
  verify_commands?: string[];
  agent: string;
  timeout_seconds?: number;
  change_policy?: ChangePolicy;
  snapshot: RepoSnapshot;
  assessment_id?: string;
  assessment_dir?: string;
  agent_assessment_summary?: AgentAssessmentSummary | null;
}

export interface AssessmentValidationResult {
  valid: boolean;
  failure_reason: string | null;
  assessment: AssessmentRecord | null;
}

export interface AssessmentConfirmationResult {
  assessment_id: string;
  decision: "needs_confirm";
  confirmed: true;
  confirmed_at: string;
  expires_at: string;
  next_action: string;
}

interface AssessmentValidationOptions {
  allow_unconfirmed?: boolean;
  skip_tool_manifest?: boolean;
}

export function generateAssessmentId(): string {
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "_").slice(0, 15);
  const randomHex = randomBytes(16).toString("hex");
  return `assessment_${timestamp}_${randomHex}`;
}

export function createAssessmentDir(assessmentId: string): string {
  const config = getConfig();
  const assessmentsDir = getAssessmentsDir(config);
  guardPath(assessmentsDir, config.workspaceRoot, config.assessmentsDir);
  mkdirSync(assessmentsDir, { recursive: true });
  const dir = resolve(assessmentsDir, assessmentId);
  guardPath(dir, config.workspaceRoot, config.assessmentsDir);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function createAssessment(input: AssessmentCreateInput): AssessmentRecord {
  const config = getConfig();

  const assessmentId = input.assessment_id || generateAssessmentId();
  const randomHex = assessmentId.split("_").pop() || "";
  const dir = input.assessment_dir || createAssessmentDir(assessmentId);

  const planHash = input.plan_content
    ? createHash("sha256").update(input.plan_content).digest("hex")
    : null;

  const toolManifest = getLastToolCatalogSnapshot()?.tool_manifest_sha256 || computeFallbackManifestHash(config);

  const workspaceFingerprint = computeWorkspaceFingerprint(input.snapshot);
  const snapshotTruncated = input.snapshot.warnings.some((w) => w.includes("snapshot limited"));

  const policyHash = computePolicyHash({
    change_policy: input.change_policy || "repo_scoped_changes",
    template: input.template || null,
    verify_commands: input.verify_commands || [],
    allowed_test_commands: config.allowedTestCommands,
    repo_allowed_test_commands: getRepoAllowedCommands(config, input.resolved_repo_path),
    sensitive_path_rules: SENSITIVE_PATH_RULES_SIGNATURE,
    artifact_rules: ARTIFACT_RULES_SIGNATURE,
    schema_epoch: TOOL_SCHEMA_EPOCH,
  });

  const now = new Date();
  const expiresAt = new Date(now.getTime() + config.assessmentTtlSeconds * 1000).toISOString();

  const record: AssessmentRecord = {
    assessment_id: assessmentId,
    assessment_short_id: randomHex.slice(0, 12),
    decision: input.decision,
    risk_level: input.risk_level,
    risk_hints: input.risk_hints,
    hard_rule_hits: input.hard_rule_hits,
    reason_codes: input.reason_codes,
    plan_hash: planHash,
    plan_id: input.plan_id,
    policy_hash: policyHash,
    tool_manifest_sha256: toolManifest,
    workspace_fingerprint: workspaceFingerprint,
    workspace_snapshot_summary: {
      head: input.snapshot.head,
      file_count: Object.keys(input.snapshot.files).length,
      workspace_dirty: input.snapshot.workspace_dirty,
      snapshot_truncated: snapshotTruncated,
    },
    expires_at: expiresAt,
    created_at: now.toISOString(),
    repo_path: input.repo_path,
    resolved_repo_path: input.resolved_repo_path,
    template: input.template || null,
    goal: input.goal || null,
    test_command: input.test_command || null,
    verify_commands: input.verify_commands || [],
    agent: input.agent,
    timeout_seconds: input.timeout_seconds,
    change_policy: input.change_policy || "repo_scoped_changes",
    requires_confirm: input.decision === "needs_confirm",
    confirmed: false,
    confirmed_at: null,
    confirm_code: null,
    agent_assessment_summary: input.agent_assessment_summary || null,
  };

  writeFileSync(join(dir, "assessment.json"), JSON.stringify(record, null, 2), "utf-8");

  return record;
}

export function readAssessment(assessmentId: string): AssessmentRecord {
  const config = getConfig();
  const assessmentsDir = getAssessmentsDir(config);
  const dir = resolve(assessmentsDir, assessmentId);
  const file = join(dir, "assessment.json");
  guardPath(file, config.workspaceRoot, config.assessmentsDir);
  if (!existsSync(file)) {
    throw new PatchWardenError(
      "assessment_not_found",
      `Assessment "${assessmentId}" not found.`,
      "Call create_task with execution_mode=assess_only first to get a valid assessment_id.",
      true,
      { assessment_id: assessmentId }
    );
  }
  return JSON.parse(readFileSync(file, "utf-8")) as AssessmentRecord;
}

export function validateAssessmentFreshness(
  assessmentId: string,
  currentSnapshot: RepoSnapshot,
  options: AssessmentValidationOptions = {}
): AssessmentValidationResult {
  let assessment: AssessmentRecord;
  try {
    assessment = readAssessment(assessmentId);
  } catch (e) {
    return { valid: false, failure_reason: extractReason(e), assessment: null };
  }

  if (new Date(assessment.expires_at) < new Date()) {
    return { valid: false, failure_reason: "assessment_expired", assessment };
  }

  if (assessment.plan_id && assessment.plan_hash) {
    const config = getConfig();
    const planFile = resolve(
      config.workspaceRoot,
      config.plansDir,
      assessment.plan_id,
      "plan.md"
    );
    if (!existsSync(planFile)) {
      return { valid: false, failure_reason: "assessment_plan_file_missing", assessment };
    }
    const currentPlanHash = createHash("sha256")
      .update(readFileSync(planFile, "utf-8"))
      .digest("hex");
    if (currentPlanHash !== assessment.plan_hash) {
      return { valid: false, failure_reason: "assessment_stale_plan", assessment };
    }
  }

  if (!options.skip_tool_manifest) {
    const currentManifest = getLastToolCatalogSnapshot()?.tool_manifest_sha256 ||
      computeFallbackManifestHash(getConfig());
    if (currentManifest !== assessment.tool_manifest_sha256) {
      return { valid: false, failure_reason: "assessment_stale_config", assessment };
    }
  }

  const currentFingerprint = computeWorkspaceFingerprint(currentSnapshot);
  if (currentFingerprint !== assessment.workspace_fingerprint) {
    return { valid: false, failure_reason: "assessment_workspace_changed", assessment };
  }

  const config = getConfig();
  const currentPolicyHash = computePolicyHash({
    change_policy: assessment.change_policy || "repo_scoped_changes",
    template: assessment.template || null,
    verify_commands: assessment.verify_commands || [],
    allowed_test_commands: config.allowedTestCommands,
    repo_allowed_test_commands: getRepoAllowedCommands(config, assessment.resolved_repo_path),
    sensitive_path_rules: SENSITIVE_PATH_RULES_SIGNATURE,
    artifact_rules: ARTIFACT_RULES_SIGNATURE,
    schema_epoch: TOOL_SCHEMA_EPOCH,
  });
  if (currentPolicyHash !== assessment.policy_hash) {
    return { valid: false, failure_reason: "assessment_stale_policy", assessment };
  }

  if (assessment.requires_confirm && !assessment.confirmed && !options.allow_unconfirmed) {
    return { valid: false, failure_reason: "assessment_needs_confirm", assessment };
  }

  return { valid: true, failure_reason: null, assessment };
}

/**
 * Records an explicit confirmation performed from the local PatchWarden CLI.
 * This is intentionally not registered as an MCP tool: a remote client may
 * request confirmation, but it cannot grant confirmation to itself.
 */
export function confirmAssessment(assessmentId: string): AssessmentConfirmationResult {
  if (!/^assessment_\d{8}_\d{6}_[0-9a-f]{32}$/.test(assessmentId)) {
    throw new PatchWardenError(
      "assessment_id_invalid",
      "Local confirmation requires the full assessment_id (32 hexadecimal random characters).",
      "Copy the complete assessment_id from the assess_only response; assessment_short_id is display-only."
    );
  }

  const assessment = readAssessment(assessmentId);
  if (assessment.decision !== "needs_confirm" || !assessment.requires_confirm) {
    throw new PatchWardenError(
      "assessment_confirmation_not_allowed",
      `Assessment "${assessmentId}" has decision "${assessment.decision}" and cannot be locally confirmed.`,
      assessment.decision === "blocked"
        ? "Fix the hard-rule finding and run assess_only again."
        : "This assessment does not require confirmation; execute it with the minimal assessment_id call."
    );
  }

  const snapshot = captureRepoSnapshot(assessment.resolved_repo_path);
  const validation = validateAssessmentFreshness(assessmentId, snapshot, {
    allow_unconfirmed: true,
    // A standalone CLI has no active MCP profile snapshot. The execute path
    // still performs the full tool-manifest check before creating the task.
    skip_tool_manifest: true,
  });
  if (!validation.valid || !validation.assessment) {
    throw new PatchWardenError(
      validation.failure_reason || "assessment_validation_failed",
      `Assessment "${assessmentId}" cannot be confirmed: ${validation.failure_reason || "validation_failed"}.`,
      "Run create_task with execution_mode=assess_only again, then confirm the new assessment locally."
    );
  }

  const confirmedAt = validation.assessment.confirmed_at || new Date().toISOString();
  const confirmedRecord: AssessmentRecord = {
    ...validation.assessment,
    confirmed: true,
    confirmed_at: confirmedAt,
    confirm_code: validation.assessment.confirm_code || randomBytes(8).toString("hex"),
  };
  const config = getConfig();
  const assessmentFile = resolve(getAssessmentsDir(config), assessmentId, "assessment.json");
  guardPath(assessmentFile, config.workspaceRoot, config.assessmentsDir);
  const temporaryFile = `${assessmentFile}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  guardPath(temporaryFile, config.workspaceRoot, config.assessmentsDir);
  writeFileSync(temporaryFile, JSON.stringify(confirmedRecord, null, 2), "utf-8");
  renameSync(temporaryFile, assessmentFile);

  return {
    assessment_id: assessmentId,
    decision: "needs_confirm",
    confirmed: true,
    confirmed_at: confirmedAt,
    expires_at: confirmedRecord.expires_at,
    next_action: "Call create_task with only execution_mode=execute and this full assessment_id.",
  };
}

export function computeWorkspaceFingerprint(snapshot: RepoSnapshot): string {
  const fileHashes = Object.entries(snapshot.files)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, fp]) => `${path}:${fp.sha256}`)
    .join("\n");
  return createHash("sha256")
    .update(`${snapshot.head || "null"}\n${snapshot.status}\n${fileHashes}`)
    .digest("hex");
}

interface PolicyHashInput {
  change_policy: ChangePolicy;
  template: TaskTemplateName | null;
  verify_commands: string[];
  allowed_test_commands: string[];
  repo_allowed_test_commands: string[];
  sensitive_path_rules: string;
  artifact_rules: string;
  schema_epoch: string;
}

export function computePolicyHash(input: PolicyHashInput): string {
  const payload = JSON.stringify({
    change_policy: input.change_policy,
    template: input.template,
    verify_commands: [...input.verify_commands].sort(),
    allowed_test_commands: [...input.allowed_test_commands].sort(),
    repo_allowed_test_commands: [...input.repo_allowed_test_commands].sort(),
    sensitive_path_rules: input.sensitive_path_rules,
    artifact_rules: input.artifact_rules,
    schema_epoch: input.schema_epoch,
  });
  return createHash("sha256").update(payload).digest("hex");
}

function getRepoAllowedCommands(config: PatchWardenConfig, repoPath: string): string[] {
  return getRepoAllowedTestCommands(config, repoPath);
}

function computeFallbackManifestHash(config: PatchWardenConfig): string {
  return createHash("sha256")
    .update(`${TOOL_SCHEMA_EPOCH}:${config.toolProfile || "full"}`)
    .digest("hex");
}

function extractReason(error: unknown): string {
  if (error instanceof PatchWardenError) return error.reason;
  if (error instanceof Error) return error.message.slice(0, 80);
  return String(error).slice(0, 80);
}
