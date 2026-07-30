import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { reloadConfig } from "../../../config.js";
import { PatchWardenError } from "../../../errors.js";
import { validateInvocationAssessment } from "../../../security/invocationAssessment.js";

describe("dynamic invocation assessment binding", () => {
  let root: string;
  let assessmentId: string;
  let assessmentFile: string;
  let previousConfig: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pw-invoke-assessment-"));
    assessmentId = `assessment_20260729_120000_${"a".repeat(32)}`;
    assessmentFile = join(root, ".patchwarden", "assessments", assessmentId, "assessment.json");
    mkdirSync(join(root, ".patchwarden", "assessments", assessmentId), { recursive: true });
    const configPath = join(root, "patchwarden.config.json");
    writeFileSync(configPath, JSON.stringify({
      workspaceRoot: root,
      assessmentsDir: ".patchwarden/assessments",
      plansDir: ".patchwarden/plans",
      tasksDir: ".patchwarden/tasks",
      agents: {},
      allowedTestCommands: [],
    }));
    previousConfig = process.env.PATCHWARDEN_CONFIG;
    process.env.PATCHWARDEN_CONFIG = configPath;
    reloadConfig(configPath);
    writeAssessment({});
  });

  afterEach(() => {
    if (previousConfig === undefined) delete process.env.PATCHWARDEN_CONFIG;
    else process.env.PATCHWARDEN_CONFIG = previousConfig;
    reloadConfig(previousConfig);
    rmSync(root, { recursive: true, force: true });
  });

  function writeAssessment(overrides: Record<string, unknown>): void {
    writeFileSync(assessmentFile, JSON.stringify({
      assessment_id: assessmentId,
      decision: "allow",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      used_at: null,
      requires_confirm: false,
      confirmed: false,
      ...overrides,
    }));
  }

  function reason(fn: () => unknown): string {
    try { fn(); } catch (error) {
      assert.ok(error instanceof PatchWardenError);
      return error.reason;
    }
    assert.fail("Expected PatchWardenError");
  }

  it("injects the same real assessment into create_task execution", () => {
    const result = validateInvocationAssessment("create_task", "workspace_write", { goal: "x" }, assessmentId);
    assert.deepEqual(result.dispatchArgs, {
      goal: "x",
      assessment_id: assessmentId,
      execution_mode: "execute",
    });
  });

  it("rejects expired, used, unconfirmed, blocked, and mismatched assessments", () => {
    writeAssessment({ expires_at: new Date(Date.now() - 1).toISOString() });
    assert.equal(reason(() => validateInvocationAssessment("create_task", "workspace_write", {}, assessmentId)), "assessment_expired");
    writeAssessment({ used_at: new Date().toISOString() });
    assert.equal(reason(() => validateInvocationAssessment("create_task", "workspace_write", {}, assessmentId)), "assessment_used");
    writeAssessment({ requires_confirm: true, confirmed: false });
    assert.equal(reason(() => validateInvocationAssessment("create_task", "workspace_write", {}, assessmentId)), "assessment_confirmation_required");
    writeAssessment({ decision: "blocked" });
    assert.equal(reason(() => validateInvocationAssessment("create_task", "workspace_write", {}, assessmentId)), "assessment_blocked");
    writeAssessment({});
    assert.equal(reason(() => validateInvocationAssessment("create_task", "workspace_write", { assessment_id: "different" }, assessmentId)), "assessment_parameter_mismatch");
  });

  it("does not let a create_task assessment authorize another write or release tool", () => {
    assert.equal(reason(() => validateInvocationAssessment("save_plan", "workspace_write", {}, assessmentId)), "assessment_tool_mismatch");
    assert.equal(reason(() => validateInvocationAssessment("publish_release", "release", {}, assessmentId)), "release_assessment_unsupported");
  });
});
