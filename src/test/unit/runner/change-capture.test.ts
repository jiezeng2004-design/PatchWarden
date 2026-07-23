import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  captureRepoSnapshot,
  compareSnapshots,
  findNewExternalDirtyFiles,
  sanitizeDiffEvidence,
  type ExternalDirtyFile,
  type FileFingerprint,
  type RepoSnapshot,
} from "../../../runner/changeCapture.js";

const fingerprint = (sha256: string): FileFingerprint => ({
  size: 1,
  sha256,
  tracked: true,
  ignored: false,
});

describe("change evidence safety", () => {
  it("redacts credential-like diff content before persistence", () => {
    const token = `ghp_${"a".repeat(24)}`;
    const result = sanitizeDiffEvidence(`+API_TOKEN=${token}\n`);
    assert.equal(result.redacted, true);
    assert.equal(result.content.includes(token), false);
    assert.match(result.content, /REDACTED/);
  });

  it("caps evidence by UTF-8 bytes and records truncation", () => {
    const result = sanitizeDiffEvidence(`+${"界".repeat(100)}`, 64);
    assert.equal(result.truncated, true);
    assert.ok(Buffer.byteLength(result.content, "utf-8") <= 64);
    assert.match(result.content, /DIFF TRUNCATED/);
  });
});

const snapshot = (files: Record<string, FileFingerprint>): RepoSnapshot => ({
  captured_at: "2026-07-19T00:00:00.000Z",
  is_git: true,
  head: "abc",
  status: "",
  workspace_dirty: false,
  files,
  dirty_paths: [],
  warnings: [],
});

describe("change capture cancellation", () => {
  it("rejects before starting work when the signal is already aborted", async () => {
    const root = mkdtempSync(join(tmpdir(), "patchwarden-change-capture-"));
    const controller = new AbortController();
    controller.abort(new Error("snapshot canceled"));
    try {
      await assert.rejects(
        captureRepoSnapshot(root, controller.signal),
        /snapshot canceled/
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("change capture path comparison", () => {
  it("preserves a case-only Windows rename as evidence", () => {
    const before = snapshot({ "README.md": fingerprint("same") });
    const after = snapshot({ "readme.md": fingerprint("same") });

    const changes = compareSnapshots(before, after, "win32");
    assert.equal(changes.length, 1);
    assert.equal(changes[0].change, "renamed");
    assert.equal(changes[0].old_path, "README.md");
    assert.equal(changes[0].path, "readme.md");
  });

  it("reports one modification for a changed Windows case variant", () => {
    const before = snapshot({ "SRC/Index.ts": fingerprint("before") });
    const after = snapshot({ "src/index.ts": fingerprint("after") });

    const changes = compareSnapshots(before, after, "win32");
    assert.equal(changes.length, 1);
    assert.equal(changes[0].change, "modified");
    assert.equal(changes[0].path, "src/index.ts");
  });

  it("preserves case-sensitive rename evidence on POSIX", () => {
    const before = snapshot({ "README.md": fingerprint("same") });
    const after = snapshot({ "readme.md": fingerprint("same") });

    const changes = compareSnapshots(before, after, "linux");
    assert.equal(changes.length, 1);
    assert.equal(changes[0].change, "renamed");
    assert.equal(changes[0].old_path, "README.md");
    assert.equal(changes[0].path, "readme.md");
  });

  it("does not collapse colliding paths in a case-sensitive Windows directory", () => {
    const before = snapshot({
      "src/Name.ts": fingerprint("upper"),
      "src/name.ts": fingerprint("lower-before"),
    });
    const after = snapshot({
      "src/Name.ts": fingerprint("upper"),
      "src/name.ts": fingerprint("lower-after"),
    });

    const changes = compareSnapshots(before, after, "win32");
    assert.equal(changes.length, 1);
    assert.equal(changes[0].change, "modified");
    assert.equal(changes[0].path, "src/name.ts");
  });

  it("matches external dirty baselines case-insensitively on Windows", () => {
    const baseline: ExternalDirtyFile[] = [{
      path: "Shared/State.json",
      change: "modified",
      before_sha256: "same",
      after_sha256: null,
    }];
    const current: ExternalDirtyFile[] = [{
      path: "shared/state.json",
      change: "modified",
      before_sha256: "same",
      after_sha256: null,
    }];

    assert.deepEqual(findNewExternalDirtyFiles(baseline, current, "win32"), []);
  });

  it("preserves colliding external baselines in case-sensitive Windows directories", () => {
    const baseline: ExternalDirtyFile[] = [
      { path: "Shared/State.json", change: "modified", before_sha256: "upper", after_sha256: null },
      { path: "Shared/state.json", change: "modified", before_sha256: "lower", after_sha256: null },
    ];
    const current: ExternalDirtyFile[] = [
      { path: "Shared/State.json", change: "modified", before_sha256: "upper", after_sha256: null },
      { path: "Shared/state.json", change: "modified", before_sha256: "lower-after", after_sha256: null },
    ];

    const changes = findNewExternalDirtyFiles(baseline, current, "win32");
    assert.equal(changes.length, 1);
    assert.equal(changes[0].path, "Shared/state.json");
  });
});
