import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  captureRepoSnapshot,
  classifyArtifactHygiene,
  compareSnapshots,
  findNewExternalDirtyFiles,
  resolveGeneratedPathPatterns,
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

const classifiedFingerprint = (
  sha256: string,
  tracked: boolean,
  ignored: boolean,
): FileFingerprint => ({ size: 1, sha256, tracked, ignored });

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

  it("records sensitive path metadata without fingerprinting its content", async () => {
    const root = mkdtempSync(join(tmpdir(), "patchwarden-sensitive-snapshot-"));
    try {
      writeFileSync(join(root, ".env"), "PRIVATE_VALUE=do-not-read\n", "utf8");
      writeFileSync(join(root, "safe.txt"), "safe\n", "utf8");
      const captured = await captureRepoSnapshot(root);
      assert.equal(captured.integrity?.complete, true);
      assert.equal(captured.files[".env"], undefined);
      assert.equal(captured.sensitive_files?.[".env"]?.size, 26);
      assert.equal(typeof captured.sensitive_files?.[".env"]?.mtime_ms, "number");
      assert.equal(captured.files["safe.txt"]?.sha256.length, 64);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("marks a Git-reported sensitive dirty path incomplete", async () => {
    const root = mkdtempSync(join(tmpdir(), "patchwarden-sensitive-git-"));
    try {
      const initialized = spawnSync("git", ["init", "--quiet"], { cwd: root, encoding: "utf8", windowsHide: true });
      assert.equal(initialized.status, 0, initialized.stderr);
      writeFileSync(join(root, ".env"), "PRIVATE_VALUE=blocked\n", "utf8");
      const captured = await captureRepoSnapshot(root);
      assert.equal(captured.integrity?.complete, false);
      assert.ok(captured.integrity?.failure_codes.includes("sensitive_path_dirty"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("captures bounded ignored artifact evidence from generated directories", async () => {
    const root = mkdtempSync(join(tmpdir(), "patchwarden-artifact-snapshot-"));
    try {
      const initialized = spawnSync("git", ["init", "--quiet"], { cwd: root, encoding: "utf8", windowsHide: true });
      assert.equal(initialized.status, 0, initialized.stderr);
      mkdirSync(join(root, "coverage"), { recursive: true });
      writeFileSync(join(root, ".gitignore"), "coverage/\n", "utf8");
      writeFileSync(join(root, "coverage", "summary.txt"), "artifact\n", "utf8");
      const captured = await captureRepoSnapshot(root);
      assert.equal(captured.files["coverage/summary.txt"]?.ignored, true);
      assert.equal(captured.files["coverage/summary.txt"]?.sha256.length, 64);
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

describe("generated path classification", () => {
  it("separates source, dependency, generated, runtime, and unexpected changes", () => {
    const root = mkdtempSync(join(tmpdir(), "patchwarden-generated-paths-"));
    try {
      writeFileSync(join(root, ".gitignore"), "generated/\nsrc/\n", "utf-8");
      writeFileSync(join(root, ".npmignore"), "coverage/\nexamples/\n", "utf-8");
      const rules = resolveGeneratedPathPatterns(root, ["custom-output/**"]);
      assert.ok(rules.includes("**/generated/**"));
      assert.ok(rules.includes("**/coverage/**"));
      assert.equal(rules.includes("src/**"), false);
      assert.equal(rules.includes("examples/**"), false);

      const before = snapshot({});
      const after = snapshot({
        "src/app.ts": classifiedFingerprint("source", true, false),
        "package-lock.json": classifiedFingerprint("lock", true, false),
        "tsconfig.tsbuildinfo": classifiedFingerprint("tsbuild", false, true),
        ".next/static/old.js": classifiedFingerprint("next-ignored", false, true),
        ".next/static/tracked.js": classifiedFingerprint("next-tracked", true, false),
        "custom-output/result.bin": classifiedFingerprint("custom", false, true),
        "packages/app/generated/output.js": classifiedFingerprint("nested-generated", false, true),
        "server.log": classifiedFingerprint("runtime", false, true),
      });

      const changes = compareSnapshots(before, after, "linux", rules);
      const hygiene = classifyArtifactHygiene(changes);
      assert.deepEqual(hygiene.source_changes.map((entry) => entry.path), ["src/app.ts"]);
      assert.deepEqual(hygiene.dependency_changes?.map((entry) => entry.path), ["package-lock.json"]);
      assert.equal(hygiene.generated_changes?.length, 5);
      assert.deepEqual(hygiene.runtime_changes?.map((entry) => entry.path), ["server.log"]);
      assert.deepEqual(hygiene.unexpected_changes?.map((entry) => entry.path), [".next/static/tracked.js"]);
      assert.equal(hygiene.counts.generated_changes, 5);
      assert.equal(hygiene.counts.source_changes, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps a source rename into a generated directory classified as source", () => {
    const before = snapshot({ "src/draft.ts": classifiedFingerprint("same", false, false) });
    const after = snapshot({ ".next/draft.ts": classifiedFingerprint("same", false, true) });
    const changes = compareSnapshots(before, after, "linux");
    assert.equal(changes.length, 1);
    assert.equal(changes[0].change, "renamed");
    assert.equal(changes[0].kind, "source");
    assert.equal(changes[0].old_kind, "source");
    assert.equal(classifyArtifactHygiene(changes).source_changes.length, 1);
  });
});
