import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { configIdentity, mayStopBackend, probeControlCenter } from "../dist/backend-probe.js";

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

  it("stops only the exact owned child handle", () => {
    const owned = {};
    assert.equal(mayStopBackend(owned, owned), true);
    assert.equal(mayStopBackend(owned, {}), false);
    assert.equal(mayStopBackend(null, owned), false);
  });
});
