#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const uiRoot = join(root, "ui");
const htmlFiles = [
  join(uiRoot, "partials", "project-shell.html"),
  ...readdirSync(join(uiRoot, "pages"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".html"))
    .map((entry) => join(uiRoot, "pages", entry.name)),
];

let badgeCount = 0;
for (const file of htmlFiles) {
  const content = readFileSync(file, "utf-8");
  assert.doesNotMatch(content, />Core v[0-9]/, `${file} must not hard-code a Core version`);
  badgeCount += (content.match(/data-core-version/g) || []).length;
}

const i18n = readFileSync(join(uiRoot, "i18n.js"), "utf-8");
assert.ok(badgeCount >= 7, "project shell pages must expose dynamic Core version badges");
assert.match(i18n, /fetch\("\/api\/control-center-status"/);
assert.match(i18n, /querySelectorAll\("\[data-core-version\]"\)/);
console.log(`ok - ${badgeCount} Core version badges are runtime-backed and contain no stale literal`);
