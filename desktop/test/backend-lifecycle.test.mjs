import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, it } from "node:test";
import {
  createQuitCleanupCoordinator,
  createSerializedRestartScheduler,
  mayStopOwnedServices,
  stopBackendChild,
} from "../dist/backend-lifecycle.js";

describe("desktop backend lifecycle", () => {
  it("stops services only for the captured child with a verified PatchWarden identity", () => {
    const owned = {};
    assert.equal(mayStopOwnedServices(owned, owned, "patchwarden"), true);
    assert.equal(mayStopOwnedServices(owned, {}, "patchwarden"), false);
    assert.equal(mayStopOwnedServices(null, owned, "patchwarden"), false);
    assert.equal(mayStopOwnedServices(owned, owned, "mismatched_patchwarden"), false);
    assert.equal(mayStopOwnedServices(owned, owned, "outdated_patchwarden"), false);
    assert.equal(mayStopOwnedServices(owned, owned, "foreign"), false);
  });

  it("waits for the owned child exit event after kill", async () => {
    const child = new EventEmitter();
    child.kill = () => { setTimeout(() => child.emit("exit"), 30); };
    const started = Date.now();
    assert.equal(await stopBackendChild(child, 1000), true);
    assert.ok(Date.now() - started >= 20);
  });

  it("reports a child that does not exit before the timeout", async () => {
    const child = new EventEmitter();
    child.kill = () => undefined;
    assert.equal(await stopBackendChild(child, 20), false);
  });

  it("coalesces restart requests during the debounce window", async () => {
    let restarts = 0;
    const schedule = createSerializedRestartScheduler(async () => { restarts += 1; });
    await Promise.all([schedule(20), schedule(20), schedule(20)]);
    assert.equal(restarts, 1);
  });

  it("runs another restart when configuration changes during an active restart", async () => {
    let restarts = 0;
    let releaseFirst;
    const firstGate = new Promise((resolveGate) => { releaseFirst = resolveGate; });
    const schedule = createSerializedRestartScheduler(async () => {
      restarts += 1;
      if (restarts === 1) await firstGate;
    });

    const first = schedule();
    while (restarts === 0) await sleep(1);
    const second = schedule();
    releaseFirst();
    await Promise.all([first, second]);
    assert.equal(restarts, 2);
  });

  it("runs quit cleanup once and marks it complete before the second quit", async () => {
    let cleanups = 0;
    let releaseCleanup;
    const cleanupGate = new Promise((resolveGate) => { releaseCleanup = resolveGate; });
    const coordinator = createQuitCleanupCoordinator(async () => {
      cleanups += 1;
      await cleanupGate;
    });

    const first = coordinator.run();
    const second = coordinator.run();
    assert.equal(coordinator.isComplete(), false);
    assert.equal(cleanups, 1);
    releaseCleanup();
    await Promise.all([first, second]);
    assert.equal(coordinator.isComplete(), true);
    assert.equal(cleanups, 1);
  });
});
