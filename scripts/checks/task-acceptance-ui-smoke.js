#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const tasks = readFileSync(resolve(root, "ui", "pages", "tasks.html"), "utf-8");
const detail = readFileSync(resolve(root, "ui", "pages", "task-detail.html"), "utf-8");

assert.match(tasks, /done_by_agent:\s+\{ color: 'success', text: 'Agent 已执行' \}/);
assert.match(tasks, /查看修复项并重新验收/);
assert.match(tasks, /打开详情运行验收/);
assert.match(detail, /id="acceptanceGuide"/);
assert.match(detail, /id="acceptanceGuideAudit"/);
assert.match(detail, /id="safeAuditSection"/);
assert.match(detail, /执行结束不等于验收通过/);
assert.match(detail, /acceptance === 'needs_fix'/);
assert.match(detail, /acceptance === 'rejected'/);
assert.match(detail, /acceptance === 'blocked'/);
assert.match(detail, /acceptance === 'accepted'/);
assert.match(detail, /acceptance === 'accepted' \? hide\(\$\('btnAudit'\)\) : show\(\$\('btnAudit'\)\)/, "accepted tasks must not expose the primary re-audit action");
assert.match(detail, /Array\.isArray\(acc\.fail_checks\)/, "nested acceptance failures must remain visible");
assert.match(detail, /Array\.isArray\(acc\.manual_verification_items\)/, "nested manual checks must remain visible");
assert.match(tasks, /function nextActionLabel\(value\)/, "normal task rows must translate next_action values");
assert.doesNotMatch(tasks, /title="' \+ escapeAttr\(task\.next_action\)/, "normal task rows must not expose raw next_action values");

console.log("ok - Agent execution and acceptance are distinct with explicit repair and re-audit actions");
