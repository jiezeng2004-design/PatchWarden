import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runPostTaskCleanup } from "../../../runner/postTaskCleanup.js";

describe("postTaskCleanup", () => {
  it("preserves untracked artifacts without process ownership evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "pw-cleanup-"));
    try {
      execFileSync("git", ["init"], { cwd: root, encoding: "utf-8", windowsHide: true });

      mkdirSync(join(root, "tracked", "__pycache__"), { recursive: true });
      writeFileSync(join(root, "tracked", "__pycache__", "keep.pyc"), "tracked", "utf-8");
      execFileSync("git", ["add", "."], { cwd: root, encoding: "utf-8", windowsHide: true });
      execFileSync("git", [
        "-c", "user.email=test@example.com",
        "-c", "user.name=PatchWarden Test",
        "commit", "--no-verify", "--no-gpg-sign", "-m", "init",
      ], { cwd: root, encoding: "utf-8", windowsHide: true });

      mkdirSync(join(root, "backend", "__pycache__"), { recursive: true });
      mkdirSync(join(root, ".venv", "__pycache__"), { recursive: true });
      mkdirSync(join(root, ".patchwarden", "tasks", "old-task", "__pycache__"), { recursive: true });
      mkdirSync(join(root, "node_modules", "pkg", "__pycache__"), { recursive: true });
      mkdirSync(join(root, "docs", "__pycache__"), { recursive: true });
      writeFileSync(join(root, "backend", "__pycache__", "drop.pyc"), "drop", "utf-8");
      writeFileSync(join(root, ".venv", "__pycache__", "skip.pyc"), "skip", "utf-8");
      writeFileSync(join(root, ".patchwarden", "tasks", "old-task", "__pycache__", "skip.pyc"), "skip", "utf-8");
      writeFileSync(join(root, "node_modules", "pkg", "__pycache__", "skip.pyc"), "skip", "utf-8");
      writeFileSync(join(root, "docs", "__pycache__", "skip.pyc"), "skip", "utf-8");

      const taskDir = join(root, ".patchwarden", "tasks", "task-1");
      mkdirSync(taskDir, { recursive: true });
      const report = runPostTaskCleanup(root, taskDir, new Set([
        "tracked/__pycache__/keep.pyc",
      ]));

      assert.ok(report.skipped.some((entry) => entry.path === "backend/__pycache__" && entry.skip_reason === "no_process_ownership_evidence"));
      assert.ok(report.skipped.some((entry) => entry.path === "tracked/__pycache__" && entry.skip_reason === "pre_existing_path"));
      assert.equal(report.source_files_touched, 0);
      assert.ok(existsSync(join(root, "backend", "__pycache__")));
      assert.ok(existsSync(join(root, "tracked", "__pycache__", "keep.pyc")));
      assert.ok(existsSync(join(root, ".venv", "__pycache__", "skip.pyc")));
      assert.ok(existsSync(join(root, ".patchwarden", "tasks", "old-task", "__pycache__", "skip.pyc")));
      assert.ok(existsSync(join(root, "node_modules", "pkg", "__pycache__", "skip.pyc")));
      assert.ok(existsSync(join(root, "docs", "__pycache__", "skip.pyc")));

      const written = JSON.parse(readFileSync(join(taskDir, "post-task-cleanup.json"), "utf-8"));
      assert.equal(written.enabled, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("removes only explicit task-owned artifacts and records the attribution", () => {
    const root = mkdtempSync(join(tmpdir(), "pw-cleanup-baseline-"));
    try {
      mkdirSync(join(root, "release_packages"), { recursive: true });
      writeFileSync(join(root, "release_packages", "important.zip"), "release", "utf-8");
      mkdirSync(join(root, "frontend", "dist"), { recursive: true });
      writeFileSync(join(root, "frontend", "dist", "generated.js"), "generated", "utf-8");

      const taskDir = join(root, ".patchwarden", "tasks", "task-2");
      mkdirSync(taskDir, { recursive: true });
      const report = runPostTaskCleanup(root, taskDir, new Set([
        "release_packages/important.zip",
      ]), new Set(["frontend/dist/generated.js"]));

      assert.ok(report.skipped.some((entry) =>
        entry.path === "release_packages" && entry.skip_reason === "pre_existing_path"));
      assert.ok(report.removed.some((entry) => entry.path === "frontend/dist"));
      assert.ok(report.removed.some((entry) => entry.attribution === "task_owned_change"));
      assert.ok(existsSync(join(root, "release_packages", "important.zip")));
      assert.ok(!existsSync(join(root, "frontend", "dist")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
