import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";

const repoRoot = resolve(import.meta.dirname, "..", "..");
const bridgeSource = readFileSync(resolve(repoRoot, "ui", "desktop-bridge.js"), "utf8");

class TestAbortController {
  constructor() {
    this.listeners = [];
    this.signal = {
      addEventListener: (_event, listener) => this.listeners.push(listener),
    };
  }

  abort() {
    for (const listener of this.listeners) listener();
  }
}

function createBridge(nativeFetch) {
  const timers = new Map();
  let nextTimerId = 1;
  const localStorage = { setItem() {} };
  const window = {
    fetch: nativeFetch,
    patchwardenDesktop: { getPreferences: () => Promise.resolve({ theme: "system" }) },
    setTimeout(callback, delay) {
      const id = nextTimerId++;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    matchMedia() {
      return { matches: false, addEventListener() {} };
    },
  };
  const context = {
    window,
    document: {
      documentElement: {
        classList: { add() {}, toggle() {} },
        dataset: {},
        style: {},
      },
    },
    localStorage,
    AbortController: TestAbortController,
    Promise,
    Error,
    Date,
  };
  runInNewContext(bridgeSource, context);
  return {
    window,
    timers,
    runTimer(predicate) {
      const entry = [...timers.entries()].find(([, timer]) => predicate(timer.delay));
      assert.ok(entry, "expected timer was not scheduled");
      timers.delete(entry[0]);
      entry[1].callback();
    },
  };
}

async function drainMicrotasks() {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

describe("desktop bridge request policy", () => {
  it("uses a 30 second GET budget and classifies timeout", async () => {
    let rejectRequest;
    const bridge = createBridge((_input, init) => new Promise((resolve, reject) => {
      rejectRequest = () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      };
      init.signal.addEventListener("abort", rejectRequest);
    }));

    const request = bridge.window.fetch("/api/status");
    await drainMicrotasks();
    bridge.runTimer((delay) => delay === 30000);
    await assert.rejects(request, (error) => {
      assert.equal(error.code, "control_center_timeout");
      return true;
    });
    assert.equal(typeof rejectRequest, "function");
  });

  it("retries one immediate connection failure after 250ms", async () => {
    let calls = 0;
    const bridge = createBridge(() => {
      calls += 1;
      if (calls === 1) return Promise.reject(new TypeError("Failed to fetch"));
      return Promise.resolve({ ok: true, status: 200 });
    });

    const request = bridge.window.fetch("/api/status");
    await drainMicrotasks();
    bridge.runTimer((delay) => delay === 250);
    const response = await request;
    assert.equal(response.status, 200);
    assert.equal(calls, 2);
  });

  it("does not retry HTTP failures or alter POST requests", async () => {
    let calls = 0;
    const bridge = createBridge((_input, init) => {
      calls += 1;
      if (init.method === "POST") {
        assert.equal(init.signal, undefined);
        return Promise.resolve({ ok: true, status: 204 });
      }
      return Promise.resolve({ ok: false, status: 503 });
    });

    const getResponse = await bridge.window.fetch("/api/status");
    const postResponse = await bridge.window.fetch("/api/start-all", { method: "POST" });
    assert.equal(getResponse.status, 503);
    assert.equal(postResponse.status, 204);
    assert.equal(calls, 2);
    assert.equal(bridge.timers.size, 0);
  });
});
