import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { syncFile } from "../../../tools/workspace/syncFile.js";
import { computeFileSha256 } from "../../../direct/directPatch.js";
import {
  isValidDirectSessionId,
  readDirectSession,
} from "../../../direct/directSessionStore.js";
import { PatchWardenError } from "../../../errors.js";
import type { PatchWardenConfig } from "../../../config.js";

function makeConfig(workspaceRoot: string): PatchWardenConfig {
  return {
    workspaceRoot,
    plansDir: ".patchwarden/plans",
    tasksDir: ".patchwarden/tasks",
    assessmentsDir: ".patchwarden/assessments",
    assessmentTtlSeconds: 3600,
    agents: { codex: { command: "codex", args: ["exec", "{prompt}"] } },
    allowedTestCommands: ["npm test"],
    repoAllowedTestCommands: {},
    maxReadFileBytes: 200_000,
    defaultTaskTimeoutSeconds: 900,
    maxTaskTimeoutSeconds: 3600,
    watcherStaleSeconds: 30,
    directSessionsDir: ".patchwarden/direct-sessions",
    directSessionTtlSeconds: 3600,
    directMaxPatchBytes: 200_000,
    directMaxFileBytes: 500_000,
  };
}

function linkDirectory(target: string, linkPath: string): void {
  symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
}

describe("syncFile", () => {
  let tempDir: string;
  let config: PatchWardenConfig;
  let repoPath: string;
  let sessionsDir: string;
  let sessionId: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pw-syncfile-"));
    config = makeConfig(tempDir);
    repoPath = join(tempDir, "my-repo");
    sessionsDir = join(tempDir, ".patchwarden", "direct-sessions");
    sessionId = "test-session-001";

    mkdirSync(repoPath, { recursive: true });
    mkdirSync(join(sessionsDir, sessionId), { recursive: true });

    writeFileSync(
      join(sessionsDir, sessionId, "session.json"),
      JSON.stringify({
        session_id: sessionId,
        repo_path: repoPath,
        resolved_repo_path: repoPath,
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        operations: [],
        verification_runs: [],
        finalized: false,
      }),
      "utf-8"
    );
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("copies a file from source to target", () => {
    const sourceContent = "console.log('hello world');";
    mkdirSync(join(repoPath, "mobile_app"), { recursive: true });
    writeFileSync(join(repoPath, "mobile_app", "app.js"), sourceContent, "utf-8");

    const result = syncFile(sessionId, "mobile_app/app.js", "windows_app/app/app.js", undefined, config);

    assert.equal(result.changed, true);
    assert.equal(result.copied_bytes, sourceContent.length);
    assert.equal(result.before_target_sha256, null);
    assert.ok(result.after_target_sha256);

    const targetContent = readFileSync(join(repoPath, "windows_app", "app", "app.js"), "utf-8");
    assert.equal(targetContent, sourceContent);
    const operation = readDirectSession(sessionId, config).operations.at(-1);
    assert.equal(operation?.operation_type, "sync");
    assert.equal(operation?.source_path, "mobile_app/app.js");
    assert.equal(operation?.path, "windows_app/app/app.js");
    assert.equal(operation?.before_sha256, null);
    assert.equal(operation?.after_sha256, result.after_target_sha256);
    assert.equal(operation?.operations_applied, 1);
  });

  it("returns changed=false when target already has same content", () => {
    const sourceContent = "same content";
    mkdirSync(join(repoPath, "src"), { recursive: true });
    mkdirSync(join(repoPath, "dst"), { recursive: true });
    writeFileSync(join(repoPath, "src", "file.ts"), sourceContent, "utf-8");
    writeFileSync(join(repoPath, "dst", "file.ts"), sourceContent, "utf-8");

    const result = syncFile(sessionId, "src/file.ts", "dst/file.ts", undefined, config);

    assert.equal(result.changed, false);
    assert.ok(result.before_target_sha256);
    assert.equal(result.before_target_sha256, result.after_target_sha256);
    const operation = readDirectSession(sessionId, config).operations.at(-1);
    assert.equal(operation?.operation_type, "sync");
    assert.equal(operation?.operations_applied, 0);
    assert.equal(operation?.bytes_changed, 0);
  });

  it("returns changed=true when target has different content", () => {
    mkdirSync(join(repoPath, "src"), { recursive: true });
    mkdirSync(join(repoPath, "dst"), { recursive: true });
    writeFileSync(join(repoPath, "src", "file.ts"), "new content", "utf-8");
    writeFileSync(join(repoPath, "dst", "file.ts"), "old content", "utf-8");

    const result = syncFile(sessionId, "src/file.ts", "dst/file.ts", undefined, config);

    assert.equal(result.changed, true);
    assert.notEqual(result.before_target_sha256, result.after_target_sha256);
  });

  it("rejects source path outside repo", () => {
    mkdirSync(join(repoPath, "src"), { recursive: true });
    writeFileSync(join(repoPath, "src", "file.ts"), "content", "utf-8");

    assert.throws(
      () => syncFile(sessionId, "../../../etc/passwd", "dst/file.ts", undefined, config),
      Error
    );
  });

  it("rejects target path outside repo", () => {
    mkdirSync(join(repoPath, "src"), { recursive: true });
    writeFileSync(join(repoPath, "src", "file.ts"), "content", "utf-8");

    assert.throws(
      () => syncFile(sessionId, "src/file.ts", "../../../etc/evil", undefined, config),
      Error
    );
  });

  it("rejects sensitive source files", () => {
    writeFileSync(join(repoPath, ".env"), "SECRET=abc123", "utf-8");

    assert.throws(
      () => syncFile(sessionId, ".env", "dst/.env", undefined, config),
      Error
    );
  });

  it("rejects sensitive target files", () => {
    mkdirSync(join(repoPath, "src"), { recursive: true });
    writeFileSync(join(repoPath, "src", "file.ts"), "content", "utf-8");

    assert.throws(
      () => syncFile(sessionId, "src/file.ts", "config.json", undefined, config),
      Error
    );
  });

  it("rejects writing to node_modules", () => {
    mkdirSync(join(repoPath, "src"), { recursive: true });
    writeFileSync(join(repoPath, "src", "file.ts"), "content", "utf-8");

    assert.throws(
      () => syncFile(sessionId, "src/file.ts", "node_modules/evil/index.js", undefined, config),
      Error
    );
  });

  it("rejects writing to dist", () => {
    mkdirSync(join(repoPath, "src"), { recursive: true });
    writeFileSync(join(repoPath, "src", "file.ts"), "content", "utf-8");

    assert.throws(
      () => syncFile(sessionId, "src/file.ts", "dist/main.js", undefined, config),
      Error
    );
  });

  it("rejects non-existent session", () => {
    mkdirSync(join(repoPath, "src"), { recursive: true });
    writeFileSync(join(repoPath, "src", "file.ts"), "content", "utf-8");

    assert.throws(
      () => syncFile("non-existent-session", "src/file.ts", "dst/file.ts", undefined, config),
      Error
    );
  });

  it("rejects invalid and mismatched session IDs before loading session state", () => {
    assert.equal(isValidDirectSessionId(sessionId), true);
    assert.equal(isValidDirectSessionId("../test-session-001"), false);
    assert.equal(isValidDirectSessionId("test-session-001:stream"), false);

    assert.throws(
      () => syncFile("../test-session-001", "src/file.ts", "dst/file.ts", undefined, config),
      (err: unknown) => err instanceof PatchWardenError && err.reason === "invalid_session_id"
    );

    const sessionFile = join(sessionsDir, sessionId, "session.json");
    const session = JSON.parse(readFileSync(sessionFile, "utf-8"));
    writeFileSync(
      sessionFile,
      JSON.stringify({ ...session, session_id: "different-session" }),
      "utf-8"
    );
    assert.throws(
      () => syncFile(sessionId, "src/file.ts", "dst/file.ts", undefined, config),
      (err: unknown) => err instanceof PatchWardenError && err.reason === "invalid_session_record"
    );
  });

  it("rejects a valid-looking session directory junction outside the session store", () => {
    const linkedSessionId = "linked-session-001";
    const outside = mkdtempSync(join(tmpdir(), "pw-linked-session-"));
    try {
      writeFileSync(
        join(outside, "session.json"),
        JSON.stringify({
          session_id: linkedSessionId,
          repo_path: repoPath,
          resolved_repo_path: repoPath,
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          finalized: false,
        }),
        "utf-8"
      );
      linkDirectory(outside, join(sessionsDir, linkedSessionId));

      assert.throws(
        () => syncFile(linkedSessionId, "src/file.ts", "dst/file.ts", undefined, config),
        (err: unknown) => err instanceof PatchWardenError && err.reason === "workspace_path_escape"
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects expired and finalized sessions without writing", () => {
    mkdirSync(join(repoPath, "src"), { recursive: true });
    writeFileSync(join(repoPath, "src", "file.ts"), "content", "utf-8");
    const sessionFile = join(sessionsDir, sessionId, "session.json");
    const session = JSON.parse(readFileSync(sessionFile, "utf-8"));

    writeFileSync(
      sessionFile,
      JSON.stringify({ ...session, expires_at: new Date(Date.now() - 60_000).toISOString() }),
      "utf-8"
    );
    assert.throws(
      () => syncFile(sessionId, "src/file.ts", "dst/expired.ts", undefined, config),
      (err: unknown) => err instanceof PatchWardenError && err.reason === "session_expired"
    );
    assert.equal(existsSync(join(repoPath, "dst", "expired.ts")), false);

    writeFileSync(
      sessionFile,
      JSON.stringify({
        ...session,
        finalized: true,
        finalized_at: new Date().toISOString(),
      }),
      "utf-8"
    );
    assert.throws(
      () => syncFile(sessionId, "src/file.ts", "dst/finalized.ts", undefined, config),
      (err: unknown) => err instanceof PatchWardenError && err.reason === "session_finalized"
    );
    assert.equal(existsSync(join(repoPath, "dst", "finalized.ts")), false);
  });

  it("rejects internal, ADS, and symlink/junction escape paths", () => {
    mkdirSync(join(repoPath, "src"), { recursive: true });
    mkdirSync(join(repoPath, ".patchwarden"), { recursive: true });
    writeFileSync(join(repoPath, "src", "file.ts"), "content", "utf-8");
    writeFileSync(join(repoPath, ".patchwarden", "state.txt"), "internal", "utf-8");

    assert.throws(
      () => syncFile(sessionId, ".patchwarden/state.txt", "dst/state.txt", undefined, config),
      (err: unknown) => err instanceof PatchWardenError && err.reason === "internal_patchwarden_path_blocked"
    );
    assert.throws(
      () => syncFile(sessionId, "src/file.ts", "dst/file.ts::$DATA", undefined, config),
      (err: unknown) => err instanceof PatchWardenError && err.reason === "windows_ads_path_blocked"
    );

    const outside = mkdtempSync(join(tmpdir(), "pw-syncfile-outside-"));
    try {
      linkDirectory(outside, join(repoPath, "escape-link"));
      assert.throws(
        () => syncFile(sessionId, "src/file.ts", "escape-link/copied.ts", undefined, config),
        (err: unknown) => err instanceof PatchWardenError && err.reason === "path_outside_repo"
      );
      assert.equal(existsSync(join(outside, "copied.ts")), false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects non-existent source file", () => {
    assert.throws(
      () => syncFile(sessionId, "non-existent/file.ts", "dst/file.ts", undefined, config),
      Error
    );
  });

  it("rejects source files exceeding directMaxFileBytes", () => {
    config.directMaxFileBytes = 8;
    mkdirSync(join(repoPath, "src"), { recursive: true });
    writeFileSync(join(repoPath, "src", "large.ts"), "123456789", "utf-8");
    assert.throws(
      () => syncFile(sessionId, "src/large.ts", "dst/large.ts", undefined, config),
      (err: unknown) => err instanceof PatchWardenError && err.reason === "file_too_large",
    );
    assert.equal(existsSync(join(repoPath, "dst", "large.ts")), false);
  });

  it("rejects credential-like source content", () => {
    mkdirSync(join(repoPath, "src"), { recursive: true });
    const token = `ghp_${"a".repeat(24)}`;
    writeFileSync(join(repoPath, "src", "secret.ts"), `export const token = '${token}';\n`, "utf-8");
    assert.throws(
      () => syncFile(sessionId, "src/secret.ts", "dst/secret.ts", undefined, config),
      (err: unknown) => err instanceof PatchWardenError && err.reason === "sensitive_content_blocked",
    );
  });

  it("rejects non-UTF-8 source content", () => {
    mkdirSync(join(repoPath, "src"), { recursive: true });
    writeFileSync(join(repoPath, "src", "invalid.ts"), Buffer.from([0xc3, 0x28]));
    assert.throws(
      () => syncFile(sessionId, "src/invalid.ts", "dst/invalid.ts", undefined, config),
      (err: unknown) => err instanceof PatchWardenError && err.reason === "unsupported_text_encoding",
    );
  });

  it("validates expected_source_sha256", () => {
    mkdirSync(join(repoPath, "src"), { recursive: true });
    writeFileSync(join(repoPath, "src", "file.ts"), "content", "utf-8");

    const correctHash = computeFileSha256(join(repoPath, "src", "file.ts"));

    const result = syncFile(sessionId, "src/file.ts", "dst/file.ts", {
      expected_source_sha256: correctHash,
    }, config);
    assert.equal(result.source_sha256, correctHash);

    assert.throws(
      () => syncFile(sessionId, "src/file.ts", "dst2/file.ts", {
        expected_source_sha256: "wronghash",
      }, config),
      Error
    );
  });

  it("validates expected_target_sha256", () => {
    mkdirSync(join(repoPath, "src"), { recursive: true });
    mkdirSync(join(repoPath, "dst"), { recursive: true });
    writeFileSync(join(repoPath, "src", "file.ts"), "new content", "utf-8");
    writeFileSync(join(repoPath, "dst", "file.ts"), "old content", "utf-8");

    const correctTargetHash = computeFileSha256(join(repoPath, "dst", "file.ts"));

    const result = syncFile(sessionId, "src/file.ts", "dst/file.ts", {
      expected_target_sha256: correctTargetHash,
    }, config);
    assert.equal(result.before_target_sha256, correctTargetHash);

    assert.throws(
      () => syncFile(sessionId, "src/file.ts", "dst/file.ts", {
        expected_target_sha256: "wronghash",
      }, config),
      Error
    );
  });

  it("creates target directory if it doesn't exist", () => {
    mkdirSync(join(repoPath, "src"), { recursive: true });
    writeFileSync(join(repoPath, "src", "file.ts"), "content", "utf-8");

    const result = syncFile(sessionId, "src/file.ts", "deep/nested/path/file.ts", undefined, config);

    assert.equal(result.changed, true);
    assert.ok(existsSync(join(repoPath, "deep", "nested", "path", "file.ts")));
  });
});
