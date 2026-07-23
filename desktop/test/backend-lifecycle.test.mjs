import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, it } from "node:test";
import {
  createSerializedRestartScheduler,
  stopBackendChild,
} from "../dist/backend-lifecycle.js";

describe("desktop backend lifecycle", () => {
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
});
