#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixture = mkdtempSync(join(tmpdir(), "patchwarden-pack-boundary-"));
const repo = join(fixture, "repo");
const outside = join(fixture, "outside");

try {
  mkdirSync(join(repo, "scripts", "release"), { recursive: true });
  mkdirSync(join(repo, "dist"), { recursive: true });
  mkdirSync(join(repo, "examples"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  copyFileSync(join(root, "scripts", "release", "pack-clean.js"), join(repo, "scripts", "release", "pack-clean.js"));
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "pack-boundary-fixture", version: "1.0.0", type: "module" }), "utf8");
  writeFileSync(join(repo, "README.md"), "fixture\n", "utf8");
  writeFileSync(join(repo, "CONTRIBUTORS.md"), "fixture\n", "utf8");
  writeFileSync(join(repo, "dist", "index.js"), "export {};\n", "utf8");
  writeFileSync(join(outside, "canary.txt"), "must-not-be-packaged\n", "utf8");
  symlinkSync(outside, join(repo, "examples", "escape"), process.platform === "win32" ? "junction" : "dir");

  const result = spawnSync(process.execPath, [join(repo, "scripts", "release", "pack-clean.js")], {
    cwd: repo,
    encoding: "utf8",
    windowsHide: true,
  });
  const stagedCanary = join(repo, "release", "package", "examples", "escape", "canary.txt");
  if (result.status === 0 || existsSync(stagedCanary)) {
    throw new Error(
      `pack-clean followed an included symlink/junction outside the repository. exit=${result.status}\n${result.stdout}\n${result.stderr}`,
    );
  }
  if (readFileSync(join(outside, "canary.txt"), "utf8") !== "must-not-be-packaged\n") {
    throw new Error("pack-clean modified the outside canary");
  }
  removeDirectoryLink(join(repo, "examples", "escape"));

  const outsideStage = join(fixture, "outside-stage");
  mkdirSync(outsideStage, { recursive: true });
  writeFileSync(join(outsideStage, "delete-canary.txt"), "must-not-be-deleted\n", "utf8");
  rmSync(join(repo, "release", "package"), { recursive: true, force: true });
  symlinkSync(outsideStage, join(repo, "release", "package"), process.platform === "win32" ? "junction" : "dir");
  const deleteBoundary = spawnSync(process.execPath, [join(repo, "scripts", "release", "pack-clean.js")], {
    cwd: repo,
    encoding: "utf8",
    windowsHide: true,
  });
  if (deleteBoundary.status === 0) {
    throw new Error(`pack-clean accepted a linked release/package deletion target\n${deleteBoundary.stdout}\n${deleteBoundary.stderr}`);
  }
  if (readFileSync(join(outsideStage, "delete-canary.txt"), "utf8") !== "must-not-be-deleted\n") {
    throw new Error("pack-clean deleted through a linked release/package staging path");
  }

  console.log("ok - pack-clean rejects included and staging symlink/junction boundaries");
} finally {
  rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}

function removeDirectoryLink(path) {
  if (process.platform === "win32") rmdirSync(path);
  else unlinkSync(path);
}
