import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, mkdirSync, readdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { applyPatch } from "../../../tools/workspace/applyPatch.js";
import { createDirectSession } from "../../../direct/directSessionStore.js";
import { reloadConfig } from "../../../config.js";
import { PatchWardenError } from "../../../errors.js";
import type { RepoSnapshot } from "../../../runner/changeCapture.js";
import type { PatchOperation } from "../../../direct/directPatch.js";

// ── Helpers ────────────────────────────────────────────────────────

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

function makeSnapshot(): RepoSnapshot {
  return {
    captured_at: new Date().toISOString(),
    is_git: false,
    head: null,
    status: "",
    workspace_dirty: false,
    files: {},
    dirty_paths: [],
    warnings: [],
  };
}

function bootstrapWorkspace(prefix: string, maxPatchBytes: number, maxFileBytes = 500_000): {
  tempDir: string;
  repoPath: string;
  sessionId: string;
} {
  const tempDir = mkdtempSync(join(tmpdir(), prefix));
  const repoPath = join(tempDir, "my-repo");
  mkdirSync(repoPath, { recursive: true });
  mkdirSync(join(repoPath, "src"), { recursive: true });

  const configPath = join(tempDir, "patchwarden.config.json");
  writeFileSync(configPath, JSON.stringify({
    workspaceRoot: tempDir,
    agents: { codex: { command: "codex", args: ["exec", "{prompt}"] } },
    allowedTestCommands: ["npm test"],
    directMaxPatchBytes: maxPatchBytes,
    directMaxFileBytes: maxFileBytes,
  }), "utf-8");
  process.env.PATCHWARDEN_CONFIG = configPath;
  reloadConfig();

  const session = createDirectSession({
    repo_path: "my-repo",
    resolved_repo_path: repoPath,
    title: "applyPatch test",
    snapshot: makeSnapshot(),
  });

  return { tempDir, repoPath, sessionId: session.session_id };
}

function teardownWorkspace(tempDir: string): void {
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.PATCHWARDEN_CONFIG;
  reloadConfig();
}

// ── Success cases ──────────────────────────────────────────────────

describe("applyPatch success cases", () => {
  let tempDir: string;
  let repoPath: string;
  let sessionId: string;

  beforeEach(() => {
    const ws = bootstrapWorkspace("pw-applypatch-ok-", 200_000);
    tempDir = ws.tempDir;
    repoPath = ws.repoPath;
    sessionId = ws.sessionId;
  });

  afterEach(() => {
    teardownWorkspace(tempDir);
  });

  it("applies replace_exact operation", () => {
    const filePath = join(repoPath, "src", "main.ts");
    const original = "hello world";
    writeFileSync(filePath, original, "utf-8");

    const operations: PatchOperation[] = [
      { type: "replace_exact", old_text: "world", new_text: "there" },
    ];

    const result = applyPatch({
      session_id: sessionId,
      path: "src/main.ts",
      expected_sha256: sha256(original),
      operations,
    });

    assert.equal(result.path, "src/main.ts");
    assert.equal(result.before_sha256, sha256(original));
    assert.equal(result.after_sha256, sha256("hello there"));
    assert.equal(result.operations_applied, 1);
    assert.equal(result.bytes_changed, 0);
    assert.ok(result.next_action.length > 0);
    assert.equal(readFileSync(filePath, "utf-8"), "hello there");
    assert.deepEqual(
      readdirSync(dirname(filePath)).filter((name) => name.endsWith(".tmp")),
      [],
      "atomic replacement must not leave temporary files",
    );
  });

  it("applies insert_before operation", () => {
    const filePath = join(repoPath, "src", "main.ts");
    const original = "hello world";
    writeFileSync(filePath, original, "utf-8");

    const operations: PatchOperation[] = [
      { type: "insert_before", old_text: "world", new_text: "beautiful " },
    ];

    const result = applyPatch({
      session_id: sessionId,
      path: "src/main.ts",
      expected_sha256: sha256(original),
      operations,
    });

    assert.equal(readFileSync(filePath, "utf-8"), "hello beautiful world");
    assert.equal(result.after_sha256, sha256("hello beautiful world"));
    assert.equal(result.operations_applied, 1);
    assert.equal(result.bytes_changed, 10);
  });

  it("applies insert_after operation", () => {
    const filePath = join(repoPath, "src", "main.ts");
    const original = "hello world";
    writeFileSync(filePath, original, "utf-8");

    const operations: PatchOperation[] = [
      { type: "insert_after", old_text: "hello", new_text: " beautiful" },
    ];

    const result = applyPatch({
      session_id: sessionId,
      path: "src/main.ts",
      expected_sha256: sha256(original),
      operations,
    });

    assert.equal(readFileSync(filePath, "utf-8"), "hello beautiful world");
    assert.equal(result.after_sha256, sha256("hello beautiful world"));
    assert.equal(result.operations_applied, 1);
    assert.equal(result.bytes_changed, 10);
  });

  it("applies replace_whole_file operation", () => {
    const filePath = join(repoPath, "src", "main.ts");
    const original = "hello world";
    writeFileSync(filePath, original, "utf-8");

    const newContent = "completely new content";
    const operations: PatchOperation[] = [
      { type: "replace_whole_file", new_text: newContent },
    ];

    const result = applyPatch({
      session_id: sessionId,
      path: "src/main.ts",
      expected_sha256: sha256(original),
      operations,
    });

    assert.equal(readFileSync(filePath, "utf-8"), newContent);
    assert.equal(result.after_sha256, sha256(newContent));
    assert.equal(result.operations_applied, 1);
    assert.equal(result.bytes_changed, 11);
  });
});

// ── Rejection cases ────────────────────────────────────────────────

describe("applyPatch rejection cases", () => {
  let tempDir: string;
  let repoPath: string;
  let sessionId: string;

  beforeEach(() => {
    const ws = bootstrapWorkspace("pw-applypatch-rej-", 200_000);
    tempDir = ws.tempDir;
    repoPath = ws.repoPath;
    sessionId = ws.sessionId;
  });

  afterEach(() => {
    teardownWorkspace(tempDir);
  });

  it("rejects when expected_sha256 does not match", () => {
    const filePath = join(repoPath, "src", "main.ts");
    writeFileSync(filePath, "hello world", "utf-8");

    assert.throws(
      () => applyPatch({
        session_id: sessionId,
        path: "src/main.ts",
        expected_sha256: "0".repeat(64),
        operations: [{ type: "replace_whole_file", new_text: "new" }],
      }),
      (err: unknown) =>
        err instanceof PatchWardenError && err.reason === "file_hash_mismatch"
    );

    // File content must remain unchanged after rejection
    assert.equal(readFileSync(filePath, "utf-8"), "hello world");
  });

  it("rejects binary files (e.g. .png)", () => {
    const filePath = join(repoPath, "src", "image.png");
    writeFileSync(filePath, "fake png content", "utf-8");

    assert.throws(
      () => applyPatch({
        session_id: sessionId,
        path: "src/image.png",
        expected_sha256: sha256("fake png content"),
        operations: [{ type: "replace_whole_file", new_text: "new" }],
      }),
      (err: unknown) =>
        err instanceof PatchWardenError && err.reason === "binary_file_blocked"
    );

    // File content must remain unchanged after rejection
    assert.equal(readFileSync(filePath, "utf-8"), "fake png content");
  });

  it("rejects paths outside workspaceRoot", () => {
    assert.throws(
      () => applyPatch({
        session_id: sessionId,
        path: "../../../etc/passwd",
        expected_sha256: sha256("dummy"),
        operations: [{ type: "replace_whole_file", new_text: "new" }],
      }),
      PatchWardenError
    );
  });

  it("rejects credential-like content without changing the file", () => {
    const filePath = join(repoPath, "src", "main.ts");
    const original = "export const value = 'safe';\n";
    const token = `ghp_${"a".repeat(24)}`;
    writeFileSync(filePath, original, "utf-8");

    assert.throws(
      () => applyPatch({
        session_id: sessionId,
        path: "src/main.ts",
        expected_sha256: sha256(original),
        operations: [{ type: "replace_whole_file", new_text: `export const token = '${token}';\n` }],
      }),
      (err: unknown) => err instanceof PatchWardenError && err.reason === "sensitive_content_blocked",
    );
    assert.equal(readFileSync(filePath, "utf-8"), original);
  });

  it("rejects non-UTF-8 patch targets without rewriting them", () => {
    const filePath = join(repoPath, "src", "main.ts");
    const original = Buffer.from([0xc3, 0x28]);
    writeFileSync(filePath, original);
    const expected = createHash("sha256").update(original).digest("hex");

    assert.throws(
      () => applyPatch({
        session_id: sessionId,
        path: "src/main.ts",
        expected_sha256: expected,
        operations: [{ type: "replace_whole_file", new_text: "safe" }],
      }),
      (err: unknown) => err instanceof PatchWardenError && err.reason === "unsupported_text_encoding",
    );
    assert.deepEqual(readFileSync(filePath), original);
  });
});

// ── Patch size limit ───────────────────────────────────────────────

describe("applyPatch patch size limit", () => {
  let tempDir: string;
  let repoPath: string;
  let sessionId: string;

  beforeEach(() => {
    const ws = bootstrapWorkspace("pw-applypatch-size-", 100);
    tempDir = ws.tempDir;
    repoPath = ws.repoPath;
    sessionId = ws.sessionId;
  });

  afterEach(() => {
    teardownWorkspace(tempDir);
  });

  it("rejects patches exceeding directMaxPatchBytes", () => {
    const filePath = join(repoPath, "src", "main.ts");
    writeFileSync(filePath, "hello world", "utf-8");

    // Build a patch whose JSON.stringify length exceeds the 100-byte limit
    const bigText = "x".repeat(80);
    const operations: PatchOperation[] = [
      { type: "replace_whole_file", new_text: bigText },
    ];
    assert.ok(JSON.stringify(operations).length > 100);

    assert.throws(
      () => applyPatch({
        session_id: sessionId,
        path: "src/main.ts",
        expected_sha256: sha256("hello world"),
        operations,
      }),
      (err: unknown) =>
        err instanceof PatchWardenError && err.reason === "patch_too_large"
    );

    // File content must remain unchanged after rejection
    assert.equal(readFileSync(filePath, "utf-8"), "hello world");
  });

  it("counts multi-byte patch content by UTF-8 bytes", () => {
    const filePath = join(repoPath, "src", "main.ts");
    writeFileSync(filePath, "hello", "utf-8");
    const operations: PatchOperation[] = [
      { type: "replace_whole_file", new_text: "界".repeat(25) },
    ];
    assert.ok(JSON.stringify(operations).length < 100);
    assert.ok(Buffer.byteLength(JSON.stringify(operations), "utf-8") > 100);

    assert.throws(
      () => applyPatch({
        session_id: sessionId,
        path: "src/main.ts",
        expected_sha256: sha256("hello"),
        operations,
      }),
      (err: unknown) => err instanceof PatchWardenError && err.reason === "patch_too_large",
    );
  });
});

describe("applyPatch output size limit", () => {
  let tempDir: string;
  let repoPath: string;
  let sessionId: string;

  beforeEach(() => {
    const ws = bootstrapWorkspace("pw-applypatch-output-size-", 1_000, 100);
    tempDir = ws.tempDir;
    repoPath = ws.repoPath;
    sessionId = ws.sessionId;
  });

  afterEach(() => teardownWorkspace(tempDir));

  it("rejects a patch result exceeding directMaxFileBytes", () => {
    const filePath = join(repoPath, "src", "main.ts");
    writeFileSync(filePath, "small", "utf-8");
    assert.throws(
      () => applyPatch({
        session_id: sessionId,
        path: "src/main.ts",
        expected_sha256: sha256("small"),
        operations: [{ type: "replace_whole_file", new_text: "x".repeat(101) }],
      }),
      (err: unknown) => err instanceof PatchWardenError && err.reason === "file_too_large",
    );
    assert.equal(readFileSync(filePath, "utf-8"), "small");
  });
});
