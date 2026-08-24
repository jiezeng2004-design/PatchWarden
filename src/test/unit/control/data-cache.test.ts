import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clearControlDataCache,
  getCachedControlData,
  runWithControlDataCacheInvalidation,
} from "../../../control/dataCache.js";

describe("Control Center data cache", () => {
  it("reuses a snapshot inside the TTL and reloads it after expiry", () => {
    clearControlDataCache();
    let reads = 0;
    const load = () => ({ sequence: ++reads });

    const first = getCachedControlData("test-snapshot", load, 1_000, 10_000);
    const second = getCachedControlData("test-snapshot", load, 1_000, 10_500);
    const expired = getCachedControlData("test-snapshot", load, 1_000, 11_001);

    assert.equal(first.sequence, 1);
    assert.equal(second, first);
    assert.equal(expired.sequence, 2);
    clearControlDataCache();
  });

  it("clears snapshots after a mutation handler throws", async () => {
    clearControlDataCache();
    let reads = 0;
    const load = () => ({ sequence: ++reads });
    getCachedControlData("mutation-snapshot", load);

    await assert.rejects(
      runWithControlDataCacheInvalidation(async () => {
        const repopulated = getCachedControlData("mutation-snapshot", load);
        assert.equal(repopulated.sequence, 2);
        throw new Error("simulated post-mutation failure");
      }),
      /simulated post-mutation failure/,
    );

    const afterFailure = getCachedControlData("mutation-snapshot", load);
    assert.equal(afterFailure.sequence, 3, "failed mutations must not leave a repopulated snapshot cached");
    clearControlDataCache();
  });
});
