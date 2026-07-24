import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { PatchWardenConfig } from "../config.js";
import { getRepoAllowedTestCommands, getRepoDirectAllowedCommands } from "../config.js";
import { stableJsonStringify } from "../utils/stableJson.js";
import type { ProjectPolicy } from "../policy/projectPolicy.js";

/**
 * Version the security snapshot independently from the server/schema version.
 * Changing the fields or their canonicalization should invalidate old records.
 */
export const ASSESSMENT_SECURITY_SNAPSHOT_VERSION = "assessment-security-v2";

export type SecuritySnapshotCategory =
  | "schema_epoch"
  | "tool_profile"
  | "tool_manifest"
  | "workspace_root"
  | "repo_boundary"
  | "agent_launch"
  | "allowed_commands"
  | "repo_allowed_test_commands"
  | "direct_allowed_commands"
  | "repo_direct_allowed_commands"
  | "sensitive_path_rules"
  | "protected_paths"
  | "project_policy"
  | "risk_rules"
  | "confirmation_policy"
  | "task_parameters"
  | "release_protection"
  | "direct_profile"
  | "assessment_ttl"
  | "timeout_policy";

export interface AssessmentSecuritySnapshotInput {
  config: PatchWardenConfig;
  schemaEpoch: string;
  toolProfile: string;
  toolManifestSha256: string;
  agent: string;
  repoPath: string;
  changePolicy?: string | null;
  template?: string | null;
  verifyCommands?: string[];
  testCommand?: string | null;
  taskTimeoutSeconds?: number | null;
  scope?: string[];
  forbidden?: string[];
  verification?: string[];
  doneEvidence?: string[];
  riskRulesVersion?: string;
  projectPolicy?: ProjectPolicy | null;
  projectPolicyValid?: boolean | null;
  projectPolicyIssues?: Array<{ code: string; severity: string; field: string }>;
}

export interface AssessmentSecuritySnapshot {
  assessment_security_snapshot_version: string;
  components: Record<SecuritySnapshotCategory, unknown>;
}

export interface AssessmentSecuritySnapshotComparison {
  equal: boolean;
  expected_hash: string;
  actual_hash: string;
  changed_field_names: SecuritySnapshotCategory[];
}

function canonicalPath(value: string): string {
  const normalized = resolve(String(value)).replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function sortedUnique(values: readonly string[] | undefined): string[] {
  return [...new Set((values || []).map((value) => String(value).trim()))]
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
}

function sortedUniqueTaskPaths(values: readonly string[] | undefined): string[] {
  return sortedUnique(values?.map((value) => {
    const normalized = String(value).replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/{2,}/g, "/");
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  }));
}

function sortedAgentConfig(config: PatchWardenConfig): Record<string, unknown> {
  return Object.fromEntries(Object.entries(config.agents)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, agent]) => [name, {
      command: agent.command,
      args: [...agent.args],
      adapter: agent.adapter || null,
      model: agent.model || null,
      envAllowlist: sortedUnique(agent.envAllowlist),
    }]));
}

/** Build only security-relevant configuration; runtime state is deliberately absent. */
export function buildAssessmentSecuritySnapshot(input: AssessmentSecuritySnapshotInput): AssessmentSecuritySnapshot {
  const { config } = input;
  const repoPath = canonicalPath(input.repoPath);
  const components: Record<SecuritySnapshotCategory, unknown> = {
    schema_epoch: input.schemaEpoch,
    tool_profile: input.toolProfile,
    tool_manifest: input.toolManifestSha256,
    workspace_root: canonicalPath(config.workspaceRoot),
    repo_boundary: {
      workspace_root: canonicalPath(config.workspaceRoot),
      repo_path: repoPath,
      repo_aliases: Object.fromEntries(Object.entries(config.repoAliases || {})
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => [key, canonicalPath(resolve(config.workspaceRoot, value))])),
    },
    agent_launch: {
      selected_agent: input.agent,
      configured_agents: sortedAgentConfig(config),
    },
    allowed_commands: {
      configured: sortedUnique(config.allowedTestCommands),
      project: sortedUnique(input.projectPolicy?.allowed_commands),
    },
    repo_allowed_test_commands: sortedUnique(getRepoAllowedTestCommands(config, repoPath)),
    direct_allowed_commands: sortedUnique(config.directAllowedCommands),
    repo_direct_allowed_commands: sortedUnique(getRepoDirectAllowedCommands(config, repoPath)),
    sensitive_path_rules: "sensitive-path-rules-v1",
    protected_paths: sortedUnique(input.projectPolicy?.protected_paths || [
      ".env", ".env.*", ".ssh", ".npmrc", ".pypirc", "patchwarden.config.json",
    ]),
    project_policy: {
      valid: input.projectPolicyValid ?? null,
      effective_policy: input.projectPolicy || null,
      issues: [...(input.projectPolicyIssues || [])]
        .map((issue) => ({ code: issue.code, severity: issue.severity, field: issue.field }))
        .sort((left, right) => stableJsonStringify(left).localeCompare(stableJsonStringify(right))),
    },
    risk_rules: {
      implementation: input.riskRulesVersion || "risk-engine-v1",
      project_high_risk_commands: sortedUnique(input.projectPolicy?.high_risk_commands),
    },
    confirmation_policy: {
      change_policy: input.changePolicy || "repo_scoped_changes",
      template: input.template || null,
    },
    task_parameters: {
      test_command: input.testCommand || null,
      verify_commands: sortedUnique(input.verifyCommands),
      timeout_seconds: input.taskTimeoutSeconds ?? config.defaultTaskTimeoutSeconds,
      scope: sortedUniqueTaskPaths(input.scope),
      forbidden: sortedUniqueTaskPaths(input.forbidden),
      verification: sortedUnique(input.verification),
      done_evidence: sortedUniqueTaskPaths(input.doneEvidence),
    },
    release_protection: {
      high_risk_commands: sortedUnique(input.projectPolicy?.high_risk_commands || [
        "npm publish", "git push", "git tag", "gh release create",
      ]),
      release_mode: input.projectPolicy?.release_mode || {
        version_source: "package.json",
        required_commands: ["npm run build", "npm test"],
      },
      artifact_rules: "artifact-rules-v1",
    },
    direct_profile: Boolean(config.enableDirectProfile),
    assessment_ttl: config.assessmentTtlSeconds,
    timeout_policy: {
      default_task_timeout_seconds: config.defaultTaskTimeoutSeconds,
      max_task_timeout_seconds: config.maxTaskTimeoutSeconds,
    },
  };

  return {
    assessment_security_snapshot_version: ASSESSMENT_SECURITY_SNAPSHOT_VERSION,
    components,
  };
}

/** Recursively sort object keys while preserving array order where it matters. */
export function canonicalizeAssessmentSecuritySnapshot(snapshot: AssessmentSecuritySnapshot): AssessmentSecuritySnapshot {
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]));
    }
    return value;
  };
  return canonicalize(snapshot) as AssessmentSecuritySnapshot;
}

export function hashAssessmentSecuritySnapshot(snapshot: AssessmentSecuritySnapshot): string {
  return createHash("sha256")
    .update(stableJsonStringify(canonicalizeAssessmentSecuritySnapshot(snapshot)))
    .digest("hex");
}

export function getAssessmentSecuritySnapshotComponentHashes(
  snapshot: AssessmentSecuritySnapshot,
): Record<SecuritySnapshotCategory, string> {
  return Object.fromEntries(Object.entries(snapshot.components).map(([name, value]) => [
    name,
    createHash("sha256").update(stableJsonStringify(value)).digest("hex"),
  ])) as Record<SecuritySnapshotCategory, string>;
}

export function compareAssessmentSecuritySnapshots(
  expected: AssessmentSecuritySnapshot,
  actual: AssessmentSecuritySnapshot,
): AssessmentSecuritySnapshotComparison {
  const expectedHash = hashAssessmentSecuritySnapshot(expected);
  const actualHash = hashAssessmentSecuritySnapshot(actual);
  const expectedComponents = getAssessmentSecuritySnapshotComponentHashes(expected);
  const actualComponents = getAssessmentSecuritySnapshotComponentHashes(actual);
  const changed = (Object.keys(actualComponents) as SecuritySnapshotCategory[])
    .filter((name) => expectedComponents[name] !== actualComponents[name]);
  if (expected.assessment_security_snapshot_version !== actual.assessment_security_snapshot_version) {
    changed.unshift("schema_epoch");
  }
  return {
    equal: expectedHash === actualHash,
    expected_hash: expectedHash,
    actual_hash: actualHash,
    changed_field_names: [...new Set(changed)],
  };
}
