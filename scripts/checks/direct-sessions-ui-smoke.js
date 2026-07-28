#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const html = readFileSync(join(root, "ui", "pages", "direct-sessions.html"), "utf-8");

assert.match(html.trim(), /<\/html>$/, "Direct sessions page must not render script text after the closing document tag");
assert.match(html, /<option value="">全部会话<\/option>/, "Direct sessions must default to the unfiltered all-sessions view");
for (const state of ["active", "finalized", "audited", "expired", "archive"]) {
  assert.match(html, new RegExp(`<option value="${state}">`), `missing Direct state option: ${state}`);
}
assert.match(html, /if \(state\) params\.push\('state='/, "the all-sessions request must omit the state query parameter");
assert.match(html, /data\.available_total/, "filtered empty states need the unfiltered session count");
assert.match(html, /当前没有进行中的 Direct 会话/, "active-empty state must explain where completed sessions went");
assert.match(html, /清除筛选/, "filtered-empty state must provide a recovery action");
assert.match(html, /sessionsAbortController\.abort\(\)/, "stale Direct session requests must be cancelled");
assert.match(html, /new URLSearchParams\(window\.location\.search\)\.get\('id'\)/, "session detail links must open the requested Direct session");
assert.match(html, /window\.addEventListener\('focus'/, "returning to the page must refresh newly created Direct sessions");

console.log("ok - Direct sessions default to all history, recover from empty filters, and refresh after real calls");
