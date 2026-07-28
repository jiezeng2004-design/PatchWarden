import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_BACKEND_FINAL_PROBE_GRACE_MS,
  DEFAULT_BACKEND_START_TIMEOUT_MS,
  configIdentity,
  desktopInstanceIdentity,
  hasExpectedDesktopInstance,
  mayStopBackend,
  probeControlCenter,
  waitForBackendStartup,
} from "../dist/backend-probe.js";

describe("desktop backend ownership", () => {
  it("recognizes a PatchWarden diagnostics response", async () => {
    const result = await probeControlCenter(async () => ({ ok: true, json: async () => ({ server_version: "1.5.1" }) }));
    assert.deepEqual(result, { kind: "patchwarden", version: "1.5.1" });
  });

  it("reuses only a PatchWarden backend with the same config identity", async () => {
    const expected = "C:\\Users\\student\\PatchWarden\\patchwarden.config.json";
    const same = await probeControlCenter(async () => ({ ok: true, json: async () => ({ server_version: "1.5.1", config_identity_sha256: configIdentity(expected, "win32") }) }), "http://127.0.0.1:8090", expected);
    assert.equal(same.kind, "patchwarden");
    const mismatch = await probeControlCenter(async () => ({ ok: true, json: async () => ({ server_version: "1.5.1", config_identity_sha256: configIdentity("D:\\other\\config.json", "win32") }) }), "http://127.0.0.1:8090", expected);
    assert.equal(mismatch.kind, "mismatched_patchwarden");
  });

  it("does not claim a foreign listener", async () => {
    const result = await probeControlCenter(async () => ({ ok: true, json: async () => ({ service: "other" }) }));
    assert.equal(result.kind, "foreign");
  });

  it("does not reuse a Core from a different PatchWarden version", async () => {
    const expected = "C:\\Users\\student\\PatchWarden\\patchwarden.config.json";
    const result = await probeControlCenter(
      async () => ({ ok: true, json: async () => ({ server_version: "1.6.1", config_identity_sha256: configIdentity(expected, "win32") }) }),
      "http://127.0.0.1:8090",
      expected,
      "1.6.4",
    );
    assert.deepEqual(result, { kind: "outdated_patchwarden", version: "1.6.1" });
  });

  it("marks only the diagnostics hash for this Desktop instance as owned", async () => {
    const instanceId = "0123456789abcdef0123456789abcdef";
    const result = await probeControlCenter(async () => ({
      ok: true,
      json: async () => ({
        server_version: "1.6.6",
        desktop_instance_sha256: desktopInstanceIdentity(instanceId),
      }),
    }));
    assert.equal(hasExpectedDesktopInstance(result, instanceId), true);
    assert.equal(hasExpectedDesktopInstance(result, "fedcba9876543210fedcba9876543210"), false);
  });

  it("stops only the exact owned child handle", () => {
    const owned = {};
    assert.equal(mayStopBackend(owned, owned), true);
    assert.equal(mayStopBackend(owned, {}), false);
    assert.equal(mayStopBackend(null, owned), false);
  });

  it("allows 45 seconds for a cold Control Center start", () => {
    assert.equal(DEFAULT_BACKEND_START_TIMEOUT_MS, 45_000);
    assert.ok(DEFAULT_BACKEND_FINAL_PROBE_GRACE_MS > 0);
  });

  it("uses a final grace probe instead of missing readiness at the deadline", async () => {
    let clock = 0;
    const result = await waitForBackendStartup({
      timeoutMs: 1_000,
      pollIntervalMs: 300,
      finalProbeGraceMs: 50,
      now: () => clock,
      sleep: async (delayMs) => { clock += delayMs; },
      probe: async () => clock >= 1_030
        ? { kind: "patchwarden", version: "1.6.6" }
        : { kind: "absent", version: null },
    });
    assert.equal(result.probe.kind, "patchwarden");
    assert.equal(result.finalProbeUsed, true);
    assert.equal(result.elapsedMs, 1_050);
  });

  it("stops waiting promptly when the owned child exits", async () => {
    let clock = 0;
    let alive = true;
    const result = await waitForBackendStartup({
      timeoutMs: 45_000,
      now: () => clock,
      sleep: async (delayMs) => { clock += delayMs; alive = false; },
      shouldContinue: () => alive,
      probe: async () => ({ kind: "absent", version: null }),
    });
    assert.equal(result.stoppedEarly, true);
    assert.equal(result.attempts, 1);
    assert.ok(result.elapsedMs < 45_000);
  });
});
