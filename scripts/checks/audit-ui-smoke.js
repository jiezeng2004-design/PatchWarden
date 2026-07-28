#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const html = readFileSync(join(root, "ui", "pages", "audit.html"), "utf-8");
const script = readFileSync(join(root, "ui", "pages", "audit-v2.js"), "utf-8");
const route = readFileSync(join(root, "src", "control", "routes", "audit.ts"), "utf-8");

for (const marker of [
  'id="auditOverview"',
  'id="statUnknown"',
  'data-zh="风险与下一步"',
  'data-zh="关键发现"',
  'data-zh="下一步"',
  'id="evidenceConclusion"',
  'id="evidenceFindings"',
  'id="evidenceActions"',
  'src="/pages/audit-v2.js"',
]) {
  assert.ok(html.includes(marker), `audit page missing ${marker}`);
}

for (const marker of [
  "attention_groups",
  "stats.fail",
  "stats.warn",
  "stats.unknown",
  "entry.findings",
  "entry.recommended_actions",
  "entry.check_counts",
  "data-audit-id",
  "expectedGroups",
  "AUDIT_RESPONSE_INVALID",
]) {
  assert.ok(script.includes(marker), `audit renderer missing ${marker}`);
}

assert.equal(script.includes('/api/warnings'), false, "audit UI must derive risks from the same normalized audit response");
assert.match(script, /candidate\.needs_action < Math\.max\(verdictActionCount, candidate\.manual_verification\)/, "audit UI must reject under-counted attention totals");
assert.match(script, /group\.count !== expectedGroups\[group\.type\]/, "audit UI must reject inconsistent attention groups");
assert.ok(route.includes("summarizeTaskAudit"));
assert.ok(route.includes("summarizeIndependentReview"));
assert.ok(route.includes("buildAuditOverview"));
assert.ok(route.includes("continue;"), "structured audit.json must suppress the Markdown fallback row");

console.log("ok - audit UI presents reconciled conclusions, findings, actions, and structured evidence");
