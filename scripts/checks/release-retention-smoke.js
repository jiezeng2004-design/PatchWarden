#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, pruneLocalArtifacts } from "../release/prune-local-artifacts.js";

const NOW = new Date("2026-07-27T12:00:00.000Z");
const OLD = new Date("2026-07-01T12:00:00.000Z");
const RECENT = new Date("2026-07-25T12:00:00.000Z");
const roots = [];

try {
  assert.deepEqual(parseArgs([]), { apply: false, days: 7 });
  assert.deepEqual(parseArgs(["--apply", "--days", "14"]), { apply: true, days: 14 });
  assert.deepEqual(parseArgs(["--days=3"]), { apply: false, days: 3 });
  assert.throws(() => parseArgs(["--days", "0"]), /positive integer/);
  assert.throws(() => parseArgs(["--unknown"]), /Unknown argument/);

  const root = createFixture();
  const preview = pruneLocalArtifacts({ root, now: NOW });
  assert.equal(preview.ok, true);
  assert.equal(preview.mode, "dry-run");
  assert.ok(preview.candidates.some((item) => item.path === "PatchWarden-v1.0.0.zip"));
  assert.ok(preview.candidates.some((item) => item.path === "release/desktop-preflight-1.0.0-20260701T120000Z"));
  assert.equal(preview.candidates.find((item) => item.path === "release/desktop-preflight-1.0.0-20260701T120000Z").age_source, "artifact_name");
  assert.equal(preview.candidates.find((item) => item.path === "release/desktop-cua-1.0.0-manual").age_source, "modified_time");
  assert.ok(preview.candidates.some((item) => item.path === "release/dist"));
  assert.ok(preview.protected.some((item) => item.path === "PatchWarden-v2.0.0.zip" && item.reason === "current_version"));
  assert.ok(preview.protected.some((item) => item.path === "PatchWarden-v1.0.0-SHA256SUMS.txt" && item.reason === "checksum_manifest"));
  assert.ok(preview.protected.some((item) => item.path === "patchwarden-release.tar.gz" && item.reason === "current_version_alias"));
  assert.ok(preview.protected.some((item) => item.path === "release/desktop-preflight-2.0.0-20260701T120000Z" && item.reason === "current_version"));
  assert.ok(preview.protected.some((item) => item.path === "PatchWarden-v1.9.0.zip" && item.reason === "within_retention_window"));
  assert.equal(existsSync(join(root, "PatchWarden-v1.0.0.zip")), true, "dry-run must not delete candidates");

  const applied = pruneLocalArtifacts({ root, now: NOW, apply: true });
  assert.equal(applied.ok, true);
  assert.equal(existsSync(join(root, "PatchWarden-v1.0.0.zip")), false);
  assert.equal(existsSync(join(root, "release", "desktop-preflight-1.0.0-20260701T120000Z")), false);
  assert.equal(existsSync(join(root, "release", "dist", "app.js")), false);
  assert.equal(existsSync(join(root, "PatchWarden-v2.0.0.zip")), true);
  assert.equal(existsSync(join(root, "PatchWarden-v1.0.0-SHA256SUMS.txt")), true);
  assert.equal(existsSync(join(root, "patchwarden-release.tar.gz")), true);
  assert.equal(existsSync(join(root, "PatchWarden-v1.9.0.zip")), true);
  assert.equal(existsSync(join(root, "do-not-touch.zip")), true);
  assert.equal(existsSync(join(root, "release", "custom.txt")), true);
  assert.equal(existsSync(join(root, "release", "package", "current.txt")), true);
  assert.equal(existsSync(join(root, "release", "desktop", "win-unpacked", "PatchWarden.exe")), true);
  assert.equal(existsSync(join(root, "release", "desktop-preflight-2.0.0-20260701T120000Z", "result.txt")), true);

  const after = pruneLocalArtifacts({ root, now: NOW });
  assert.equal(after.candidates.length, 0, "second preview must find no expired candidates");

  testUnsafeLinkIsFailClosed();
  testUnsafeContainerIsFailClosed();
  testPartialDeleteFailure();
  console.log("ok - local release retention is preview-first, confined, current-version safe, and failure bounded");
} finally {
  for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "patchwarden-release-retention-"));
  roots.push(root);
  writeJson(join(root, "package.json"), { name: "patchwarden", version: "2.0.0" });
  writeOld(join(root, "PatchWarden-v1.0.0.zip"));
  writeRecent(join(root, "PatchWarden-v1.9.0.zip"));
  writeOld(join(root, "PatchWarden-v2.0.0.zip"));
  writeOld(join(root, "PatchWarden-v1.0.0-SHA256SUMS.txt"));
  writeOld(join(root, "patchwarden-release.tar.gz"));
  writeOld(join(root, "do-not-touch.zip"));

  writeJson(join(root, "release", "package.json"), { name: "patchwarden", version: "1.0.0" }, OLD);
  writeOld(join(root, "release", "dist", "app.js"));
  writeOld(join(root, "release", "custom.txt"));
  writeRecent(join(root, "release", "package", "current.txt"));
  writeRecent(join(root, "release", "desktop", "win-unpacked", "PatchWarden.exe"));
  writeOld(join(root, "release", "desktop", "PatchWarden-Setup-1.0.0-x64.exe"));
  writeRecent(join(root, "release", "desktop", "PatchWarden-Portable-1.9.0-x64.zip"));
  writeOld(join(root, "release", "desktop", "smoke-old-20260701-1200", "result.txt"));
  writeOld(join(root, "release", "desktop-preflight-1.0.0-20260701T120000Z", "result.txt"));
  writeOld(join(root, "release", "desktop-cua-1.0.0-manual", "result.txt"));
  utimesSync(join(root, "release", "desktop-cua-1.0.0-manual"), OLD, OLD);
  writeOld(join(root, "release", "desktop-preflight-2.0.0-20260701T120000Z", "result.txt"));
  return root;
}

function testUnsafeLinkIsFailClosed() {
  const root = mkdtempSync(join(tmpdir(), "patchwarden-release-retention-link-"));
  const outside = mkdtempSync(join(tmpdir(), "patchwarden-release-retention-outside-"));
  roots.push(root, outside);
  writeJson(join(root, "package.json"), { name: "patchwarden", version: "2.0.0" });
  writeOld(join(root, "PatchWarden-v1.0.0.tar.gz"));
  const unsafePath = join(root, "release", "desktop-preflight-1.0.0-20260701T120000Z");
  mkdirSync(join(root, "release"), { recursive: true });
  symlinkSync(outside, unsafePath, process.platform === "win32" ? "junction" : "dir");

  const result = pruneLocalArtifacts({ root, now: NOW, apply: true });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((item) => item.path === "release/desktop-preflight-1.0.0-20260701T120000Z"));
  assert.equal(result.deleted.length, 0, "unsafe preflight must prevent every deletion");
  assert.equal(existsSync(join(root, "PatchWarden-v1.0.0.tar.gz")), true);
}

function testUnsafeContainerIsFailClosed() {
  const root = mkdtempSync(join(tmpdir(), "patchwarden-release-retention-container-"));
  const outside = mkdtempSync(join(tmpdir(), "patchwarden-release-retention-outside-container-"));
  roots.push(root, outside);
  writeJson(join(root, "package.json"), { name: "patchwarden", version: "2.0.0" });
  writeOld(join(root, "PatchWarden-v1.0.0.zip"));
  writeOld(join(outside, "desktop-preflight-1.0.0-20260701T120000Z", "result.txt"));
  symlinkSync(outside, join(root, "release"), process.platform === "win32" ? "junction" : "dir");

  const result = pruneLocalArtifacts({ root, now: NOW, apply: true });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((item) => item.path === "release" && item.reason === "unsafe_container"));
  assert.equal(result.deleted.length, 0, "unsafe release container must prevent every deletion");
  assert.equal(existsSync(join(root, "PatchWarden-v1.0.0.zip")), true);
  assert.equal(existsSync(join(outside, "desktop-preflight-1.0.0-20260701T120000Z", "result.txt")), true);
}

function testPartialDeleteFailure() {
  const root = mkdtempSync(join(tmpdir(), "patchwarden-release-retention-failure-"));
  roots.push(root);
  writeJson(join(root, "package.json"), { name: "patchwarden", version: "2.0.0" });
  writeOld(join(root, "PatchWarden-v1.0.0.zip"));
  writeOld(join(root, "PatchWarden-v1.1.0.zip"));
  let calls = 0;
  const result = pruneLocalArtifacts({
    root,
    now: NOW,
    apply: true,
    removePath(path) {
      calls += 1;
      if (calls === 2) throw new Error("simulated delete failure");
      rmSync(path, { recursive: true, force: false });
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.deleted.length, 1);
  assert.equal(result.failed.length, 1);
  assert.equal(calls, 2, "cleanup must stop after the first delete failure");
}

function writeJson(path, value, time = RECENT) {
  writeFile(path, `${JSON.stringify(value, null, 2)}\n`, time);
}

function writeOld(path) {
  writeFile(path, "old", OLD);
}

function writeRecent(path) {
  writeFile(path, "recent", RECENT);
}

function writeFile(path, content, time) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf-8");
  utimesSync(path, time, time);
}
