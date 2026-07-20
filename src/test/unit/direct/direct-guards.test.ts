import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { guardDirectPath, guardDirectWritePath, guardDirectReadPath, guardDirectPatchSize, guardDirectFileSize, isBinaryFile } from "../../../direct/directGuards.js";
import { PatchWardenError } from "../../../errors.js";
import { reloadConfig } from "../../../config.js";
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
    directAllowedCommands: ["npm test"],
    repoDirectAllowedCommands: {},
  };
}

function linkDirectory(target: string, linkPath: string): void {
  symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
}

describe("guardDirectPath", () => {
  let tempDir: string;
  let repoPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pw-directpath-"));
    repoPath = join(tempDir, "my-repo");
    mkdirSync(repoPath, { recursive: true });
    // Set up config so getConfig() works in guardDirectPath
    process.env.PATCHWARDEN_CONFIG = "";
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    delete process.env.PATCHWARDEN_CONFIG;
  });

  it("allows paths inside repo", () => {
    const result = guardDirectPath("src/main.ts", repoPath, tempDir);
    assert.equal(result, resolve(repoPath, "src/main.ts"));
  });

  it("allows nested paths inside repo", () => {
    const result = guardDirectPath("src/components/Button.tsx", repoPath, tempDir);
    assert.equal(result, resolve(repoPath, "src/components/Button.tsx"));
  });

  it("rejects paths outside repo but inside workspace", () => {
    assert.throws(
      () => guardDirectPath("../other-repo/file.ts", repoPath, tempDir),
      PatchWardenError
    );
  });

  it("rejects paths outside workspace", () => {
    assert.throws(
      () => guardDirectPath("../../../etc/passwd", repoPath, tempDir),
      PatchWardenError
    );
  });

  it("handles Windows backslash paths", () => {
    const result = guardDirectPath("src\\subdir\\file.ts", repoPath, tempDir);
    assert.ok(result.startsWith(repoPath));
  });

  it("rejects path traversal with ..", () => {
    assert.throws(
      () => guardDirectPath("src/../../etc/passwd", repoPath, tempDir),
      PatchWardenError
    );
  });

  it("rejects an intermediate symlink or junction that escapes the repo", () => {
    const outside = mkdtempSync(join(tmpdir(), "pw-directpath-outside-"));
    try {
      const linkPath = join(repoPath, "escape-link");
      linkDirectory(outside, linkPath);
      assert.throws(
        () => guardDirectPath("escape-link/new-file.ts", repoPath, tempDir),
        (err: unknown) => err instanceof PatchWardenError && err.reason === "path_outside_repo"
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("allows a symlink or junction whose real target remains inside the repo", () => {
    const actualDir = join(repoPath, "actual-src");
    mkdirSync(actualDir, { recursive: true });
    linkDirectory(actualDir, join(repoPath, "linked-src"));

    const result = guardDirectPath("linked-src/new-file.ts", repoPath, tempDir);
    assert.equal(result, resolve(actualDir, "new-file.ts"));
  });

  it("rejects NTFS alternate data stream suffixes", () => {
    assert.throws(
      () => guardDirectPath("src/main.ts::$DATA", repoPath, tempDir),
      (err: unknown) => err instanceof PatchWardenError && err.reason === "windows_ads_path_blocked"
    );
  });
});

describe("guardDirectWritePath", () => {
  let tempDir: string;
  let repoPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pw-directwrite-"));
    repoPath = join(tempDir, "my-repo");
    mkdirSync(repoPath, { recursive: true });
    mkdirSync(join(repoPath, "src"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("allows writing to source files in repo", () => {
    const result = guardDirectWritePath("src/main.ts", repoPath, tempDir);
    assert.ok(result.startsWith(repoPath));
  });

  it("blocks node_modules paths", () => {
    assert.throws(
      () => guardDirectWritePath("node_modules/evil/index.js", repoPath, tempDir),
      (err: unknown) => err instanceof PatchWardenError && err.reason === "blocked_artifact_path"
    );
  });

  it("blocks nested node_modules paths", () => {
    assert.throws(
      () => guardDirectWritePath("src/node_modules/evil/index.js", repoPath, tempDir),
      (err: unknown) => err instanceof PatchWardenError && err.reason === "blocked_artifact_path"
    );
  });

  it("blocks dist paths", () => {
    assert.throws(
      () => guardDirectWritePath("dist/main.js", repoPath, tempDir),
      (err: unknown) => err instanceof PatchWardenError && err.reason === "blocked_artifact_path"
    );
  });

  it("blocks release paths", () => {
    assert.throws(
      () => guardDirectWritePath("release/app.exe", repoPath, tempDir),
      (err: unknown) => err instanceof PatchWardenError && err.reason === "blocked_artifact_path"
    );
  });

  it("blocks .patchwarden internal paths", () => {
    assert.throws(
      () => guardDirectWritePath(".patchwarden/tasks/evil.json", repoPath, tempDir),
      (err: unknown) => err instanceof PatchWardenError && err.reason === "internal_patchwarden_path_blocked"
    );
  });

  it("blocks sensitive files", () => {
    assert.throws(
      () => guardDirectWritePath(".env", repoPath, tempDir),
      (err: unknown) => err instanceof PatchWardenError && err.reason === "sensitive_path_blocked"
    );
    assert.throws(
      () => guardDirectWritePath("config.json", repoPath, tempDir),
      (err: unknown) => err instanceof PatchWardenError && err.reason === "sensitive_path_blocked"
    );
  });

  it("does not treat foo.patchwarden as the internal safe directory", () => {
    assert.throws(
      () => guardDirectWritePath("foo.patchwarden/.env", repoPath, tempDir),
      (err: unknown) => err instanceof PatchWardenError && err.reason === "sensitive_path_blocked"
    );
  });

  it("applies internal path policy to the real symlink or junction target", () => {
    const internalDir = join(repoPath, ".patchwarden", "artifacts");
    mkdirSync(internalDir, { recursive: true });
    linkDirectory(internalDir, join(repoPath, "artifact-link"));

    assert.throws(
      () => guardDirectWritePath("artifact-link/status.txt", repoPath, tempDir),
      (err: unknown) => err instanceof PatchWardenError && err.reason === "internal_patchwarden_path_blocked"
    );
  });

  it("rejects NTFS alternate data stream targets", () => {
    assert.throws(
      () => guardDirectWritePath("src/main.ts:secret", repoPath, tempDir),
      (err: unknown) => err instanceof PatchWardenError && err.reason === "windows_ads_path_blocked"
    );
  });

  it("blocks paths outside repo", () => {
    assert.throws(
      () => guardDirectWritePath("../other-repo/file.ts", repoPath, tempDir),
      PatchWardenError
    );
  });
});

describe("guardDirectReadPath", () => {
  let tempDir: string;
  let repoPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pw-directread-"));
    repoPath = join(tempDir, "my-repo");
    mkdirSync(repoPath, { recursive: true });
    mkdirSync(join(repoPath, "src"), { recursive: true });
    writeFileSync(join(repoPath, "src", "main.ts"), "console.log('hello');", "utf-8");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("allows reading source files in repo", () => {
    const result = guardDirectReadPath("src/main.ts", repoPath, tempDir);
    assert.ok(result.startsWith(repoPath));
  });

  it("blocks .patchwarden internal paths", () => {
    assert.throws(
      () => guardDirectReadPath(".patchwarden/tasks/status.json", repoPath, tempDir),
      (err: unknown) => err instanceof PatchWardenError && err.reason === "internal_patchwarden_path_blocked"
    );
  });

  it("blocks sensitive files", () => {
    assert.throws(
      () => guardDirectReadPath(".env", repoPath, tempDir),
      (err: unknown) => err instanceof PatchWardenError && err.reason === "sensitive_path_blocked"
    );
  });
});

describe("guardDirectPatchSize", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pw-patchsize-"));
    // Write a real config file so getConfig() picks it up
    const configPath = join(tempDir, "patchwarden.config.json");
    writeFileSync(configPath, JSON.stringify({
      workspaceRoot: tempDir,
      agents: { codex: { command: "codex", args: ["exec", "{prompt}"] } },
      allowedTestCommands: ["npm test"],
      directMaxPatchBytes: 1000,
      directMaxFileBytes: 5000,
    }), "utf-8");
    process.env.PATCHWARDEN_CONFIG = configPath;
    reloadConfig();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    delete process.env.PATCHWARDEN_CONFIG;
    reloadConfig();
  });

  it("allows patches within size limit", () => {
    assert.doesNotThrow(() => guardDirectPatchSize(500));
    assert.doesNotThrow(() => guardDirectPatchSize(1000));
  });

  it("rejects patches exceeding size limit", () => {
    assert.throws(
      () => guardDirectPatchSize(1001),
      (err: unknown) => err instanceof PatchWardenError && err.reason === "patch_too_large"
    );
    assert.throws(
      () => guardDirectPatchSize(999999),
      (err: unknown) => err instanceof PatchWardenError && err.reason === "patch_too_large"
    );
  });

  it("allows zero-size patch", () => {
    assert.doesNotThrow(() => guardDirectPatchSize(0));
  });
});

describe("guardDirectFileSize", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pw-filesize-"));
    const configPath = join(tempDir, "patchwarden.config.json");
    writeFileSync(configPath, JSON.stringify({
      workspaceRoot: tempDir,
      agents: { codex: { command: "codex", args: ["exec", "{prompt}"] } },
      allowedTestCommands: ["npm test"],
      directMaxPatchBytes: 1000,
      directMaxFileBytes: 5000,
    }), "utf-8");
    process.env.PATCHWARDEN_CONFIG = configPath;
    reloadConfig();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    delete process.env.PATCHWARDEN_CONFIG;
    reloadConfig();
  });

  it("allows files within size limit", () => {
    assert.doesNotThrow(() => guardDirectFileSize(100));
    assert.doesNotThrow(() => guardDirectFileSize(5000));
  });

  it("rejects files exceeding size limit", () => {
    assert.throws(
      () => guardDirectFileSize(5001),
      (err: unknown) => err instanceof PatchWardenError && err.reason === "file_too_large"
    );
    assert.throws(
      () => guardDirectFileSize(9999999),
      (err: unknown) => err instanceof PatchWardenError && err.reason === "file_too_large"
    );
  });

  it("allows zero-size file", () => {
    assert.doesNotThrow(() => guardDirectFileSize(0));
  });
});

describe("isBinaryFile", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pw-binary-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("detects binary files by extension", () => {
    assert.equal(isBinaryFile("test.exe"), true);
    assert.equal(isBinaryFile("test.dll"), true);
    assert.equal(isBinaryFile("test.zip"), true);
    assert.equal(isBinaryFile("test.png"), true);
    assert.equal(isBinaryFile("test.pdf"), true);
    assert.equal(isBinaryFile("test.jar"), true);
    assert.equal(isBinaryFile("test.pak"), true);
  });

  it("detects binary files with Windows backslash paths", () => {
    assert.equal(isBinaryFile("path\\to\\test.exe"), true);
    assert.equal(isBinaryFile("path\\to\\test.dll"), true);
  });

  it("does not flag text files as binary by extension", () => {
    assert.equal(isBinaryFile("test.ts"), false);
    assert.equal(isBinaryFile("test.js"), false);
    assert.equal(isBinaryFile("test.md"), false);
    assert.equal(isBinaryFile("test.json"), false);
    assert.equal(isBinaryFile("test.txt"), false);
  });

  it("detects binary content by null bytes", () => {
    const binaryFile = join(tempDir, "test.dat");
    // Write a file with null bytes in the first 8KB
    const buffer = Buffer.alloc(100, 0x41); // 'A' characters
    buffer[50] = 0; // null byte
    writeFileSync(binaryFile, buffer);
    assert.equal(isBinaryFile(binaryFile), true);
  });

  it("does not flag text content as binary", () => {
    const textFile = join(tempDir, "test.txt");
    writeFileSync(textFile, "This is a text file with no null bytes.", "utf-8");
    assert.equal(isBinaryFile(textFile), false);
  });

  it("handles 8KB boundary — text file just under 8KB", () => {
    const textFile = join(tempDir, "boundary.txt");
    // Write exactly 8192 bytes of text (no null bytes)
    const content = "A".repeat(8192);
    writeFileSync(textFile, content, "utf-8");
    assert.equal(isBinaryFile(textFile), false);
  });

  it("handles 8KB boundary — null byte at position 8191", () => {
    const binaryFile = join(tempDir, "boundary.dat");
    const buffer = Buffer.alloc(8192, 0x41);
    buffer[8191] = 0;
    writeFileSync(binaryFile, buffer);
    assert.equal(isBinaryFile(binaryFile), true);
  });

  it("returns false for non-existent files without binary extension", () => {
    assert.equal(isBinaryFile(join(tempDir, "nonexistent.txt")), false);
  });

  // ── Adversarial: null byte beyond 8KB read window ──
  it("detects null byte at position 8200 (beyond old 8KB window)", () => {
    // Previously isBinaryFile only read the first 8192 bytes, so a null byte
    // at position 8200 would bypass detection. Now we scan up to 1 MB.
    const stealthBinary = join(tempDir, "stealth.txt");
    const buffer = Buffer.alloc(8200, 0x41); // 8200 bytes of 'A'
    buffer[8199] = 0; // null byte just beyond the old 8KB read window
    writeFileSync(stealthBinary, buffer);
    assert.equal(isBinaryFile(stealthBinary), true);
  });

  it("detects null byte at exactly position 8192 (first byte beyond old window)", () => {
    const stealthBinary = join(tempDir, "boundary-plus.txt");
    const buffer = Buffer.alloc(8193, 0x41);
    buffer[8192] = 0; // first byte beyond the old 8KB read window
    writeFileSync(stealthBinary, buffer);
    assert.equal(isBinaryFile(stealthBinary), true);
  });

  it("detects null byte at 100KB offset", () => {
    const deepBinary = join(tempDir, "deep.txt");
    const buffer = Buffer.alloc(102400, 0x41);
    buffer[102399] = 0;
    writeFileSync(deepBinary, buffer);
    assert.equal(isBinaryFile(deepBinary), true);
  });

  it("detects null byte at 1MB offset (scan limit boundary)", () => {
    const limitBinary = join(tempDir, "limit.txt");
    const buffer = Buffer.alloc(1_048_576, 0x41);
    buffer[1_048_575] = 0;
    writeFileSync(limitBinary, buffer);
    assert.equal(isBinaryFile(limitBinary), true);
  });

  it("does not scan beyond 1MB limit", () => {
    // A null byte just past the 1MB scan limit should NOT be detected.
    // This documents the remaining scan boundary.
    const overLimit = join(tempDir, "over-limit.txt");
    const buffer = Buffer.alloc(1_048_577, 0x41);
    buffer[1_048_576] = 0; // first byte beyond scan limit
    writeFileSync(overLimit, buffer);
    assert.equal(isBinaryFile(overLimit), false);
  });
});

// ── Adversarial: Windows backslash prefix bypass attempts ──

describe("guardDirectWritePath adversarial separator tests", () => {
  let tempDir: string;
  let repoPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pw-directsep-"));
    repoPath = join(tempDir, "my-repo");
    mkdirSync(repoPath, { recursive: true });
    mkdirSync(join(repoPath, "src"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("blocks node_modules with backslash prefix", () => {
    assert.throws(
      () => guardDirectWritePath("node_modules\\evil\\index.js", repoPath, tempDir),
      (err: unknown) => err instanceof PatchWardenError && err.reason === "blocked_artifact_path"
    );
  });

  it("blocks dist with backslash prefix", () => {
    assert.throws(
      () => guardDirectWritePath("dist\\main.js", repoPath, tempDir),
      (err: unknown) => err instanceof PatchWardenError && err.reason === "blocked_artifact_path"
    );
  });

  it("blocks release with backslash prefix", () => {
    assert.throws(
      () => guardDirectWritePath("release\\app.exe", repoPath, tempDir),
      (err: unknown) => err instanceof PatchWardenError && err.reason === "blocked_artifact_path"
    );
  });

  it("blocks nested node_modules with mixed separators", () => {
    assert.throws(
      () => guardDirectWritePath("src\\node_modules/evil\\index.js", repoPath, tempDir),
      (err: unknown) => err instanceof PatchWardenError && err.reason === "blocked_artifact_path"
    );
  });

  it("blocks .patchwarden with backslash prefix", () => {
    assert.throws(
      () => guardDirectWritePath(".patchwarden\\tasks\\evil.json", repoPath, tempDir),
      (err: unknown) => err instanceof PatchWardenError && err.reason === "internal_patchwarden_path_blocked"
    );
  });

  it("blocks .env with backslash prefix", () => {
    assert.throws(
      () => guardDirectWritePath("path\\to\\.env", repoPath, tempDir),
      (err: unknown) => err instanceof PatchWardenError && err.reason === "sensitive_path_blocked"
    );
  });

  it("blocks config.json with backslash path", () => {
    assert.throws(
      () => guardDirectWritePath("subdir\\config.json", repoPath, tempDir),
      (err: unknown) => err instanceof PatchWardenError && err.reason === "sensitive_path_blocked"
    );
  });
});
