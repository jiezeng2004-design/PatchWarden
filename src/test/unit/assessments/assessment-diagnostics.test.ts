import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { reloadConfig } from "../../../config.js";
import {
  buildAssessmentValidationFailureDiagnostic,
  readLastAssessmentValidationFailure,
  recordAssessmentValidationFailure,
} from "../../../assessments/assessmentDiagnostics.js";
import { ASSESSMENT_SECURITY_SNAPSHOT_VERSION } from "../../../assessments/securitySnapshot.js";
import type { AssessmentValidationResult } from "../../../assessments/assessmentStore.js";
import { TOOL_SCHEMA_EPOCH } from "../../../version.js";
import { healthCheck } from "../../../tools/diagnostics/healthCheck.js";

describe("assessment validation diagnostics", () => {
  let root: string;
  let configPath: string;
  let previousConfig: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pw-assessment-diagnostic-"));
    configPath = join(root, "patchwarden.config.json");
    previousConfig = process.env.PATCHWARDEN_CONFIG;
    writeFileSync(configPath, JSON.stringify({
      workspaceRoot: root,
      agents: {},
      allowedTestCommands: ["npm test"],
    }), "utf-8");
    process.env.PATCHWARDEN_CONFIG = configPath;
    reloadConfig(configPath);
  });

  afterEach(() => {
    if (previousConfig === undefined) delete process.env.PATCHWARDEN_CONFIG;
    else process.env.PATCHWARDEN_CONFIG = previousConfig;
    reloadConfig(previousConfig);
    rmSync(root, { recursive: true, force: true });
  });

  it("persists and exposes only a bounded value-free stale summary", () => {
    const expectedHash = "a".repeat(64);
    const actualHash = "b".repeat(64);
    const assessmentId = "assessment_20260724_120000_" + "c".repeat(32);
    process.env.PATCHWARDEN_WATCHER_INSTANCE_ID = "watcher-test-instance";
    const failure: AssessmentValidationResult = {
      valid: false,
      failure_reason: "assessment_stale_config",
      assessment: {
        assessment_id: assessmentId,
        assessment_security_snapshot_version: ASSESSMENT_SECURITY_SNAPSHOT_VERSION,
        assessment_schema_epoch: TOOL_SCHEMA_EPOCH,
        created_at: "2026-07-24T04:00:00.000Z",
        expires_at: "2026-07-24T05:00:00.000Z",
      } as never,
      expected_hash: expectedHash,
      actual_hash: actualHash,
      config_change_categories: ["allowed_commands", "tool_manifest"],
    };
    const built = buildAssessmentValidationFailureDiagnostic(failure);
    assert.equal(built?.assessment_id, assessmentId);
    assert.equal(built?.watcher_instance_id, "watcher-test-instance");
    assert.equal(built?.validator_module_path, "dist/assessments/assessmentStore.js");
    assert.equal(recordAssessmentValidationFailure(failure), true);
    delete process.env.PATCHWARDEN_WATCHER_INSTANCE_ID;

    const diagnostic = readLastAssessmentValidationFailure();
    assert.equal(diagnostic?.reason_code, "assessment_stale_config");
    assert.equal(diagnostic?.assessment_config_sha256, expectedHash);
    assert.equal(diagnostic?.current_config_sha256, actualHash);
    assert.equal(diagnostic?.assessment_config_hash, expectedHash);
    assert.equal(diagnostic?.current_config_hash, actualHash);
    assert.equal(diagnostic?.config_changed, true);
    assert.deepEqual(diagnostic?.changed_field_names, ["allowed_commands", "tool_manifest"]);
    assert.deepEqual(diagnostic?.changed_config_sections, ["allowed_commands", "tool_manifest"]);
    assert.equal(diagnostic?.assessment_fingerprint_version, ASSESSMENT_SECURITY_SNAPSHOT_VERSION);
    assert.equal(diagnostic?.current_fingerprint_version, ASSESSMENT_SECURITY_SNAPSHOT_VERSION);
    assert.equal(diagnostic?.assessment_schema_epoch, TOOL_SCHEMA_EPOCH);
    assert.equal(diagnostic?.current_schema_epoch, TOOL_SCHEMA_EPOCH);

    const health = healthCheck(undefined, { detail: "self_diagnostic" }) as Record<string, unknown>;
    const selfDiagnostic = health.self_diagnostic as Record<string, unknown>;
    assert.deepEqual(selfDiagnostic.last_assessment_validation_failure, diagnostic);

    const raw = readFileSync(
      join(root, ".patchwarden", "assessments", "last-validation-failure.json"),
      "utf-8",
    );
    assert.match(raw, /assessment_20260724_120000/);
    assert.equal(raw.includes(root), false);
    assert.equal(raw.includes("npm test"), false);
  });
});
