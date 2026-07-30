import { strict as assert } from "node:assert";
import { lstatSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  assertDirectVerificationSnapshotComplete,
  captureDirectVerificationWorkspaceSha256,
  computeDirectVerificationWorkspaceSha256,
} from "../../../direct/directVerificationFingerprint.js";
import { PatchWardenError } from "../../../errors.js";
import type { RepoSnapshot } from "../../../runner/changeCapture.js";
import { hashStableRegularFileSync } from "../../../utils/stableFileRead.js";

describe("Direct verification workspace fingerprint", () => {
  it("is stable across evidence-only metadata and changes with file semantics", () => {
    const base = makeSnapshot({
      "package.json": {
        size: 20,
        sha256: "a".repeat(64),
        tracked: true,
        ignored: false,
      },
      "src/check.mjs": {
        size: 30,
        sha256: "b".repeat(64),
        tracked: true,
        ignored: false,
      },
    });
    const metadataOnly = {
      ...base,
      captured_at: "2099-01-01T00:00:00.000Z",
      status: " M .patchwarden/direct-sessions/internal/session.json",
      workspace_dirty: true,
      dirty_paths: [".patchwarden/direct-sessions/internal/session.json"],
      warnings: ["repository is not a Git worktree; diff will contain file-change evidence only"],
    };
    assert.equal(
      computeDirectVerificationWorkspaceSha256(base),
      computeDirectVerificationWorkspaceSha256(metadataOnly),
    );

    const changed = makeSnapshot({
      ...base.files,
      "src/check.mjs": {
        ...base.files["src/check.mjs"],
        sha256: "c".repeat(64),
      },
    });
    assert.notEqual(
      computeDirectVerificationWorkspaceSha256(base),
      computeDirectVerificationWorkspaceSha256(changed),
    );
  });

  it("fails closed for truncated or unreadable snapshot evidence", () => {
    for (const warning of [
      "snapshot limited to 5000 files",
      "could not fingerprint: src/check.mjs",
      "snapshot incomplete: could not read directory: scripts",
      "snapshot incomplete: could not fingerprint link: verify.mjs",
    ]) {
      const snapshot = makeSnapshot({});
      snapshot.warnings = [warning];
      assert.throws(
        () => assertDirectVerificationSnapshotComplete(snapshot),
        (error: unknown) => error instanceof PatchWardenError
          && error.reason === "direct_review_workspace_snapshot_incomplete",
      );
    }
    const integrityFailure = makeSnapshot({});
    integrityFailure.integrity = {
      complete: false,
      truncated: false,
      failure_codes: ["snapshot_fingerprint_failed"],
    };
    assert.throws(
      () => assertDirectVerificationSnapshotComplete(integrityFailure),
      (error: unknown) => error instanceof PatchWardenError
        && error.reason === "direct_review_workspace_snapshot_incomplete",
    );
  });

  it("fails closed for approximate large-file fingerprints", () => {
    const snapshot = makeSnapshot({
      "verify.mjs": {
        size: 5 * 1024 * 1024 + 1,
        sha256: "large-file:5242881:123",
        tracked: true,
        ignored: false,
      },
    });
    assert.throws(
      () => assertDirectVerificationSnapshotComplete(snapshot),
      (error: unknown) => error instanceof PatchWardenError
        && error.reason === "direct_review_workspace_snapshot_incomplete",
    );
  });

  it("binds link metadata even when target content is unchanged", () => {
    const base = makeSnapshot({
      "verify.mjs": {
        size: 12,
        sha256: "a".repeat(64),
        tracked: true,
        ignored: false,
        link_target_sha256: "b".repeat(64),
        resolved_target_sha256: "c".repeat(64),
      },
    });
    const retargeted = makeSnapshot({
      "verify.mjs": {
        ...base.files["verify.mjs"],
        link_target_sha256: "d".repeat(64),
      },
    });
    assert.notEqual(
      computeDirectVerificationWorkspaceSha256(base),
      computeDirectVerificationWorkspaceSha256(retargeted),
    );
  });

  it("binds a link's literal target text and final target content", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "patchwarden-direct-link-fingerprint-"));
    const target = join(root, "verify.mjs");
    const link = join(root, "run.mjs");
    try {
      writeFileSync(target, "process.exit(0);\n", "utf-8");
      if (!tryCreateFileLink("verify.mjs", link)) {
        t.skip("File symlink creation is unavailable on this Windows host.");
        return;
      }
      const initial = await captureDirectVerificationWorkspaceSha256(root);
      unlinkSync(link);
      symlinkSync("./verify.mjs", link, "file");
      const retargetedText = await captureDirectVerificationWorkspaceSha256(root);
      assert.notEqual(initial, retargetedText);

      writeFileSync(target, "process.exit(1);\n", "utf-8");
      const changedTarget = await captureDirectVerificationWorkspaceSha256(root);
      assert.notEqual(retargetedText, changedTarget);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("binds installed dependency contents without retaining their source", async () => {
    const root = mkdtempSync(join(tmpdir(), "patchwarden-direct-dependency-fingerprint-"));
    const dependencyRoot = join(root, "node_modules", "example");
    const dependencyEntry = join(dependencyRoot, "index.cjs");
    try {
      mkdirSync(dependencyRoot, { recursive: true });
      writeFileSync(join(dependencyRoot, "package.json"), "{\"name\":\"example\",\"main\":\"index.cjs\"}\n", "utf-8");
      writeFileSync(dependencyEntry, "module.exports = 0;\n", "utf-8");
      const initial = await captureDirectVerificationWorkspaceSha256(root);

      writeFileSync(dependencyEntry, "module.exports = 7;\n", "utf-8");
      const changed = await captureDirectVerificationWorkspaceSha256(root);
      assert.notEqual(initial, changed);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when the corroborating dependency sample observes tree drift", async () => {
    const root = mkdtempSync(join(tmpdir(), "patchwarden-direct-dependency-drift-"));
    try {
      const dependencyRoot = join(root, "node_modules", "example");
      mkdirSync(dependencyRoot, { recursive: true });
      writeFileSync(join(dependencyRoot, "package.json"), "{\"name\":\"example\"}\n", "utf-8");
      await assert.rejects(
        captureDirectVerificationWorkspaceSha256(root, {
          afterFirstSample: () => writeFileSync(join(dependencyRoot, "index.cjs"), "module.exports = 0;\n", "utf-8"),
        }),
        (error: unknown) => error instanceof PatchWardenError
          && error.reason === "direct_review_workspace_snapshot_incomplete",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed rather than reading a sensitive installed dependency path", async () => {
    const root = mkdtempSync(join(tmpdir(), "patchwarden-direct-sensitive-dependency-"));
    try {
      const dependencyRoot = join(root, "node_modules", "example");
      mkdirSync(dependencyRoot, { recursive: true });
      writeFileSync(join(dependencyRoot, ".env"), "DO_NOT_READ=secret\n", "utf-8");
      await assert.rejects(
        captureDirectVerificationWorkspaceSha256(root),
        (error: unknown) => error instanceof PatchWardenError
          && error.reason === "direct_review_workspace_snapshot_incomplete",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("checks the opened descriptor against the inspected file identity before hashing", () => {
    const root = mkdtempSync(join(tmpdir(), "patchwarden-direct-stable-read-"));
    const file = join(root, "entry.cjs");
    try {
      writeFileSync(file, "module.exports = 0;\n", "utf-8");
      const inspected = lstatSync(file);
      writeFileSync(file, "module.exports = 1000;\n", "utf-8");
      assert.throws(
        () => hashStableRegularFileSync(file, inspected),
        /File identity changed before content could be read/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when a link is outside, missing, sensitive, or non-file", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "patchwarden-direct-link-incomplete-"));
    const outside = mkdtempSync(join(tmpdir(), "patchwarden-direct-link-outside-"));
    try {
      writeFileSync(join(outside, "verify.mjs"), "process.exit(0);\n", "utf-8");
      mkdirSync(join(root, "directory-target"));
      writeFileSync(join(root, ".env"), "not-read\n", "utf-8");
      if (!tryCreateFileLink(join(outside, "verify.mjs"), join(root, "outside.mjs"))) {
        t.skip("File symlink creation is unavailable on this Windows host.");
        return;
      }
      symlinkSync("missing.mjs", join(root, "missing.mjs"), "file");
      symlinkSync(".env", join(root, "sensitive.mjs"), "file");
      symlinkSync("directory-target", join(root, "directory.mjs"), process.platform === "win32" ? "junction" : "dir");

      await assert.rejects(
        captureDirectVerificationWorkspaceSha256(root),
        (error: unknown) => error instanceof PatchWardenError
          && error.reason === "direct_review_workspace_snapshot_incomplete",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

function tryCreateFileLink(target: string, path: string): boolean {
  try {
    symlinkSync(target, path, "file");
    return true;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String((error as NodeJS.ErrnoException).code || "")
      : "";
    if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP") return false;
    throw error;
  }
}

function makeSnapshot(files: RepoSnapshot["files"]): RepoSnapshot {
  return {
    captured_at: "2026-07-30T00:00:00.000Z",
    is_git: false,
    head: null,
    status: "",
    workspace_dirty: false,
    files,
    dirty_paths: [],
    warnings: [],
  };
}
