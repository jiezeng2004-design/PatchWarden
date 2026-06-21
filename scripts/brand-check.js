#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const allowedLegacyFiles = new Set([
  ".gitignore",
  ".npmignore",
  "README.md",
  "README.en.md",
  "docs/migration-from-safe-bifrost.md",
  "docs/release-v0.3.0.md",
  "docs/release-v0.4.0.md",
  "scripts/brand-check.js",
  "scripts/pack-clean.js",
]);
const legacyPattern = /safe-bifrost|Safe-Bifrost|SAFE_BIFROST|SafeBifrost|safe_bifrost/;
const trackedFiles = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard"],
  { encoding: "utf-8" }
)
  .split(/\r?\n/)
  .filter(Boolean);
const failures = [];

for (const file of trackedFiles) {
  const normalized = file.replace(/\\/g, "/");
  if (allowedLegacyFiles.has(normalized)) continue;
  if (legacyPattern.test(normalized)) {
    failures.push(`${normalized}: legacy brand in path`);
    continue;
  }
  const content = readFileSync(file);
  if (!content.includes(0) && legacyPattern.test(content.toString("utf-8"))) {
    failures.push(`${normalized}: legacy brand in content`);
  }
}

if (failures.length > 0) {
  console.error("[brand-check] Legacy brand found outside the approved migration/history files:");
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

console.log(`[brand-check] OK: ${trackedFiles.length} tracked files checked.`);
