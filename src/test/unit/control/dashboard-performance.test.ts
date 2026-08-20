import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

function section(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing dashboard marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing dashboard marker: ${endMarker}`);
  return source.slice(start, end);
}

describe("Control Center dashboard performance contract", () => {
  it("loads status before bounded historical batches and reuses shared snapshots", () => {
    const dashboard = readFileSync(resolve(process.cwd(), "ui", "pages", "dashboard.html"), "utf-8");
    const refreshAll = section(dashboard, "async function refreshAll()", "// ---------- Actions ----------");
    const statusLoad = refreshAll.indexOf("const status = await refreshStatus();");
    const failureGuard = refreshAll.indexOf("if (!status) return false;");
    assert.notEqual(statusLoad, -1, "dashboard should await live status before historical panels");
    assert.ok(failureGuard > statusLoad, "failed live status should return false before loading history");

    const historicalRefreshes = [
      "refreshTasks()",
      "refreshLogs()",
      "refreshEvents()",
      "refreshLineages()",
      "refreshProjectPolicy()",
      "refreshReleaseStatus()",
      "refreshEvidencePacks()",
      "refreshStaleTasks()",
    ];
    for (const refresh of historicalRefreshes) {
      assert.ok(refreshAll.indexOf(refresh) > failureGuard, `${refresh} should not run when status loading fails`);
    }

    const settledBatches = refreshAll.match(/Promise\.allSettled\(\[[\s\S]*?\]\)/g) || [];
    assert.ok(settledBatches.length >= 2, "historical panels should load in multiple bounded allSettled batches");
    assert.match(refreshAll, /setTimeout\(resolvePromise, 0\)/, "background dashboards must advance between batches");
    assert.doesNotMatch(refreshAll, /requestAnimationFrame/, "batch progress must not depend on a visible frame");
    const settledHistory = settledBatches.join("\n");
    for (const refresh of historicalRefreshes) {
      assert.ok(settledHistory.includes(refresh), `${refresh} should be isolated in an allSettled batch`);
    }

    const refreshStatus = section(dashboard, "async function refreshStatus()", "async function refreshTasks()");
    const reusesStatus = refreshStatus.includes("refreshHealthScore(data)")
      || refreshAll.includes("refreshHealthScore(status)");
    assert.ok(reusesStatus, "health score should reuse the successful status payload");

    const lineageRoute = readFileSync(resolve(process.cwd(), "src", "control", "routes", "lineage.ts"), "utf-8");
    assert.ok(
      lineageRoute.includes("toSafeTaskLineage(entry, 6, watcher)"),
      "lineage list must reuse one watcher snapshot instead of probing once per record",
    );
  });
});
