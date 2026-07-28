import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildAuditOverview,
  summarizeDirectAudit,
  summarizeIndependentReview,
  summarizeTaskAudit,
} from "../../../control/auditSummary.js";

describe("Control Center audit summaries", () => {
  it("normalizes structured task audits into a conclusion-first safe view", () => {
    const entry = summarizeTaskAudit("task-audit-001", {
      verdict: "fail",
      summary: "One blocking issue was confirmed.",
      checks: [
        { name: "repo_path_consistency", result: "pass", detail: "Repository matches." },
        { name: "forbidden_scope_violation", result: "fail", detail: "A forbidden path changed." },
        { name: "artifact_hygiene", result: "warn", detail: "Review generated output." },
      ],
      acceptance: {
        status: "rejected",
        reason: "Blocking scope violation.",
        next_suggested_task: "Create a scoped repair task.",
      },
      manual_verification_required: true,
      manual_verification_items: ["Confirm the out-of-scope file is restored."],
      recommended_next_actions: ["Restore the forbidden path."],
    }, "2026-07-27T12:00:00.000Z");

    assert.equal(entry.verdict, "fail");
    assert.deepEqual(entry.check_counts, { pass: 1, warn: 1, fail: 1, total: 3 });
    assert.equal(entry.scope_change_status, "attention");
    assert.equal(entry.requires_action, true);
    assert.equal(entry.manual_verification_required, true);
    assert.equal(entry.acceptance_status, "rejected");
    assert.ok(entry.findings.some((item) => item.includes("forbidden_scope_violation")));
    assert.deepEqual(entry.recommended_actions, ["Restore the forbidden path.", "Create a scoped repair task."]);
    assert.equal(entry.detail_url, "/pages/task-detail.html?id=task-audit-001");
  });

  it("parses legacy Markdown reviews without inventing missing evidence", () => {
    const content = [
      "# Independent Review",
      "",
      "**Task**: task-legacy-001",
      "**Verdict**: WARN",
      "",
      "## Summary",
      "Audit complete: 7 pass, 2 warn, 0 fail across 9 checks. 1 risk identified.",
      "",
      "## Checks",
      "- [x] **repo_path_consistency**: Repository matches.",
      "- [ ] **artifact_hygiene**: Review generated output.",
      "",
      "## Risks",
      "- [medium] Generated output needs review.",
      "",
      "## Confirmed Failures",
      "- None.",
      "",
      "## Manual Verification Required",
      "- Confirm the generated output is expected.",
      "",
      "## Recommended Actions",
      "- Review generated output before acceptance.",
    ].join("\n");

    const entry = summarizeIndependentReview("task-legacy-001", content, null);
    assert.equal(entry.verdict, "warn");
    assert.deepEqual(entry.check_counts, { pass: 7, warn: 2, fail: 0, total: 9 });
    assert.equal(entry.scope_change_status, "not_reported");
    assert.deepEqual(entry.findings, ["Generated output needs review.", "Confirm the generated output is expected."]);
    assert.deepEqual(entry.recommended_actions, ["Review generated output before acceptance."]);
    assert.equal(entry.manual_verification_required, true);
  });

  it("normalizes Direct audits and builds totals that always reconcile", () => {
    const direct = summarizeDirectAudit("direct-session-001", {
      decision: "warn",
      blocking_findings: [],
      warnings: ["verification: No verification was run."],
      evidence: { changed_files_total: 2 },
      next_action: "Run verification before accepting changes.",
    }, "2026-07-27T12:30:00.000Z");
    const pass = summarizeTaskAudit("task-pass", { verdict: "pass", checks: [] }, null);
    const unknown = summarizeIndependentReview("task-unknown", "# Independent Review", null);
    const overview = buildAuditOverview([direct, pass, unknown], 2);

    assert.equal(direct.subject_type, "direct_session");
    assert.equal(direct.scope_change_status, "attention");
    assert.equal(direct.detail_url, "/pages/direct-sessions.html?id=direct-session-001");
    assert.deepEqual({
      total: overview.total,
      pass: overview.pass,
      warn: overview.warn,
      fail: overview.fail,
      unknown: overview.unknown,
    }, { total: 3, pass: 1, warn: 1, fail: 0, unknown: 1 });
    assert.equal(overview.pass + overview.warn + overview.fail + overview.unknown, overview.total);
    assert.equal(overview.returned, 2);
    assert.equal(overview.truncated, true);
    assert.equal(overview.needs_action, 1);
    assert.equal(overview.manual_verification, 0);
    assert.deepEqual(overview.attention_groups.map((group) => group.type), ["warning", "unknown"]);
  });

  it("replaces contradictory no-action placeholders on failed legacy audits", () => {
    const entry = summarizeIndependentReview("task-failed", [
      "# Independent Review",
      "**Verdict**: FAIL",
      "## Summary",
      "Audit complete: 1 pass, 0 warn, 1 fail across 2 checks.",
      "## Confirmed Failures",
      "- **task_status**: Task failed.",
      "## Recommended Actions",
      "- No specific actions recommended.",
    ].join("\n"), null);
    assert.equal(entry.recommended_actions[0], "Fix the confirmed findings and run the audit again.");
  });

  it("counts a pass verdict with required manual verification as needing action", () => {
    const entry = summarizeTaskAudit("task-manual", {
      verdict: "pass",
      checks: [{ name: "verification", result: "pass", detail: "Automated verification passed." }],
      manual_verification_required: true,
      manual_verification_items: ["Confirm the browser flow manually."],
    }, null);
    const overview = buildAuditOverview([entry], 1);
    assert.equal(overview.pass, 1);
    assert.equal(overview.manual_verification, 1);
    assert.equal(overview.needs_action, 1);
    assert.equal(overview.attention_groups[0]?.type, "manual_verification");
  });

  it("does not infer manual verification from a Direct warning", () => {
    const direct = summarizeDirectAudit("direct-warning", {
      decision: "warn",
      warnings: ["verification: No verification was run."],
    }, null);
    const overview = buildAuditOverview([direct], 1);

    assert.equal(direct.requires_action, true);
    assert.equal(direct.manual_verification_required, false);
    assert.equal(overview.needs_action, 1);
    assert.equal(overview.manual_verification, 0);
    assert.deepEqual(overview.attention_groups.map((group) => group.type), ["warning"]);
  });

  it("counts declared manual items even when a legacy task omitted the boolean flag", () => {
    const task = summarizeTaskAudit("task-manual-items", {
      verdict: "pass",
      manual_verification_items: ["Confirm the browser flow manually."],
    }, null);
    const overview = buildAuditOverview([task], 1);

    assert.equal(task.manual_verification_required, true);
    assert.equal(task.requires_action, true);
    assert.equal(overview.manual_verification, 1);
    assert.equal(overview.needs_action, 1);
  });
});
