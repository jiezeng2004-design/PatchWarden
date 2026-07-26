#!/usr/bin/env node
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
const apply = process.argv.includes("--apply");
const goalId = "goal_20260725_creatorpulse";
const failureStatuses = new Set([
  "failed",
  "canceled",
  "timeout",
  "orphaned",
  "failed_policy_violation",
  "failed_scope_violation",
  "failed_verification",
]);

const { getTasksDir, reloadConfig } = await import("../../dist/config.js");
const { reconcileTasks } = await import("../../dist/tools/tasks/reconcileTasks.js");
const { archiveTasks, readTaskHistoryState } = await import("../../dist/tools/tasks/taskHistory.js");
const { migrateQueuedSubgoalsFromTasks } = await import("../../dist/goal/subgoalSync.js");
const { readGoalStatus } = await import("../../dist/goal/goalStore.js");

const config = reloadConfig(process.env.PATCHWARDEN_CONFIG);
const tasksDir = getTasksDir(config);
const rows = readTaskRows(tasksDir);
const failureIds = rows.filter((row) => failureStatuses.has(row.status)).map((row) => row.taskId).sort();
const reconcileReport = reconcileTasks({ mode: "report_only" }, config);
const repairIds = reconcileReport.reports
  .filter((report) => Array.isArray(report.evidence_summary.missing_artifacts))
  .map((report) => report.task_id)
  .sort();
const goalBefore = readGoalStatus(goalId, config.workspaceRoot);

const report = {
  mode: apply ? "apply" : "report_only",
  tasks_total: rows.length,
  pending_before: rows.filter((row) => row.status === "pending").length,
  failure_candidates: failureIds.length,
  terminal_evidence_repairs: repairIds.length,
  archived_before: rows.filter((row) => row.historyState === "archived").length,
  creatorpulse_running_before: goalBefore.subgoals.filter((subgoal) => subgoal.status === "running").length,
  creatorpulse_queued_before: goalBefore.subgoals.filter((subgoal) => subgoal.status === "queued").length,
};

if (!apply) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

if (rows.length !== 115 || failureIds.length !== 44 || repairIds.length !== 13) {
  throw new Error(`Live migration precondition failed: ${JSON.stringify(report)}`);
}

const timestamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
const backupDir = join(dirname(tasksDir), "recovery-backups", `model-history-goal-${timestamp}`);
backupMetadata(rows, backupDir, goalId, config.workspaceRoot);

const repair = reconcileTasks({ mode: "safe_fix", task_ids: repairIds }, config);
if (repair.reconciled !== repairIds.length) {
  throw new Error(`Expected ${repairIds.length} evidence repairs, applied ${repair.reconciled}.`);
}
const archive = archiveTasks(failureIds, config);
if (archive.archived.length + archive.unchanged.length !== failureIds.length || archive.rejected.length > 0) {
  throw new Error(`History archive did not converge: ${JSON.stringify(archive.rejected)}`);
}
const migratedSubgoals = migrateQueuedSubgoalsFromTasks(goalId, config.workspaceRoot);

const afterRows = readTaskRows(tasksDir);
const goalAfter = readGoalStatus(goalId, config.workspaceRoot);
const final = {
  ...report,
  backup_dir: backupDir,
  repair_log_path: repair.reconcile_log_path,
  repaired: repair.reconciled,
  archived: afterRows.filter((row) => row.historyState === "archived").length,
  archive_manifest_path: archive.manifest_path,
  migrated_subgoals: migratedSubgoals,
  pending_after: afterRows.filter((row) => row.status === "pending").length,
  creatorpulse_running_after: goalAfter.subgoals.filter((subgoal) => subgoal.status === "running").length,
  creatorpulse_queued_after: goalAfter.subgoals.filter((subgoal) => subgoal.status === "queued").length,
};
if (
  final.archived !== 44
  || final.pending_after !== 8
  || final.migrated_subgoals !== 8
  || final.creatorpulse_running_after !== 0
  || final.creatorpulse_queued_after !== 8
) {
  throw new Error(`Live migration postcondition failed: ${JSON.stringify(final)}`);
}
console.log(JSON.stringify(final, null, 2));

function readTaskRows(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const statusPath = join(directory, entry.name, "status.json");
      if (!existsSync(statusPath)) return [];
      try {
        const status = JSON.parse(readFileSync(statusPath, "utf-8"));
        return [{
          taskId: entry.name,
          statusPath,
          status: String(status.status || ""),
          historyState: readTaskHistoryState(status),
        }];
      } catch {
        return [];
      }
    });
}

function backupMetadata(taskRows, destination, currentGoalId, workspaceRoot) {
  for (const row of taskRows) {
    const target = join(destination, "tasks", row.taskId, "status.json");
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(row.statusPath, target);
  }
  const goalStatusPath = join(workspaceRoot, ".patchwarden", "goals", currentGoalId, "goal_status.json");
  const goalTarget = join(destination, "goals", currentGoalId, "goal_status.json");
  mkdirSync(dirname(goalTarget), { recursive: true });
  copyFileSync(goalStatusPath, goalTarget);
  const manifest = {
    created_at: new Date().toISOString(),
    tasks_backed_up: taskRows.length,
    goal_id: currentGoalId,
    files: ["tasks/*/status.json", `goals/${currentGoalId}/goal_status.json`],
  };
  const manifestPath = join(destination, "manifest.json");
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
}
