/**
 * Control Center routes — task lineage (/api/lineages/*).
 *
 * Lists all lineages under .patchwarden/lineages (bounded to 50, most recently
 * updated first) and serves a single lineage detail. Each record is projected
 * through `toSafeTaskLineage` so full artifact content is bounded.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type ServerResponse } from "node:http";
import type { PatchWardenConfig } from "../../config.js";
import { toSafeTaskLineage, type SafeTaskLineage, type TaskLineageRecord } from "../../tools/tasks/taskLineage.js";
import { config, errorMessage, readJsonFileSafeUnder, sendJson } from "../shared.js";
import { getCachedControlData } from "../dataCache.js";
import { readWatcherStatus, type WatcherStatusSnapshot } from "../../watcherStatus.js";

export type LineageWatcherReader = (config: PatchWardenConfig) => WatcherStatusSnapshot;

interface LineageSummary {
  iterations: number;
  main_task_count: number;
  fix_task_count: number;
  cleanup_task_count: number;
  direct_verification: {
    session_id: string;
    status: string;
    audit_decision: string;
    command_count: number;
    passed_commands: number;
    failed_commands: number;
  } | null;
  warnings_count: number;
}

function augmentLineageSummary(safe: SafeTaskLineage, record: TaskLineageRecord): SafeTaskLineage & LineageSummary {
  const directSessions = safe.tasks.direct_sessions;
  const firstDirect = directSessions.length > 0 ? directSessions[0] : null;
  const directVerification = firstDirect
    ? {
        session_id: firstDirect.session_id,
        status: firstDirect.status || "unknown",
        audit_decision: firstDirect.audit_decision || "not_run",
        command_count: firstDirect.command_count ?? 0,
        passed_commands: firstDirect.passed_commands ?? 0,
        failed_commands: firstDirect.failed_commands ?? 0,
      }
    : null;
  return {
    ...safe,
    iterations: record.rounds.length,
    main_task_count: record.main_task ? 1 : 0,
    fix_task_count: record.fix_tasks.length,
    cleanup_task_count: record.cleanup_tasks.length,
    direct_verification: directVerification,
    warnings_count: record.warnings.length,
  };
}

export function handleLineages(res: ServerResponse, watcherReader?: LineageWatcherReader): void {
  try {
    const effectiveWatcherReader = watcherReader ?? readWatcherStatus;
    const load = () => {
      const root = join(config.workspaceRoot, ".patchwarden", "lineages");
      if (!existsSync(root)) return { lineages: [], total: 0, reason: null };
      const watcher = effectiveWatcherReader(config);
      const lineages = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => readJsonFileSafeUnder<TaskLineageRecord>(root, join(entry.name, "lineage.json")))
        .filter((entry): entry is TaskLineageRecord => entry !== null)
        .map((entry) => augmentLineageSummary(toSafeTaskLineage(entry, 6, watcher), entry))
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .slice(0, 50);
      return { lineages, total: lineages.length, reason: null };
    };
    const payload = watcherReader === undefined
      ? getCachedControlData(`lineages\u0000${config.workspaceRoot}`, load)
      : load();
    sendJson(res, 200, payload);
  } catch (err) {
    sendJson(res, 200, { lineages: [], total: 0, reason: errorMessage(err) });
  }
}

export function handleLineageDetail(
  res: ServerResponse,
  lineageId: string,
  watcherReader: LineageWatcherReader = readWatcherStatus,
): void {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(lineageId)) {
      sendJson(res, 400, { error: "Invalid lineage id" });
      return;
    }
    const data = readJsonFileSafeUnder<TaskLineageRecord>(
      join(config.workspaceRoot, ".patchwarden", "lineages"),
      join(lineageId, "lineage.json")
    );
    if (!data) {
      sendJson(res, 404, { error: "Lineage not found" });
      return;
    }
    const watcher = watcherReader(config);
    sendJson(res, 200, augmentLineageSummary(toSafeTaskLineage(data, 20, watcher), data));
  } catch (err) {
    sendJson(res, 200, { lineage_id: lineageId, error: errorMessage(err) });
  }
}
