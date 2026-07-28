#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const source = readFileSync(resolve(root, "ui", "pages", "tasks.html"), "utf-8");

assert.match(source, /var activeTaskRequest = null;/);
assert.match(source, /var taskRequestSerial = 0;/);
assert.match(source, /activeTaskRequest\.abort\(\)/);
assert.match(source, /signal: controller\.signal/);
assert.match(source, /requestSerial !== taskRequestSerial/);
assert.doesNotMatch(source, /addEventListener\('click', fetchTasks\)/);
assert.match(source, /cursor = typeof cursor === 'string' \? cursor : '';/);
assert.match(source, /params\.push\('limit=20'\)/);
assert.doesNotMatch(source, /params\.push\('limit=50'\)/);
assert.match(source, /accepted:\s+\{ color: 'success', text: '已通过' \}/);
assert.match(source, /done_by_agent:\s+'Agent 已执行'/);

for (const value of ["pending", "accepted", "rejected", "needs_fix", "blocked"]) {
  assert.match(source, new RegExp(`<option value="${value}"`), `acceptance filter must expose ${value}`);
}
const acceptanceFilterStart = source.indexOf('<select id="acceptanceFilter"');
const acceptanceFilterSection = source.slice(acceptanceFilterStart, source.indexOf('</select>', acceptanceFilterStart));
for (const legacyValue of ["ready_for_review", "done_by_agent", "failed_verification", "failed_policy_violation", "failed_scope_violation"]) {
  assert.doesNotMatch(acceptanceFilterSection, new RegExp(`<option value="${legacyValue}"`), `acceptance filter must not send legacy ${legacyValue}`);
}

console.log("ok - task filters are last-request-wins, use a bounded first page, send current acceptance states, and hide internal status codes");
