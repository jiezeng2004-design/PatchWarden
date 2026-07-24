import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { reloadConfig } from "../../../config.js";
import {
  readLastAssessmentValidationFailure,
  recordAssessmentValidationFailure,
} from "../../../assessments/assessmentDiagnostics.js";
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
    assert.equal(recordAssessmentValidationFailure({
      valid: false,
      failure_reason: "assessment_stale_config",
      assessment: null,
      expected_hash: expectedHash,
      actual_hash: actualHash,
      config_change_categories: ["allowed_commands", "tool_manifest"],
    }), true);

    const diagnostic = readLastAssessmentValidationFailure();
    assert.equal(diagnostic?.reason_code, "assessment_stale_config");
    assert.equal(diagnostic?.assessment_config_sha256, expectedHash);
    assert.equal(diagnostic?.current_config_sha256, actualHash);
    assert.equal(diagnostic?.config_changed, true);
    assert.deepEqual(diagnostic?.changed_field_names, ["allowed_commands", "tool_manifest"]);

    const health = healthCheck(undefined, { detail: "self_diagnostic" }) as Record<string, unknown>;
    const selfDiagnostic = health.self_diagnostic as Record<string, unknown>;
    assert.deepEqual(selfDiagnostic.last_assessment_validation_failure, diagnostic);

    const raw = readFileSync(
      join(root, ".patchwarden", "assessments", "last-validation-failure.json"),
      "utf-8",
    );
    assert.doesNotMatch(raw, /assessment_\d{8}/);
    assert.equal(raw.includes(root), false);
    assert.equal(raw.includes("npm test"), false);
  });
});
