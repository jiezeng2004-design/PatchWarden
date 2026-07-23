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
  readDirectSession,
  withDirectSessionMutationLock,
  withDirectSessionMutationLockAsync,
  type DirectSessionRecord,
} from "../../../direct/directSessionStore.js";

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
});

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
