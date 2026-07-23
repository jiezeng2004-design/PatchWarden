import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  acquireWatcherLock,
  createNonOverlappingRunner,
  releaseWatcherLock,
  WatcherAlreadyRunningError,
} from "../../runner/watch.js";

// ── acquireWatcherLock ───────────────────────────────────────────
//  watch.ts guards its process-wide bootstrap (mkdirSync, setInterval,
//  signal handlers, lock acquisition) behind an isMainModule check, so
//  importing { acquireWatcherLock } here is side-effect-free and the
//  function can be exercised against a temp lock path in isolation.

describe("acquireWatcherLock", () => {
  let tempDir: string;
  let lockPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pw-watcher-lock-"));
    lockPath = join(tempDir, "watcher.lock");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("acquires the lock when no lock file exists", () => {
    assert.doesNotThrow(() => acquireWatcherLock(lockPath));

    assert.ok(existsSync(lockPath), "lock file should be created");
    const data = JSON.parse(readFileSync(lockPath, "utf-8"));
    assert.equal(data.pid, process.pid);
    assert.equal(typeof data.instance_id, "string");
    assert.ok(data.instance_id.length > 0, "instance_id should be non-empty");
    assert.equal(typeof data.started_at, "string");
    assert.ok(data.started_at.length > 0, "started_at should be non-empty");
  });

  it("takes over when the lock exists but the recorded PID is dead", () => {
    const deadPid = 999999; // extremely unlikely to correspond to a live process
    writeFileSync(lockPath, JSON.stringify({
      pid: deadPid,
      instance_id: "dead-watcher",
      started_at: "2026-01-01T00:00:00.000Z",
      launcher_pid: null,
    }), "utf-8");

    assert.doesNotThrow(() => acquireWatcherLock(lockPath));

    const data = JSON.parse(readFileSync(lockPath, "utf-8"));
    assert.equal(data.pid, process.pid, "lock should be overwritten with the current pid");
    assert.notEqual(data.instance_id, "dead-watcher", "lock should be overwritten");
  });

  it("throws WatcherAlreadyRunningError when the lock exists and the PID is alive", () => {
    const existingLock = {
      pid: process.pid, // the test process itself is definitely alive
      instance_id: "live-watcher",
      started_at: "2026-01-01T00:00:00.000Z",
      launcher_pid: null,
    };
    writeFileSync(lockPath, JSON.stringify(existingLock), "utf-8");

    let threw: unknown = null;
    try {
      acquireWatcherLock(lockPath);
    } catch (err) {
      threw = err;
    }

    assert.ok(threw instanceof WatcherAlreadyRunningError, "should throw WatcherAlreadyRunningError");
    assert.match((threw as Error).message, /Already running/);
    assert.match((threw as Error).message, /pid=\d+/);

    // The existing lock must NOT be overwritten when the holder is alive.
    const data = JSON.parse(readFileSync(lockPath, "utf-8"));
    assert.equal(data.instance_id, "live-watcher", "existing lock should not be overwritten");
    assert.equal(data.pid, process.pid);
  });

  it("takes over when the lock file is corrupted JSON", () => {
    writeFileSync(lockPath, "{not valid json", "utf-8");

    assert.doesNotThrow(() => acquireWatcherLock(lockPath));

    const data = JSON.parse(readFileSync(lockPath, "utf-8"));
    assert.equal(data.pid, process.pid, "corrupted lock should be replaced");
  });

  it("takes over when the lock file has no pid field", () => {
    writeFileSync(lockPath, JSON.stringify({ instance_id: "no-pid" }), "utf-8");

    assert.doesNotThrow(() => acquireWatcherLock(lockPath));

    const data = JSON.parse(readFileSync(lockPath, "utf-8"));
    assert.equal(data.pid, process.pid, "lock without pid should be replaced");
  });

  it("only releases a lock owned by the matching watcher instance", () => {
    acquireWatcherLock(lockPath);
    const data = JSON.parse(readFileSync(lockPath, "utf-8"));

    assert.equal(releaseWatcherLock(lockPath, "different-instance", process.pid), false);
    assert.equal(existsSync(lockPath), true, "foreign lock must remain in place");
    assert.equal(releaseWatcherLock(lockPath, data.instance_id, process.pid), true);
    assert.equal(existsSync(lockPath), false);
  });
});

describe("createNonOverlappingRunner", () => {
  it("skips an overlapping call and accepts a later call", async () => {
    let releaseFirst!: () => void;
    let calls = 0;
    let skipped = 0;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const run = createNonOverlappingRunner(async () => {
      calls += 1;
      if (calls === 1) await firstGate;
    }, () => { skipped += 1; });

    const first = run();
    assert.equal(await run(), false);
    assert.equal(calls, 1);
    assert.equal(skipped, 1);

    releaseFirst();
    assert.equal(await first, true);
    assert.equal(await run(), true);
    assert.equal(calls, 2);
  });
});
