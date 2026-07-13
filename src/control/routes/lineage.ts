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
import { toSafeTaskLineage, type SafeTaskLineage, type TaskLineageRecord } from "../../tools/taskLineage.js";
import { config, errorMessage, readJsonFileSafeUnder, sendJson } from "../shared.js";

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

export function handleLineages(res: ServerResponse): void {
  try {
    const root = join(config.workspaceRoot, ".patchwarden", "lineages");
    if (!existsSync(root)) {
      sendJson(res, 200, { lineages: [], total: 0, reason: null });
      return;
    }
    const lineages = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => readJsonFileSafeUnder<TaskLineageRecord>(root, join(entry.name, "lineage.json")))
      .filter((entry): entry is TaskLineageRecord => entry !== null)
      .map((entry) => augmentLineageSummary(toSafeTaskLineage(entry, 6), entry))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, 50);
    sendJson(res, 200, { lineages, total: lineages.length, reason: null });
  } catch (err) {
    sendJson(res, 200, { lineages: [], total: 0, reason: errorMessage(err) });
  }
}

export function handleLineageDetail(res: ServerResponse, lineageId: string): void {
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
    sendJson(res, 200, augmentLineageSummary(toSafeTaskLineage(data, 20), data));
  } catch (err) {
    sendJson(res, 200, { lineage_id: lineageId, error: errorMessage(err) });
  }
}
