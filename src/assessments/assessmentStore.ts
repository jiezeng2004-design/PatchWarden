import {
  mkdirSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { resolve, join } from "node:path";
import { getAssessmentsDir, getConfig, getRepoAllowedTestCommands, PatchWardenConfig } from "../config.js";
import { guardPath } from "../security/pathGuard.js";
import { PatchWardenError } from "../errors.js";
import { redactSensitiveContent } from "../security/contentRedaction.js";
import { atomicWriteJsonFileSync } from "../utils/atomicFile.js";
import { withFileLockSync } from "../utils/lockedJsonFile.js";
import { TOOL_SCHEMA_EPOCH } from "../version.js";
import {
  buildToolCatalogSnapshot,
  resolveToolProfile,
} from "../tools/catalog/toolCatalog.js";
import { getToolDefs } from "../tools/definitions/toolDefs.js";
import { captureRepoSnapshot, type RepoSnapshot } from "../runner/changeCapture.js";
import type { RiskAssessmentResult } from "../security/riskEngine.js";
import type { TaskTemplateName, ChangePolicy } from "../tools/taskTemplates.js";
import { getProjectPolicySummary, type ProjectPolicy } from "../policy/projectPolicy.js";
import {
  ASSESSMENT_SECURITY_SNAPSHOT_VERSION,
  buildAssessmentSecuritySnapshot,
  getAssessmentSecuritySnapshotComponentHashes,
  hashAssessmentSecuritySnapshot,
  type SecuritySnapshotCategory,
} from "./securitySnapshot.js";

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
  execution_config_hash?: string;
  execution_config_component_hashes?: Partial<Record<ExecutionConfigChangeCategory, string>>;
  assessment_security_snapshot_version?: string;
  assessment_security_snapshot_sha256?: string;
  assessment_security_snapshot_component_hashes?: Partial<Record<ExecutionConfigChangeCategory, string>>;
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
  used_at?: string | null;
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
  expected_hash?: string;
  actual_hash?: string;
  config_change_categories?: ExecutionConfigChangeCategory[];
}

export type ExecutionConfigChangeCategory = SecuritySnapshotCategory | "allowed_test_commands" | "execution_config";

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

  const toolManifest = getCurrentToolManifest(config);

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
  const executionConfig = computeExecutionConfigFingerprint(config, {
    agent: input.agent,
    tool_manifest_sha256: toolManifest,
    tool_profile: resolveToolProfile(config.toolProfile),
    repo_path: input.resolved_repo_path,
    change_policy: input.change_policy || "repo_scoped_changes",
    template: input.template || null,
    verify_commands: input.verify_commands || [],
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
    execution_config_hash: executionConfig.hash,
    execution_config_component_hashes: executionConfig.components,
    assessment_security_snapshot_version: ASSESSMENT_SECURITY_SNAPSHOT_VERSION,
    assessment_security_snapshot_sha256: executionConfig.hash,
    assessment_security_snapshot_component_hashes: executionConfig.components,
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
    goal: input.goal ? redactSensitiveContent(input.goal).content : null,
    test_command: input.test_command || null,
    verify_commands: input.verify_commands || [],
    agent: input.agent,
    timeout_seconds: input.timeout_seconds,
    change_policy: input.change_policy || "repo_scoped_changes",
    requires_confirm: input.decision === "needs_confirm",
    confirmed: false,
    confirmed_at: null,
    confirm_code: null,
    used_at: null,
    agent_assessment_summary: input.agent_assessment_summary || null,
  };

  atomicWriteJsonFileSync(join(dir, "assessment.json"), record);

  return record;
}

export function readAssessment(assessmentId: string): AssessmentRecord {
  if (!/^assessment_\d{8}_\d{6}_[0-9a-f]{32}$/.test(assessmentId)) {
    throw new PatchWardenError(
      "assessment_id_invalid",
      "A full assessment_id with 32 hexadecimal random characters is required.",
      "Copy the complete assessment_id from the assess_only response; assessment_short_id is display-only.",
    );
  }
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
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as AssessmentRecord;
    if (!parsed || typeof parsed !== "object" || parsed.assessment_id !== assessmentId) {
      throw new Error("record identity mismatch");
    }
    return parsed;
  } catch (error) {
    throw new PatchWardenError(
      "assessment_corrupted",
      `Assessment "${assessmentId}" cannot be read as a valid record.`,
      "Run create_task with execution_mode=assess_only again.",
      true,
      { assessment_id: assessmentId, failure_category: "invalid_assessment_record" },
    );
  }
}

/** Atomically consume an Assessment before creating its one allowed task. */
export function markAssessmentUsed(assessmentId: string): AssessmentRecord {
  const config = getConfig();
  const assessmentFile = resolve(getAssessmentsDir(config), assessmentId, "assessment.json");
  guardPath(assessmentFile, config.workspaceRoot, config.assessmentsDir);
  return withFileLockSync(assessmentFile, () => {
    const assessment = readAssessment(assessmentId);
    if (assessment.used_at) {
      throw new PatchWardenError(
        "assessment_used",
        `Assessment "${assessmentId}" has already been used.`,
        "Run create_task with execution_mode=assess_only again to obtain a new assessment_id.",
        true,
        { assessment_id: assessmentId, used_at: assessment.used_at },
      );
    }
    const consumed: AssessmentRecord = { ...assessment, used_at: new Date().toISOString() };
    atomicWriteJsonFileSync(assessmentFile, consumed);
    return consumed;
  });
}

export function validateAssessmentFreshness(
  assessmentId: string,
  currentSnapshot: RepoSnapshot,
  options: AssessmentValidationOptions = {}
): AssessmentValidationResult {
  if (!/^assessment_\d{8}_\d{6}_[0-9a-f]{32}$/.test(assessmentId)) {
    return { valid: false, failure_reason: "assessment_id_invalid", assessment: null };
  }
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

  const config = getConfig();
  const currentManifest = getCurrentToolManifest(config);
  if (!options.skip_tool_manifest) {
    // Legacy records need the standalone manifest check. Versioned security
    // snapshots compare the manifest together with the source config, so the
    // diagnostic can report both "tool_manifest" and e.g. "allowed_commands".
    if (currentManifest !== assessment.tool_manifest_sha256 && !assessment.assessment_security_snapshot_sha256) {
      return {
        valid: false,
        failure_reason: "assessment_stale_config",
        assessment,
        expected_hash: assessment.tool_manifest_sha256,
        actual_hash: currentManifest,
        config_change_categories: ["tool_manifest"],
      };
    }
  }

  const currentFingerprint = computeWorkspaceFingerprint(currentSnapshot);
  if (currentFingerprint !== assessment.workspace_fingerprint) {
    return { valid: false, failure_reason: "assessment_workspace_changed", assessment };
  }

  if (assessment.execution_config_hash) {
    const currentExecutionConfig = computeExecutionConfigFingerprint(config, {
      agent: assessment.agent,
      tool_manifest_sha256: currentManifest,
      tool_profile: resolveToolProfile(config.toolProfile),
      repo_path: assessment.resolved_repo_path,
      change_policy: assessment.change_policy || "repo_scoped_changes",
      template: assessment.template || null,
      verify_commands: assessment.verify_commands || [],
    });
    if (
      assessment.assessment_security_snapshot_version
      && assessment.assessment_security_snapshot_version !== ASSESSMENT_SECURITY_SNAPSHOT_VERSION
    ) {
      return {
        valid: false,
        failure_reason: "assessment_snapshot_version_incompatible",
        assessment,
        expected_hash: assessment.execution_config_hash,
        actual_hash: currentExecutionConfig.hash,
        config_change_categories: ["schema_epoch"],
      };
    }
    if (currentExecutionConfig.hash !== assessment.execution_config_hash) {
      const previousComponents = assessment.execution_config_component_hashes;
      const changedCategories = previousComponents
        ? (Object.keys(currentExecutionConfig.components) as ExecutionConfigChangeCategory[])
          .filter((category) => previousComponents[category] !== currentExecutionConfig.components[category])
        : ["execution_config" as const];
      return {
        valid: false,
        failure_reason: "assessment_stale_config",
        assessment,
        expected_hash: assessment.execution_config_hash,
        actual_hash: currentExecutionConfig.hash,
        config_change_categories: changedCategories.length > 0 ? changedCategories : ["execution_config"],
      };
    }
  }

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
export async function confirmAssessment(assessmentId: string): Promise<AssessmentConfirmationResult> {
  if (!/^assessment_\d{8}_\d{6}_[0-9a-f]{32}$/.test(assessmentId)) {
    throw new PatchWardenError(
      "assessment_id_invalid",
      "Local confirmation requires the full assessment_id (32 hexadecimal random characters).",
      "Copy the complete assessment_id from the assess_only response; assessment_short_id is display-only."
    );
  }

  const config = getConfig();
  const assessmentFile = resolve(getAssessmentsDir(config), assessmentId, "assessment.json");
  guardPath(assessmentFile, config.workspaceRoot, config.assessmentsDir);

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

  const snapshot = await captureRepoSnapshot(assessment.resolved_repo_path);

  // Re-read and write while holding one cross-process lock. Concurrent local
  // confirmers may compute snapshots in parallel, but they cannot replace one
  // another's confirmation metadata from a stale assessment record.
  return withFileLockSync(assessmentFile, () => {
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
    if (validation.assessment.decision !== "needs_confirm" || !validation.assessment.requires_confirm) {
      throw new PatchWardenError(
        "assessment_confirmation_not_allowed",
        `Assessment "${assessmentId}" is no longer eligible for local confirmation.`,
        "Run create_task with execution_mode=assess_only again."
      );
    }

    const confirmedAt = validation.assessment.confirmed_at || new Date().toISOString();
    const confirmedRecord: AssessmentRecord = {
      ...validation.assessment,
      confirmed: true,
      confirmed_at: confirmedAt,
      confirm_code: validation.assessment.confirm_code || randomBytes(8).toString("hex"),
    };
    atomicWriteJsonFileSync(assessmentFile, confirmedRecord);

    return {
      assessment_id: assessmentId,
      decision: "needs_confirm",
      confirmed: true,
      confirmed_at: confirmedAt,
      expires_at: confirmedRecord.expires_at,
      next_action: "Call create_task with only execution_mode=execute and this full assessment_id.",
    };
  });
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

function getCurrentToolManifest(config: PatchWardenConfig): string {
  // The catalog cache is process-local. Rebuild the canonical catalog here so
  // MCP and the independent Watcher derive the same manifest across processes.
  const profile = resolveToolProfile(config.toolProfile);
  return buildToolCatalogSnapshot(getToolDefs(), profile).tool_manifest_sha256;
}

interface ExecutionConfigHashInput {
  agent: string;
  tool_manifest_sha256: string;
  tool_profile: string;
  repo_path: string;
  change_policy?: string | null;
  template?: string | null;
  verify_commands?: string[];
}

export function computeExecutionConfigHash(
  config: PatchWardenConfig,
  input: ExecutionConfigHashInput,
): string {
  return computeExecutionConfigFingerprint(config, input).hash;
}

function computeExecutionConfigFingerprint(
  config: PatchWardenConfig,
  input: ExecutionConfigHashInput,
): { hash: string; components: Partial<Record<ExecutionConfigChangeCategory, string>> } {
  let projectPolicy: ProjectPolicy | null = null;
  let projectPolicyValid: boolean | null = null;
  let projectPolicyIssues: Array<{ code: string; severity: string; field: string }> = [];
  try {
    const summary = getProjectPolicySummary(input.repo_path);
    projectPolicy = summary.effective_policy;
    projectPolicyValid = summary.valid;
    projectPolicyIssues = summary.issues.map(({ code, severity, field }) => ({ code, severity, field }));
  } catch {
    // A workspace-root change can make the old repository inaccessible. The
    // workspace_root component still fails closed without exposing the path.
  }
  const snapshot = buildAssessmentSecuritySnapshot({
    config,
    schemaEpoch: TOOL_SCHEMA_EPOCH,
    toolProfile: input.tool_profile,
    toolManifestSha256: input.tool_manifest_sha256,
    agent: input.agent,
    repoPath: input.repo_path,
    changePolicy: input.change_policy,
    template: input.template,
    verifyCommands: input.verify_commands,
    projectPolicy,
    projectPolicyValid,
    projectPolicyIssues,
  });
  return {
    hash: hashAssessmentSecuritySnapshot(snapshot),
    components: getAssessmentSecuritySnapshotComponentHashes(snapshot),
  };
}

function extractReason(error: unknown): string {
  if (error instanceof PatchWardenError) return error.reason;
  if (error instanceof Error) return error.message.slice(0, 80);
  return String(error).slice(0, 80);
}
