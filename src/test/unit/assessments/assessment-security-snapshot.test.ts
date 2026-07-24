import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { PatchWardenConfig } from "../../../config.js";
import { getDefaultProjectPolicy } from "../../../policy/projectPolicy.js";
import {
  ASSESSMENT_SECURITY_SNAPSHOT_VERSION,
  buildAssessmentSecuritySnapshot,
  compareAssessmentSecuritySnapshots,
  hashAssessmentSecuritySnapshot,
} from "../../../assessments/securitySnapshot.js";

const root = mkdtempSync(join(tmpdir(), "pw-security-snapshot-"));
const repo = join(root, "repo");

after(() => rmSync(root, { recursive: true, force: true }));

function config(overrides: Partial<PatchWardenConfig> = {}): PatchWardenConfig {
  return {
    workspaceRoot: root,
    plansDir: ".patchwarden/plans",
    tasksDir: ".patchwarden/tasks",
    assessmentsDir: ".patchwarden/assessments",
    assessmentTtlSeconds: 3600,
    agents: {
      codex: { command: "codex", args: ["exec", "{prompt}"], envAllowlist: ["PATH"] },
      opencode: { command: "opencode", args: ["run", "{prompt}"] },
    },
    allowedTestCommands: ["npm test", "npm run build"],
    repoAllowedTestCommands: {},
    maxReadFileBytes: 200_000,
    defaultTaskTimeoutSeconds: 900,
    maxTaskTimeoutSeconds: 3600,
    watcherStaleSeconds: 30,
    toolProfile: "chatgpt_core",
    enableDirectProfile: false,
    directSessionsDir: ".patchwarden/direct-sessions",
    directSessionTtlSeconds: 3600,
    directMaxPatchBytes: 200_000,
    directMaxFileBytes: 500_000,
    directAllowedCommands: ["npm test", "npm run build"],
    repoDirectAllowedCommands: {},
    ...overrides,
  };
}

function snapshot(cfg = config(), projectPolicy = getDefaultProjectPolicy()) {
  return buildAssessmentSecuritySnapshot({
    config: cfg,
    schemaEpoch: "2026-07-19-v15",
    toolProfile: "chatgpt_core",
    toolManifestSha256: "a".repeat(64),
    agent: "codex",
    repoPath: repo,
    changePolicy: "repo_scoped_changes",
    template: "inspect_only",
    verifyCommands: ["npm test", "npm run build"],
    projectPolicy,
  });
}

function snapshotWith(overrides: Partial<Parameters<typeof buildAssessmentSecuritySnapshot>[0]>) {
  return buildAssessmentSecuritySnapshot({
    config: config(),
    schemaEpoch: "2026-07-19-v15",
    toolProfile: "chatgpt_core",
    toolManifestSha256: "a".repeat(64),
    agent: "codex",
    repoPath: repo,
    changePolicy: "repo_scoped_changes",
    template: "inspect_only",
    verifyCommands: ["npm test", "npm run build"],
    projectPolicy: getDefaultProjectPolicy(),
    ...overrides,
  });
}

describe("assessment security snapshot", () => {
  it("is deterministic across object order, set order, and runtime-only fields", () => {
    const reordered = config({
      agents: {
        opencode: { command: "opencode", args: ["run", "{prompt}"] },
        codex: { envAllowlist: ["PATH"], args: ["exec", "{prompt}"], command: "codex" },
      },
      allowedTestCommands: ["npm run build", "npm test", "npm test"],
    });
    const withRuntimeState = Object.assign(reordered, {
      watcher_pid: 1234,
      watcher_instance_id: "runtime-watcher-a",
      watcher_heartbeat: new Date().toISOString(),
      supervisor_pid: 5678,
      supervisor_status: "healthy",
      uptime_seconds: 42,
      checked_at: new Date().toISOString(),
      tunnel_status: "ready",
      last_error: "runtime-only",
      recent_tasks: ["task-runtime-only"],
    }) as PatchWardenConfig;

    assert.equal(hashAssessmentSecuritySnapshot(snapshot()), hashAssessmentSecuritySnapshot(snapshot(withRuntimeState)));
  });

  it("normalizes equivalent Windows drive case, separators, and trailing separators", () => {
    const variants = [
      "D:\\ai_agent\\patchwarden_program",
      "d:\\ai_agent\\patchwarden_program\\",
      "D:/ai_agent/patchwarden_program",
    ];
    const hashes = variants.map((workspaceRoot) => hashAssessmentSecuritySnapshot(buildAssessmentSecuritySnapshot({
      config: config({ workspaceRoot }),
      schemaEpoch: "2026-07-19-v15",
      toolProfile: "chatgpt_core",
      toolManifestSha256: "a".repeat(64),
      agent: "codex",
      repoPath: workspaceRoot,
      projectPolicy: getDefaultProjectPolicy(),
    })));
    assert.equal(new Set(hashes).size, 1);
  });

  it("reports only safe field names for material security changes", () => {
    const base = snapshot();
    const changedCases: Array<[string, ReturnType<typeof snapshot>]> = [
      ["workspace_root", snapshot(config({ workspaceRoot: join(root, "other") }))],
      ["allowed_commands", snapshot(config({ allowedTestCommands: ["npm test"] }))],
      ["agent_launch", snapshot(config({ agents: { codex: { command: "codex", args: ["exec", "--different", "{prompt}"] } } }))],
      ["direct_profile", snapshot(config({ enableDirectProfile: true }))],
      ["assessment_ttl", snapshot(config({ assessmentTtlSeconds: 7200 }))],
      ["protected_paths", snapshot(config(), { ...getDefaultProjectPolicy(), protected_paths: [".env", "secrets/**"] })],
      ["project_policy", snapshot(config(), { ...getDefaultProjectPolicy(), auto_cleanup: { enabled: false, patterns: [], exclude: [] } })],
      ["release_protection", snapshot(config(), { ...getDefaultProjectPolicy(), high_risk_commands: ["git push"] })],
      ["risk_rules", snapshotWith({ riskRulesVersion: "risk-engine-v2" })],
      ["task_parameters", snapshotWith({ testCommand: "npm test" })],
    ];

    for (const [expectedField, changed] of changedCases) {
      const comparison = compareAssessmentSecuritySnapshots(base, changed);
      assert.equal(comparison.equal, false, expectedField);
      assert.ok(comparison.changed_field_names.includes(expectedField as never), JSON.stringify(comparison));
      assert.match(comparison.expected_hash, /^[0-9a-f]{64}$/);
      assert.match(comparison.actual_hash, /^[0-9a-f]{64}$/);
    }
  });

  it("uses an explicit independent snapshot version", () => {
    assert.equal(snapshot().assessment_security_snapshot_version, ASSESSMENT_SECURITY_SNAPSHOT_VERSION);
  });

  it("treats missing task defaults and explicit defaults identically", () => {
    const implicit = snapshotWith({});
    const explicit = snapshotWith({
      taskTimeoutSeconds: config().defaultTaskTimeoutSeconds,
      testCommand: null,
      scope: [],
      forbidden: [],
      verification: [],
      doneEvidence: [],
    });
    assert.equal(hashAssessmentSecuritySnapshot(implicit), hashAssessmentSecuritySnapshot(explicit));
  });

  it("normalizes task path sets and rejects material scope changes", () => {
    const left = snapshotWith({ scope: ["src\\**", "./README.md", "src/**"] });
    const right = snapshotWith({ scope: ["README.md", "src/**"] });
    assert.equal(hashAssessmentSecuritySnapshot(left), hashAssessmentSecuritySnapshot(right));
    const changed = compareAssessmentSecuritySnapshots(right, snapshotWith({ forbidden: ["release/**"] }));
    assert.ok(changed.changed_field_names.includes("task_parameters"));
  });
});
