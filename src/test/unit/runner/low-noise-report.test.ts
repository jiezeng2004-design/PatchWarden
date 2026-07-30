import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { buildLowNoiseAcceptanceReport } from "../../../runner/lowNoiseReport.js";

describe("low-noise acceptance report", () => {
  it("summarizes hundreds of generated files without listing them and keeps expansion links", () => {
    const report = buildLowNoiseAcceptanceReport({
      source_changes: 18,
      generated_changes: 301,
      scope_violations: 0,
      verification_commands: [
        { command: "npm test", status: "passed" },
        { command: "npm run build", status: "passed" },
      ],
      runtime_validation: { status: "passed", routes_checked: 10, route_results: [{ broken_images: 0, console_errors: 0 }] },
      completion_state: {
        implementation_complete: true,
        static_verification_complete: true,
        runtime_validation_required: true,
        runtime_validation_complete: true,
        manual_review_required: false,
        user_acceptance_ready: true,
        accepted: false,
      },
      audit: "passed",
    });
    assert.equal(report.generated_changes, 301);
    assert.equal(report.acceptance_status, "user_acceptance_ready");
    assert.deepEqual(report.verification, { "npm test": "passed", "npm run build": "passed" });
    assert.equal(report.runtime_validation.routes_checked, 10);
    assert.equal(report.expandable_evidence.diff, "diff.patch");
    assert.ok(!JSON.stringify(report).includes("generated-file-1"));
  });

  it("lists runtime review separately when browser validation is absent", () => {
    const report = buildLowNoiseAcceptanceReport({
      source_changes: 1,
      generated_changes: 0,
      scope_violations: 0,
      verification_commands: [{ command: "npm test", status: "passed" }],
      completion_state: {
        implementation_complete: true,
        static_verification_complete: true,
        runtime_validation_required: false,
        runtime_validation_complete: false,
        manual_review_required: true,
        user_acceptance_ready: false,
        accepted: false,
      },
    });
    assert.equal(report.acceptance_status, "manual_review_required");
    assert.match(report.manual_items[0], /Runtime validation was not configured/);
  });
});
