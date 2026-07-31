import { strict as assert } from "node:assert";
import { before, after, describe, it } from "node:test";
import { performance } from "node:perf_hooks";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ServerResponse } from "node:http";
import type { WatcherStatusSnapshot } from "../../../watcherStatus.js";
import type { LineageWatcherReader } from "../../../control/routes/lineage.js";
import { toSafeTaskLineage, type TaskLineageRecord } from "../../../tools/tasks/taskLineage.js";

let tempDir: string;
let previousConfig: string | undefined;
let handleLineages: (res: ServerResponse, watcherReader?: LineageWatcherReader) => void;

function record(lineageId: string): TaskLineageRecord {
  return {
    lineage_id: lineageId,
    request_id: `${lineageId}-request`,
    goal: "bounded lineage fixture",
    repo_path: tempDir,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:01:00.000Z",
    final_status: "accepted",
    stop_reason: "success",
    next_action: "none",
    main_task: null,
    fix_tasks: [],
    cleanup_tasks: [],
    direct_sessions: [],
    rounds: [],
    warnings: [],
    errors: [],
  };
}

function writeFixture(): void {
  const configPath = join(tempDir, "patchwarden.config.json");
  writeFileSync(configPath, JSON.stringify({
    workspaceRoot: tempDir,
    tasksDir: ".patchwarden/tasks",
    plansDir: ".patchwarden/plans",
    assessmentsDir: ".patchwarden/assessments",
    agents: {},
    allowedTestCommands: [],
    defaultTaskTimeoutSeconds: 30,
    maxTaskTimeoutSeconds: 120,
    watcherStaleSeconds: 30,
  }), "utf-8");
  previousConfig = process.env.PATCHWARDEN_CONFIG;
  process.env.PATCHWARDEN_CONFIG = configPath;

  const tasksDir = join(tempDir, ".patchwarden", "tasks");
  const lineagesDir = join(tempDir, ".patchwarden", "lineages");
  mkdirSync(tasksDir, { recursive: true });
  mkdirSync(lineagesDir, { recursive: true });

  // Keep the heartbeat absent and give the fallback scanner enough real task
  // files to reproduce the production slow path.
  for (let index = 0; index < 1_024; index += 1) {
    const taskDir = join(tasksDir, `task-fixture-${index}`);
    mkdirSync(taskDir);
  }
  for (let index = 0; index < 200; index += 1) {
    const lineageId = `lineage-fixture-${index}`;
    const lineageDir = join(lineagesDir, lineageId);
    mkdirSync(lineageDir);
    writeFileSync(join(lineageDir, "lineage.json"), JSON.stringify(record(lineageId)), "utf-8");
  }
}

function invokeLineages(watcherReader: LineageWatcherReader): { status: number; body: string; elapsedMs: number } {
  let status = 0;
  let body = "";
  const response = {
    writeHead(nextStatus: number) { status = nextStatus; },
    end(payload?: string) { body = payload || ""; },
  } as unknown as ServerResponse;
  const started = performance.now();
  handleLineages(response, watcherReader);
  return { status, body, elapsedMs: performance.now() - started };
}

describe("Control Center lineage route", () => {
  before(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "pw-lineage-route-"));
    writeFixture();
    ({ handleLineages } = await import("../../../control/routes/lineage.js"));
  });

  after(() => {
    if (previousConfig === undefined) delete process.env.PATCHWARDEN_CONFIG;
    else process.env.PATCHWARDEN_CONFIG = previousConfig;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("projects all lineages with one bounded watcher scan within five seconds", () => {
    assert.equal(existsSync(join(tempDir, ".patchwarden", "watcher-heartbeat.json")), false);
    let watcherReads = 0;
    const watcherReader: LineageWatcherReader = () => {
      watcherReads += 1;
      return {
        status: "missing",
        available: false,
        stale_after_seconds: 30,
        last_heartbeat_at: null,
        heartbeat_age_seconds: null,
        heartbeat_pid: null,
        instance_id: null,
        launcher_pid: null,
        reason: "fixture heartbeat is missing",
        activity: null,
      };
    };
    const result = invokeLineages(watcherReader);
    assert.equal(result.status, 200);
    const payload = JSON.parse(result.body) as { lineages: unknown[]; total: number };
    assert.equal(payload.total, 50);
    assert.equal(payload.lineages.length, 50);
    assert.equal(watcherReads, 1);
    assert.ok(result.elapsedMs < 5_000, `lineage route took ${result.elapsedMs.toFixed(0)}ms`);
  });
});

describe("toSafeTaskLineage watcher snapshot", () => {
  it("uses the injected snapshot without re-reading watcher state", () => {
    const watcher: WatcherStatusSnapshot = {
      status: "stale",
      available: false,
      stale_after_seconds: 30,
      last_heartbeat_at: "2026-01-01T00:00:00.000Z",
      heartbeat_age_seconds: 120,
      heartbeat_pid: null,
      instance_id: null,
      launcher_pid: null,
      reason: "fixture watcher is stale",
      activity: null,
    };
    const projected = toSafeTaskLineage(record("lineage-snapshot"), 8, watcher);
    assert.equal(projected.connection_recovery.watcher.state, "stale");
    assert.equal(projected.connection_recovery.watcher.healthy, false);
  });
});
