/**
 * Control Center routes — audit aggregation, warnings, and log tails.
 *
 * `handleAudit` joins independent-review.md + audit.json across tasks and
 * direct sessions. `handleWarnings` buckets audit/stale/verification warnings
 * by type. `handleLogs` returns redacted stdout/stderr tails for core, direct,
 * watcher, and control-center log categories.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type ServerResponse } from "node:http";
import { type TaskEntry, listTasks } from "../../tools/tasks/listTasks.js";
import { type WatcherStatusSnapshot } from "../../watcherStatus.js";
import { redactSensitiveContent } from "../../security/contentRedaction.js";
import { getDirectSessionsDir, getTasksDir } from "../../config.js";
import {
  classifyStaleTask,
  fileMtimeIso,
  parseReviewVerdict,
  readWatcherStatusSafe,
} from "../runtime.js";
import {
  config,
  errorMessage,
  findLatestLog,
  guardControlPath,
  getControlCenterLogDir,
  getRuntimeRoot,
  readFileTail,
  readJsonFileSafe,
  readTextFileSafe,
  sendJson,
} from "../shared.js";

export type LogCategory = "core" | "direct" | "watcher" | "control-center";

export function handleLogs(res: ServerResponse, category: LogCategory, tailLines: number): void {
  try {
    let dir: string;
    let stdoutPath: string;
    let stderrPath: string;
    let stdoutExists: boolean;
    let stderrExists: boolean;

    if (category === "control-center") {
      dir = getControlCenterLogDir();
      stdoutPath = join(dir, "control-center.stdout.log");
      stderrPath = join(dir, "control-center.stderr.log");
      stdoutExists = existsSync(stdoutPath);
      stderrExists = existsSync(stderrPath);
    } else if (category === "watcher") {
      dir = getRuntimeRoot(false);
      const sp = findLatestLog(dir, /^watcher-.*\.stdout\.log$/);
      const ep = findLatestLog(dir, /^watcher-.*\.stderr\.log$/);
      stdoutPath = sp ?? "";
      stderrPath = ep ?? "";
      stdoutExists = sp !== null;
      stderrExists = ep !== null;
    } else {
      // core | direct -> tunnel client logs in the matching runtime dir
      dir = getRuntimeRoot(category === "direct");
      stdoutPath = join(dir, "tunnel-client.stdout.log");
      stderrPath = join(dir, "tunnel-client.stderr.log");
      stdoutExists = existsSync(stdoutPath);
      stderrExists = existsSync(stderrPath);
    }

    if (!stdoutExists && !stderrExists) {
      sendJson(res, 200, {
        stdout: "",
        stderr: "",
        category,
        tail: tailLines,
        reason: "log file not found",
      });
      return;
    }

    const stdoutRaw = stdoutExists ? readFileTail(stdoutPath, tailLines) : "";
    const stderrRaw = stderrExists ? readFileTail(stderrPath, tailLines) : "";
    const stdout = redactSensitiveContent(stdoutRaw).content;
    const stderr = redactSensitiveContent(stderrRaw).content;
    sendJson(res, 200, { stdout, stderr, category, tail: tailLines, reason: null });
  } catch (err) {
    sendJson(res, 200, { stdout: "", stderr: "", category, tail: tailLines, reason: errorMessage(err) });
  }
}

export function handleAudit(res: ServerResponse): void {
  try {
    const audits: Array<Record<string, unknown>> = [];

    // 1. tasks/*/independent-review.md (written by audit_task — the primary audit artifact)
    // 2. tasks/*/audit.json (legacy/explicit JSON audit, if present)
    const tasksDir = getTasksDir(config);
    if (existsSync(tasksDir)) {
      let taskEntries: import("node:fs").Dirent[] = [];
      try {
        taskEntries = readdirSync(tasksDir, { withFileTypes: true }).filter((e) => e.isDirectory());
      } catch {
        taskEntries = [];
      }
      for (const entry of taskEntries) {
        const taskDir = guardControlPath(join(tasksDir, entry.name), config.tasksDir);
        if (!taskDir) continue;

        // independent-review.md
        const reviewFile = join(taskDir, "independent-review.md");
        if (existsSync(reviewFile)) {
          const content = readTextFileSafe(reviewFile) ?? "";
          audits.push({
            task_id: entry.name,
            source: "independent-review.md",
            verdict: parseReviewVerdict(content),
            checked_at: fileMtimeIso(reviewFile),
            content_excerpt: content.slice(0, 500),
          });
        }

        // audit.json (explicit JSON audit if present)
        const auditFile = join(taskDir, "audit.json");
        if (existsSync(auditFile)) {
          const data = readJsonFileSafe<Record<string, unknown>>(auditFile);
          if (data) {
            audits.push({
              task_id: entry.name,
              source: "audit.json",
              checked_at: data.checked_at ?? fileMtimeIso(auditFile),
              ...data,
            });
          }
        }
      }
    }

    // 3. direct-sessions/*/audit.json (written by Direct audit_session)
    const sessionsDir = getDirectSessionsDir(config);
    if (existsSync(sessionsDir)) {
      let sessionEntries: import("node:fs").Dirent[] = [];
      try {
        sessionEntries = readdirSync(sessionsDir, { withFileTypes: true }).filter((e) => e.isDirectory());
      } catch {
        sessionEntries = [];
      }
      for (const entry of sessionEntries) {
        const sessionDir = guardControlPath(join(sessionsDir, entry.name), config.directSessionsDir);
        if (!sessionDir) continue;
        const auditFile = join(sessionDir, "audit.json");
        if (!existsSync(auditFile)) continue;
        const data = readJsonFileSafe<Record<string, unknown>>(auditFile);
        if (data) {
          audits.push({
            source: "direct-session",
            session_id: data.session_id ?? entry.name,
            checked_at: fileMtimeIso(auditFile),
            ...data,
          });
        }
      }
    }

    // Sort by checked_at descending (missing timestamps sort last).
    audits.sort((a, b) => {
      const ac = String(a.checked_at ?? "");
      const bc = String(b.checked_at ?? "");
      return bc.localeCompare(ac);
    });
    const limited = audits.slice(0, 50);
    sendJson(res, 200, { audits: limited, total: limited.length });
  } catch (err) {
    sendJson(res, 200, { audits: [], reason: errorMessage(err) });
  }
}

// ── Warnings aggregation ─────────────────────────────────────────

interface WarningEntry {
  type: string;
  severity: "error" | "warning" | "info";
  affected_tasks_count: number;
  affected_tasks: string[];
  likely_false_positive: boolean;
  needs_fix: boolean;
  blocked: boolean;
  recommended_action: string;
}

/**
 * Aggregate warnings from multiple sources:
 *  - audit.json warnings/fail_checks/possible_false_positives/manual_verification_required
 *  - stale task classification (heartbeat stale, collecting_artifacts stale, etc.)
 *  - task status=failed_verification
 *
 * Each warning type is grouped into a bucket with affected task IDs. The
 * handler is fault-tolerant: any per-task read failure is skipped, and a
 * top-level failure returns an empty warnings array (never 500).
 */
export function handleWarnings(res: ServerResponse): void {
  try {
    const buckets: Record<string, Set<string>> = {
      unrecorded_command_execution: new Set(),
      artifact_hygiene: new Set(),
      scope_changes: new Set(),
      release_publish_claim: new Set(),
      manual_verification_required: new Set(),
      stale_task: new Set(),
      failed_verification: new Set(),
    };

    const tasksDir = getTasksDir(config);
    let taskList: TaskEntry[] = [];
    let watcher: WatcherStatusSnapshot;
    try {
      const result = listTasks({ limit: 100 });
      taskList = result.tasks;
      watcher = result.watcher;
    } catch (err) {
      watcher = readWatcherStatusSafe();
    }

    const now = Date.now();

    for (const task of taskList) {
      const taskId = task.task_id;

      // 1. Read audit.json for warning strings
      const taskDir = guardControlPath(join(tasksDir, taskId), config.tasksDir);
      if (!taskDir) continue;
      const auditFile = join(taskDir, "audit.json");
      const audit = readJsonFileSafe<Record<string, unknown>>(auditFile);
      if (audit) {
        const warningTexts: string[] = [];
        const collectStrings = (field: unknown) => {
          if (Array.isArray(field)) {
            for (const w of field) {
              if (typeof w === "string") {
                warningTexts.push(w);
              } else if (w && typeof w === "object") {
                const obj = w as Record<string, unknown>;
                if (typeof obj.message === "string") warningTexts.push(obj.message);
                else if (typeof obj.description === "string") warningTexts.push(obj.description);
                else if (typeof obj.warning === "string") warningTexts.push(obj.warning);
                else warningTexts.push(JSON.stringify(obj));
              }
            }
          } else if (typeof field === "string") {
            warningTexts.push(field);
          }
        };
        collectStrings(audit.warnings);
        collectStrings(audit.fail_checks);
        collectStrings(audit.possible_false_positives);

        for (const text of warningTexts) {
          const lower = text.toLowerCase();
          if (lower.includes("unrecorded") || lower.includes("command execution")) {
            buckets.unrecorded_command_execution.add(taskId);
          }
          if (lower.includes("artifact") || lower.includes("hygiene")) {
            buckets.artifact_hygiene.add(taskId);
          }
          if (lower.includes("scope") || lower.includes("out_of_scope")) {
            buckets.scope_changes.add(taskId);
          }
          if (lower.includes("release") || lower.includes("publish")) {
            buckets.release_publish_claim.add(taskId);
          }
        }

        // manual_verification_required flag
        if (audit.manual_verification_required === true) {
          buckets.manual_verification_required.add(taskId);
        }
      }

      // 2. Stale tasks
      try {
        const cls = classifyStaleTask(task, watcher, now);
        if (cls.is_stale) {
          buckets.stale_task.add(taskId);
        }
      } catch {
        // skip stale classification failure
      }

      // 3. Failed verification
      if (task.status === "failed_verification") {
        buckets.failed_verification.add(taskId);
      }
    }

    const warnings: WarningEntry[] = [];
    const addWarning = (
      type: string,
      severity: "error" | "warning" | "info",
      likelyFalsePositive: boolean,
      needsFix: boolean,
      blocked: boolean,
      recommendedAction: string
    ) => {
      const tasks = buckets[type];
      if (tasks.size === 0) return;
      warnings.push({
        type,
        severity,
        affected_tasks_count: tasks.size,
        affected_tasks: Array.from(tasks),
        likely_false_positive: likelyFalsePositive,
        needs_fix: needsFix,
        blocked,
        recommended_action: recommendedAction,
      });
    };

    addWarning("failed_verification", "error", false, true, false, "Re-run verification or fix the failing checks before retrying.");
    addWarning("stale_task", "warning", false, false, false, "Reconcile or recreate stale tasks.");
    addWarning("manual_verification_required", "warning", false, false, false, "Review the audit findings and manually verify the changes.");
    addWarning("unrecorded_command_execution", "info", false, true, false, "Investigate unrecorded command executions; ensure watcher captures all commands.");
    addWarning("release_publish_claim", "info", false, false, true, "Verify the release/publish claim against actual release artifacts before proceeding.");
    addWarning("artifact_hygiene", "info", true, false, false, "Review artifact hygiene warnings; many are likely false positives.");
    addWarning("scope_changes", "info", true, false, false, "Review scope changes; verify they are intentional before accepting.");

    sendJson(res, 200, { warnings, total: warnings.length });
  } catch (err) {
    sendJson(res, 200, { warnings: [], total: 0, error: errorMessage(err) });
  }
}
