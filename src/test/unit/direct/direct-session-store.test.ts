import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, it } from "node:test";
import { reloadConfig } from "../../../config.js";
import { PatchWardenError } from "../../../errors.js";
import {
  appendDirectSessionVerificationRun,
  appendDirectSessionOperation,
  createDirectSession,
  finalizeDirectSessionRecord,
  readDirectSession,
  withDirectSessionMutationLock,
  withDirectSessionMutationLockAsync,
  type DirectSessionRecord,
} from "../../../direct/directSessionStore.js";
import { auditDirectSession } from "../../../direct/directAudit.js";
import type { ChangeArtifacts } from "../../../runner/changeCapture.js";

describe("Direct session store", () => {
  let root: string | undefined;
  const originalConfigPath = process.env.PATCHWARDEN_CONFIG;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
    if (originalConfigPath === undefined) delete process.env.PATCHWARDEN_CONFIG;
    else process.env.PATCHWARDEN_CONFIG = originalConfigPath;
    reloadConfig();
  });

  it("preserves concurrent operation and verification appends from separate processes", { timeout: 15_000 }, async () => {
    root = mkdtempSync(join(tmpdir(), "patchwarden-direct-session-"));
    const repoPath = join(root, "repo");
    const sessionId = "direct-concurrent-append";
    const sessionDir = join(root, ".patchwarden", "direct-sessions", sessionId);
    const sessionFile = join(sessionDir, "session.json");
    const configPath = join(root, "patchwarden.config.json");
    const startFile = join(root, "start");
    const readyPrefix = join(root, "ready");
    const workerCount = 12;

    mkdirSync(repoPath, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(configPath, JSON.stringify({ workspaceRoot: root }), "utf-8");
    writeFileSync(sessionFile, JSON.stringify(makeSession(sessionId, repoPath)), "utf-8");
    process.env.PATCHWARDEN_CONFIG = configPath;
    reloadConfig();

    const modulePath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../../direct/directSessionStore.js",
    );
    const source = [
      `const fs = await import("node:fs");`,
      `const timers = await import("node:timers/promises");`,
      `const store = await import(${JSON.stringify(pathToFileURL(modulePath).href)});`,
      `const worker = Number(process.argv[4]);`,
      `fs.writeFileSync(process.argv[2] + "." + worker, "ready", "utf-8");`,
      `while (!fs.existsSync(process.argv[1])) await timers.setTimeout(5);`,
      `const timestamp = new Date(1700000000000 + worker).toISOString();`,
      `store.appendDirectSessionOperation(process.argv[3], {`,
      `  index: worker, timestamp, path: "src/worker-" + worker + ".ts",`,
      `  before_sha256: "before-" + worker, after_sha256: "after-" + worker,`,
      `  operations_applied: 1, bytes_changed: worker,`,
      `});`,
      `store.appendDirectSessionVerificationRun(process.argv[3], {`,
      `  command: "worker-" + worker, exit_code: 0, passed: true, timed_out: false,`,
      `  stdout_tail: "stdout-" + worker, stderr_tail: "",`,
      `  started_at: timestamp, finished_at: timestamp, log_path: "log-" + worker,`,
      `});`,
    ].join("\n");

    const children = Array.from({ length: workerCount }, (_, worker) =>
      runWorker(source, [startFile, readyPrefix, sessionId, String(worker)], configPath),
    );
    const childrenDone = Promise.all(children);
    await Promise.race([
      waitForReadyWorkers(readyPrefix, workerCount),
      childrenDone.then(() => {
        throw new Error("append workers exited before the start signal");
      }),
    ]);
    writeFileSync(startFile, "go", "utf-8");
    await childrenDone;

    const session = readDirectSession(sessionId);
    assert.deepEqual(
      session.operations.map((operation) => operation.index).sort((a, b) => a - b),
      Array.from({ length: workerCount }, (_, index) => index),
    );
    assert.deepEqual(
      session.verification_runs.map((run) => run.command).sort(),
      Array.from({ length: workerCount }, (_, index) => `worker-${index}`).sort(),
    );
    assert.equal(existsSync(`${sessionFile}.lock`), false);
    assert.deepEqual(readdirSync(sessionDir).filter((name) => name.includes(".tmp")), []);
  });

  it("fails closed while another workspace mutation owns the session lock", async () => {
    root = mkdtempSync(join(tmpdir(), "patchwarden-direct-lock-"));
    const repoPath = join(root, "repo");
    const sessionId = "direct-mutation-lock";
    const sessionDir = join(root, ".patchwarden", "direct-sessions", sessionId);
    const configPath = join(root, "patchwarden.config.json");
    mkdirSync(repoPath, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(configPath, JSON.stringify({ workspaceRoot: root }), "utf-8");
    writeFileSync(join(sessionDir, "session.json"), JSON.stringify(makeSession(sessionId, repoPath)), "utf-8");
    process.env.PATCHWARDEN_CONFIG = configPath;
    reloadConfig();

    await withDirectSessionMutationLockAsync(sessionId, async () => {
      assert.throws(
        () => withDirectSessionMutationLock(sessionId, () => undefined),
        (error: unknown) =>
          error instanceof PatchWardenError && error.reason === "direct_session_busy",
      );
      await assert.rejects(
        withDirectSessionMutationLockAsync(sessionId, async () => undefined),
        (error: unknown) =>
          error instanceof PatchWardenError && error.reason === "direct_session_busy",
      );
    });

    assert.equal(existsSync(join(sessionDir, "workspace-mutation.lock")), false);
  });

  it("waits beyond the generic two-second budget for bounded metadata contention", { timeout: 10_000 }, async () => {
    root = mkdtempSync(join(tmpdir(), "patchwarden-direct-record-wait-"));
    const repoPath = join(root, "repo");
    const sessionId = "direct-record-wait";
    const sessionDir = join(root, ".patchwarden", "direct-sessions", sessionId);
    const sessionFile = join(sessionDir, "session.json");
    const configPath = join(root, "patchwarden.config.json");
    const lockedFile = join(root, "locked");
    mkdirSync(repoPath, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(configPath, JSON.stringify({ workspaceRoot: root }), "utf-8");
    writeFileSync(sessionFile, JSON.stringify(makeSession(sessionId, repoPath)), "utf-8");
    process.env.PATCHWARDEN_CONFIG = configPath;
    reloadConfig();

    const lockModulePath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../../utils/lockedJsonFile.js",
    );
    const source = [
      `const fs = await import("node:fs");`,
      `const locks = await import(${JSON.stringify(pathToFileURL(lockModulePath).href)});`,
      `locks.withFileLockSync(process.argv[1], () => {`,
      `  fs.writeFileSync(process.argv[2], "locked", "utf-8");`,
      `  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2600);`,
      `});`,
    ].join("\n");
    const holder = runWorker(source, [sessionFile, lockedFile], configPath);
    await waitForFile(lockedFile);

    const startedAt = Date.now();
    appendDirectSessionOperation(sessionId, {
      index: 0,
      timestamp: new Date().toISOString(),
      path: "src/waited.ts",
      before_sha256: null,
      after_sha256: "after",
      operations_applied: 1,
      bytes_changed: 1,
    });
    const elapsedMs = Date.now() - startedAt;
    await holder;

    assert.ok(elapsedMs >= 2_000, `metadata update did not wait for the owner: ${elapsedMs}ms`);
    assert.ok(elapsedMs < 9_000, `metadata update exceeded its bounded wait: ${elapsedMs}ms`);
    assert.equal(readDirectSession(sessionId).operations.length, 1);
  });

  it("treats legacy sessions without expected_changes as edit sessions", () => {
    root = mkdtempSync(join(tmpdir(), "patchwarden-direct-legacy-intent-"));
    const repoPath = join(root, "repo");
    const sessionId = "direct-legacy-intent";
    const sessionDir = join(root, ".patchwarden", "direct-sessions", sessionId);
    const configPath = join(root, "patchwarden.config.json");
    mkdirSync(repoPath, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(configPath, JSON.stringify({ workspaceRoot: root }), "utf-8");
    const legacy = { ...makeSession(sessionId, repoPath) } as Partial<DirectSessionRecord>;
    delete legacy.expected_changes;
    writeFileSync(join(sessionDir, "session.json"), JSON.stringify(legacy), "utf-8");
    process.env.PATCHWARDEN_CONFIG = configPath;
    reloadConfig();

    assert.equal(readDirectSession(sessionId).expected_changes, true);
  });

  it("passes an empty diff when the session explicitly does not expect changes", () => {
    root = mkdtempSync(join(tmpdir(), "patchwarden-direct-read-only-"));
    const repoPath = join(root, "repo");
    const configPath = join(root, "patchwarden.config.json");
    mkdirSync(repoPath, { recursive: true });
    writeFileSync(configPath, JSON.stringify({ workspaceRoot: root }), "utf-8");
    process.env.PATCHWARDEN_CONFIG = configPath;
    reloadConfig();

    const now = new Date().toISOString();
    const session = createDirectSession({
      repo_path: "repo",
      resolved_repo_path: repoPath,
      title: "Read-only verification",
      expected_changes: false,
      snapshot: {
        captured_at: now,
        is_git: false,
        head: null,
        status: "",
        workspace_dirty: false,
        files: {},
        dirty_paths: [],
        warnings: [],
      },
    });
    appendDirectSessionVerificationRun(session.session_id, {
      command: "npm test",
      exit_code: 0,
      passed: true,
      timed_out: false,
      stdout_tail: "ok",
      stderr_tail: "",
      started_at: now,
      finished_at: now,
      log_path: "verification.log",
    });
    finalizeDirectSessionRecord(session.session_id, emptyChangeArtifacts());

    const audit = auditDirectSession(session.session_id);
    assert.equal(audit.decision, "pass");
    assert.equal(audit.expected_changes, false);
    assert.equal(audit.reason_codes.includes("empty_diff"), false);
    assert.equal(audit.warnings.some((warning) => warning.startsWith("diff_empty:")), false);
  });

  it("keeps generated rebuild deletions as evidence without treating them as source failures", () => {
    root = mkdtempSync(join(tmpdir(), "patchwarden-direct-generated-"));
    const repoPath = join(root, "repo");
    const configPath = join(root, "patchwarden.config.json");
    mkdirSync(repoPath, { recursive: true });
    writeFileSync(configPath, JSON.stringify({ workspaceRoot: root }), "utf-8");
    process.env.PATCHWARDEN_CONFIG = configPath;
    reloadConfig();

    const now = new Date().toISOString();
    const createFinalized = (ignored: boolean) => {
      const session = createDirectSession({
        repo_path: "repo",
        resolved_repo_path: repoPath,
        title: "Next.js rebuild",
        snapshot: {
          captured_at: now,
          is_git: false,
          head: null,
          status: "",
          workspace_dirty: false,
          files: {},
          dirty_paths: [],
          warnings: [],
        },
      });
      appendDirectSessionVerificationRun(session.session_id, {
        command: "npm test",
        exit_code: 0,
        passed: true,
        timed_out: false,
        stdout_tail: "ok",
        stderr_tail: "",
        started_at: now,
        finished_at: now,
        log_path: "verification.log",
      });
      finalizeDirectSessionRecord(session.session_id, generatedRebuildArtifacts(ignored));
      return auditDirectSession(session.session_id);
    };

    const ignoredAudit = createFinalized(true);
    assert.equal(ignoredAudit.decision, "pass");
    assert.equal(ignoredAudit.reason_codes.includes("file_deleted"), false);
    assert.equal(ignoredAudit.reason_codes.includes("file_renamed"), false);

    const trackedAudit = createFinalized(false);
    assert.equal(trackedAudit.decision, "warn");
    assert.ok(trackedAudit.reason_codes.includes("generated_file_deleted"));
    assert.ok(trackedAudit.reason_codes.includes("generated_file_renamed"));
    assert.equal(trackedAudit.blocking_findings.length, 0);

    const sourceRenameSession = createDirectSession({
      repo_path: "repo",
      resolved_repo_path: repoPath,
      title: "Source moved into output",
      snapshot: {
        captured_at: now,
        is_git: false,
        head: null,
        status: "",
        workspace_dirty: false,
        files: {},
        dirty_paths: [],
        warnings: [],
      },
    });
    appendDirectSessionVerificationRun(sourceRenameSession.session_id, {
      command: "npm test", exit_code: 0, passed: true, timed_out: false,
      stdout_tail: "ok", stderr_tail: "", started_at: now, finished_at: now, log_path: "verification.log",
    });
    finalizeDirectSessionRecord(sourceRenameSession.session_id, sourceMovedIntoGeneratedArtifacts());
    const sourceRenameAudit = auditDirectSession(sourceRenameSession.session_id);
    assert.equal(sourceRenameAudit.decision, "fail");
    assert.ok(sourceRenameAudit.reason_codes.includes("file_renamed"));

    const dependencySession = createDirectSession({
      repo_path: "repo",
      resolved_repo_path: repoPath,
      title: "Dependency-only change",
      snapshot: {
        captured_at: now,
        is_git: false,
        head: null,
        status: "",
        workspace_dirty: false,
        files: {},
        dirty_paths: [],
        warnings: [],
      },
    });
    finalizeDirectSessionRecord(dependencySession.session_id, dependencyOnlyArtifacts());
    const dependencyAudit = auditDirectSession(dependencySession.session_id);
    assert.equal(dependencyAudit.decision, "fail");
    assert.ok(dependencyAudit.reason_codes.includes("source_changes_without_verification"));
  });
});

function sourceMovedIntoGeneratedArtifacts(): ChangeArtifacts {
  const file = {
    path: ".next/draft.ts",
    old_path: "src/draft.ts",
    old_kind: "source" as const,
    change: "renamed" as const,
    before_sha256: "same",
    after_sha256: "same",
    tracked: false,
    ignored: true,
    kind: "source" as const,
  };
  return changeArtifactsFor([file], [toClassified(file)], []);
}

function dependencyOnlyArtifacts(): ChangeArtifacts {
  const file = {
    path: "package-lock.json",
    change: "modified" as const,
    before_sha256: "before",
    after_sha256: "after",
    tracked: true,
    ignored: false,
    kind: "dependency" as const,
  };
  return changeArtifactsFor([file], [], []);
}

function toClassified(file: ChangeArtifacts["changed_files"][number]) {
  return { path: file.path, change: file.change, tracked: file.tracked, ignored: file.ignored, kind: file.kind, reason: "source path must remain protected" };
}

function changeArtifactsFor(
  changed_files: ChangeArtifacts["changed_files"],
  source_changes: ReturnType<typeof toClassified>[],
  generated_changes: ReturnType<typeof toClassified>[],
): ChangeArtifacts {
  return {
    changed_files,
    diff: "", diff_available: true, diff_truncated: false, diff_size_bytes: 0, additions: 0, deletions: 0, file_stats: [],
    workspace_dirty_before: false, workspace_dirty_after: false, patch_mode: "hash_only", unavailable_reason: null,
    artifact_hygiene: {
      counts: { source_changes: source_changes.length, dependency_changes: changed_files.filter((file) => file.kind === "dependency").length, generated_changes: generated_changes.length, runtime_changes: 0, unexpected_changes: 0, tracked_build_artifacts: 0, ignored_untracked_artifacts: 0, runtime_generated_files: 0, suspicious_changes: 0 },
      source_changes, dependency_changes: [], generated_changes, runtime_changes: [], unexpected_changes: [], tracked_build_artifacts: [], ignored_untracked_artifacts: [], runtime_generated_files: [], suspicious_changes: [],
    },
  };
}

function generatedRebuildArtifacts(ignored: boolean): ChangeArtifacts {
  const changedFiles: ChangeArtifacts["changed_files"] = [
    {
      path: ".next/static/old.js",
      change: "deleted",
      before_sha256: "old",
      after_sha256: null,
      tracked: !ignored,
      ignored,
      kind: "build_artifact",
    },
    {
      path: "dist/app-new.js",
      old_path: "dist/app-old.js",
      change: "renamed",
      before_sha256: "same",
      after_sha256: "same",
      tracked: !ignored,
      ignored,
      kind: "build_artifact",
    },
  ];
  const classified = changedFiles.map((file) => ({
    path: file.path,
    change: file.change,
    tracked: file.tracked,
    ignored: file.ignored,
    kind: file.kind,
    reason: ignored ? "ignored generated path" : "generated path requires review",
  }));
  return {
    changed_files: changedFiles,
    diff: "",
    diff_available: true,
    diff_truncated: false,
    diff_size_bytes: 0,
    additions: 0,
    deletions: 0,
    file_stats: [],
    workspace_dirty_before: false,
    workspace_dirty_after: false,
    patch_mode: "hash_only",
    unavailable_reason: null,
    artifact_hygiene: {
      counts: {
        source_changes: 0,
        dependency_changes: 0,
        generated_changes: 2,
        runtime_changes: 0,
        unexpected_changes: ignored ? 0 : 2,
        tracked_build_artifacts: ignored ? 0 : 2,
        ignored_untracked_artifacts: ignored ? 2 : 0,
        runtime_generated_files: 0,
        suspicious_changes: ignored ? 0 : 2,
      },
      source_changes: [],
      dependency_changes: [],
      generated_changes: classified,
      runtime_changes: [],
      unexpected_changes: ignored ? [] : classified,
      tracked_build_artifacts: ignored ? [] : classified,
      ignored_untracked_artifacts: ignored ? classified : [],
      runtime_generated_files: [],
      suspicious_changes: ignored ? [] : classified,
    },
  };
}

function emptyChangeArtifacts() {
  return {
    changed_files: [],
    diff: "",
    diff_available: true,
    diff_truncated: false,
    diff_size_bytes: 0,
    additions: 0,
    deletions: 0,
    file_stats: [],
    workspace_dirty_before: false,
    workspace_dirty_after: false,
    patch_mode: "no_changes" as const,
    unavailable_reason: null,
    artifact_hygiene: {
      counts: {
        source_changes: 0,
        tracked_build_artifacts: 0,
        ignored_untracked_artifacts: 0,
        runtime_generated_files: 0,
        suspicious_changes: 0,
      },
      source_changes: [],
      tracked_build_artifacts: [],
      ignored_untracked_artifacts: [],
      runtime_generated_files: [],
      suspicious_changes: [],
    },
  };
}

function makeSession(sessionId: string, repoPath: string): DirectSessionRecord {
  const now = new Date().toISOString();
  return {
    session_id: sessionId,
    title: "concurrent append test",
    repo_path: "repo",
    resolved_repo_path: repoPath,
    created_at: now,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    server_version: "test",
    schema_epoch: "test",
    tool_manifest_sha256: "test",
    workspace_snapshot_before: {
      captured_at: now,
      is_git: false,
      head: null,
      status: "",
      workspace_dirty: false,
      files: {},
      dirty_paths: [],
      warnings: [],
    },
    workspace_fingerprint_before: "test",
    allowed_commands: [],
    expected_changes: true,
    operations: [],
    verification_runs: [],
    finalized: false,
    finalized_at: null,
    audited: false,
    change_artifacts: null,
  };
}

function runWorker(source: string, args: string[], configPath: string): Promise<void> {
  return new Promise((resolveWorker, rejectWorker) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source, ...args], {
      env: { ...process.env, PATCHWARDEN_CONFIG: configPath },
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", rejectWorker);
    child.once("close", (code) => {
      if (code === 0) resolveWorker();
      else rejectWorker(new Error(`append worker exited ${code}: ${stderr}`));
    });
  });
}

async function waitForReadyWorkers(readyPrefix: string, workerCount: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (true) {
    const ready = Array.from(
      { length: workerCount },
      (_, worker) => `${readyPrefix}.${worker}`,
    ).every(existsSync);
    if (ready) return;
    if (Date.now() >= deadline) throw new Error("append workers did not become ready");
    await delay(10);
  }
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await delay(10);
  }
}
