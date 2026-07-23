#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanGeneratedOutput } from "../lib/clean-generated-output.js";
import { collectMatchingFiles } from "../lib/file-discovery.js";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const sourceRoot = resolve(root, "src", "test", "unit");
const compiledRoot = resolve(root, "dist", "test", "unit");

const sourceTests = collectMatchingFiles(sourceRoot, (name) => name.endsWith(".test.ts"))
  .map((path) => relative(sourceRoot, path).replace(/\\/g, "/").replace(/\.ts$/, ".js"));
const compiledTests = collectMatchingFiles(compiledRoot, (name) => name.endsWith(".test.js"))
  .map((path) => relative(compiledRoot, path).replace(/\\/g, "/"));

assert.deepEqual(compiledTests, sourceTests, "compiled unit tests must exactly match source test paths");
assert.ok(compiledTests.some((path) => path.includes("/")), "unit discovery must include nested tests");

const fixtureRoot = mkdtempSync(resolve(tmpdir(), "patchwarden-clean-build-"));
try {
  const fixtureDist = resolve(fixtureRoot, "dist");
  const outside = resolve(fixtureRoot, "keep.txt");
  mkdirSync(fixtureDist);
  writeFileSync(resolve(fixtureDist, "stale.js"), "stale\n", "utf8");
  writeFileSync(outside, "keep\n", "utf8");
  cleanGeneratedOutput(fixtureRoot, fixtureDist);
  assert.equal(existsSync(fixtureDist), false, "clean build must remove stale dist contents");
  assert.equal(existsSync(outside), true, "clean build must preserve files outside dist");
  assert.throws(() => cleanGeneratedOutput(fixtureRoot, resolve(fixtureRoot, "release")), /Refusing/);
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}

console.log(`[build-output-check] OK: ${sourceTests.length} source tests match ${compiledTests.length} compiled tests.`);
