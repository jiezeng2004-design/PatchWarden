/**
 * Control Center routes — task queries (GET /api/tasks/*).
 *
 * Hosts the read-only task endpoints: list/filter tasks, stale-task
 * classification with explanations, task detail, and the safe bounded views
 * (safe-result / safe-audit / safe-test-summary / safe-diff-summary) that
 * never expose full stdout/stderr/diff content. Mutating task actions live in
 * taskActions.ts.
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { type ServerResponse } from "node:http";
import { listTasks } from "../../tools/tasks/listTasks.js";
import { safeAudit, safeDiffSummary, safeResult, safeTestSummary } from "../../tools/diagnostics/safeViews.js";
import { getTasksDir } from "../../config.js";
import {
  augmentTaskWithStale,
  classifyStaleTask,
  fileMtimeIso,
  isValidTaskId,
  parseReviewVerdict,
  reconstructTaskEntry,
  readWatcherStatusSafe,
  StaleClassification,
  TERMINAL_TASK_STATUSES,
} from "../runtime.js";
import { config, errorMessage, guardControlPath, readJsonFileSafe, readTextFileSafe, sendJson } from "../shared.js";

export interface TaskFilters {
  repo_path?: string;
  status?: string;
  acceptance_status?: string;
  agent?: string;
  warning_type?: string;
  date_from?: string;
  date_to?: string;
  limit?: number;
  cursor?: string;
}

export function handleTasks(res: ServerResponse, filters?: TaskFilters): void {
  try {
    const result = listTasks({ limit: 100 });
    const watcher = result.watcher;
    const now = Date.now();
    let augmented = result.tasks.map((t) => augmentTaskWithStale(t, watcher, now));
    const facetSource = augmented.slice();
    // Apply optional filters from query params.
    if (filters) {
      if (filters.repo_path) {
        const filterRepo = filters.repo_path.trim().replace(/\\/g, "/");
        augmented = augmented.filter((t) => {
          const taskRepo = String(t.repo_path || ".").replace(/\\/g, "/");
          const taskResolved = String(t.resolved_repo_path || "").replace(/\\/g, "/");
          return taskRepo === filterRepo || taskResolved === filterRepo;
        });
      }
      if (filters.status) {
        augmented = augmented.filter((t) => t.status === filters.status);
      }
      if (filters.acceptance_status) {
        augmented = augmented.filter((t) => {
          // Tasks without acceptance status only match the "pending" filter when
          // status is done_by_agent; null acceptance never matches other values.
          return t.acceptance_status === filters.acceptance_status;
        });
      }
      if (filters.agent) {
        const filterAgent = filters.agent.toLowerCase();
        augmented = augmented.filter((t) => String(t.agent || "").toLowerCase() === filterAgent);
      }
      if (filters.warning_type) {
        const wt = filters.warning_type;
        if (wt === "stale" || wt === "stale_task") {
          augmented = augmented.filter((t) => t.is_stale);
        } else if (wt === "error") {
          augmented = augmented.filter((t) => t.error !== null && t.error !== "");
        } else if (wt === "failed_verification") {
          augmented = augmented.filter((t) => t.status === wt);
        } else {
          augmented = augmented.filter((t) =>
            t.status === wt || t.acceptance_status === wt ||
            (Array.isArray(t.stale_reasons) && t.stale_reasons.includes(wt)),
          );
        }
      }
      if (filters.date_from || filters.date_to) {
        const from = filters.date_from ? Date.parse(`${filters.date_from}T00:00:00`) : Number.NEGATIVE_INFINITY;
        const to = filters.date_to ? Date.parse(`${filters.date_to}T23:59:59`) : Number.POSITIVE_INFINITY;
        augmented = augmented.filter((task) => {
          const timestamp = Date.parse(String(task.updated_at || task.created_at || ""));
          return Number.isFinite(timestamp) && timestamp >= from && timestamp <= to;
        });
      }
    }
    augmented.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")) || String(b.task_id).localeCompare(String(a.task_id)));
    const staleCount = augmented.filter((t) => t.is_stale).length;
    const limit = Math.max(10, Math.min(filters?.limit || 25, 100));
    const offset = filters?.cursor && /^\d+$/.test(filters.cursor) ? Number(filters.cursor) : 0;
    const page = augmented.slice(offset, offset + limit);
    const nextCursor = offset + page.length < augmented.length ? String(offset + page.length) : null;
    const facets = {
      repos: [...new Set(facetSource.map((task) => String(task.repo_path || ".")))].sort(),
      statuses: [...new Set(facetSource.map((task) => String(task.status || "unknown")))].sort(),
      agents: [...new Set(facetSource.map((task) => String(task.agent || "unknown")))].sort(),
    };
    sendJson(res, 200, {
      tasks: page,
      total: augmented.length,
      returned: page.length,
      nextCursor,
      next_cursor: nextCursor,
      filters: {
        applied: {
          repo_path: filters?.repo_path || null,
          status: filters?.status || null,
          acceptance_status: filters?.acceptance_status || null,
          agent: filters?.agent || null,
          warning_type: filters?.warning_type || null,
          date_from: filters?.date_from || null,
          date_to: filters?.date_to || null,
        },
        options: facets,
      },
      facets,
      watcher,
      stale_count: staleCount,
    });
  } catch (err) {
    sendJson(res, 200, {
      tasks: [],
      total: 0,
      returned: 0,
      nextCursor: null,
      next_cursor: null,
      filters: { applied: {}, options: { repos: [], statuses: [], agents: [] } },
      facets: { repos: [], statuses: [], agents: [] },
      watcher: null,
      stale_count: 0,
      error: errorMessage(err),
    });
  }
}

export function deriveStaleReasonCode(staleReasons: string[]): string {
  if (staleReasons.length === 0) return "unknown";
  if (staleReasons.some((r) => r.includes("heartbeat_stale"))) return "heartbeat_stale";
  if (staleReasons.some((r) => r.includes("config") || r.includes("assessment"))) return "assessment_stale_config";
  if (staleReasons.some((r) => r.includes("runtime") || r.includes("missing"))) return "runtime_missing";
  return staleReasons[0];
}

export function staleExplanationFor(reasonCode: string): { explanation: string; next_action: string } {
  switch (reasonCode) {
    case "assessment_stale_config":
      return {
        explanation: "配置或 tool manifest 已变化，旧 assessment 已过期，需要重新评估或重新创建任务。",
        next_action: "reconcile or recreate task",
      };
    case "heartbeat_stale":
      return {
        explanation: "任务心跳已过期，watcher 可能未运行或任务已僵死，建议 reconcile 或 kill。",
        next_action: "reconcile or kill task",
      };
    case "runtime_missing":
      return {
        explanation: "任务运行时文件缺失，可能被外部清理，建议重新创建任务。",
        next_action: "recreate task",
      };
    default:
      return {
        explanation: "任务状态异常",
        next_action: "review task",
      };
  }
}

export function handleStaleTasks(res: ServerResponse): void {
  try {
    const result = listTasks({ limit: 100 });
    const watcher = result.watcher;
    const now = Date.now();
    const staleTasks = result.tasks
      .map((t) => augmentTaskWithStale(t, watcher, now))
      .filter((t) => t.is_stale)
      .map((t) => {
        const reasonCode = deriveStaleReasonCode(t.stale_reasons);
        const { explanation, next_action } = staleExplanationFor(reasonCode);
        return { ...t, reason_code: reasonCode, explanation, next_action };
      });
    sendJson(res, 200, {
      stale_tasks: staleTasks,
      total: staleTasks.length,
      watcher,
      stale_threshold_seconds: config.watcherStaleSeconds,
      reason: null,
    });
  } catch (err) {
    sendJson(res, 200, { stale_tasks: [], total: 0, reason: errorMessage(err) });
  }
}

export function handleTaskDetail(res: ServerResponse, taskId: string): void {
  try {
    if (!isValidTaskId(taskId)) {
      sendJson(res, 400, { error: "Invalid task id" });
      return;
    }
    const tasksDir = getTasksDir(config);
    const taskDir = guardControlPath(join(tasksDir, taskId), config.tasksDir);
    if (!taskDir || !existsSync(taskDir) || !statSync(taskDir).isDirectory()) {
      sendJson(res, 404, { error: "Task not found" });
      return;
    }

    const statusData = readJsonFileSafe<Record<string, unknown>>(join(taskDir, "status.json"));
    const runtimeData = readJsonFileSafe<Record<string, unknown>>(join(taskDir, "runtime.json"));
    const resultData = readJsonFileSafe<Record<string, unknown>>(join(taskDir, "result.json"));
    const auditData = readJsonFileSafe<Record<string, unknown>>(join(taskDir, "audit.json"));
    const verifyData = readJsonFileSafe<Record<string, unknown>>(join(taskDir, "verify.json"));
    const changedFiles = readJsonFileSafe<Record<string, unknown>>(join(taskDir, "changed-files.json"));
    const fileStats = readJsonFileSafe<Record<string, unknown>>(join(taskDir, "file-stats.json"));
    const reconcileData = readJsonFileSafe<Record<string, unknown>>(join(taskDir, "reconcile.json"));

    // independent-review.md is the primary audit artifact (written by audit_task)
    const reviewPath = join(taskDir, "independent-review.md");
    let independentReview: { verdict: string | null; content: string | null } = { verdict: null, content: null };
    if (existsSync(reviewPath)) {
      const content = readTextFileSafe(reviewPath) ?? "";
      independentReview = { verdict: parseReviewVerdict(content), content };
    }

    // Verification summary from verify.json
    const verificationSummary = verifyData
      ? {
          status: verifyData.status ?? null,
          commands: Array.isArray(verifyData.commands) ? verifyData.commands : null,
          checked_at: fileMtimeIso(join(taskDir, "verify.json")),
        }
      : null;

    // Warnings / errors collected from status.error, result.warnings, error.log
    const warnings: string[] = [];
    const errors: string[] = [];
    if (statusData && statusData.error) errors.push(String(statusData.error));
    if (resultData && Array.isArray(resultData.warnings)) {
      for (const w of resultData.warnings) warnings.push(String(w));
    }
    if (resultData && resultData.error) errors.push(String(resultData.error));
    const errorLog = readJsonFileSafe<Record<string, unknown>>(join(taskDir, "error.log"));
    if (errorLog && errorLog.message) errors.push(String(errorLog.message));

    // Stale classification (best-effort, using watcher snapshot)
    let stale: StaleClassification | null = null;
    if (statusData) {
      const watcher = readWatcherStatusSafe();
      const entry = reconstructTaskEntry(taskId, statusData, runtimeData ?? {}, watcher);
      stale = classifyStaleTask(entry, watcher);
    }

    sendJson(res, 200, {
      task_id: taskId,
      status: statusData,
      runtime: runtimeData,
      result: resultData,
      audit: auditData,
      independent_review: independentReview,
      diff_patch: readTextFileSafe(join(taskDir, "diff.patch")),
      test_log: readTextFileSafe(join(taskDir, "test.log")) ?? readTextFileSafe(join(taskDir, "test-log.txt")),
      verify_log: readTextFileSafe(join(taskDir, "verify.log")),
      changed_files: changedFiles,
      file_stats: fileStats,
      verification_summary: verificationSummary,
      warnings,
      errors,
      stale,
      reconcile: reconcileData,
      task_dir: taskDir,
    });
  } catch (err) {
    sendJson(res, 200, { task_id: taskId, error: errorMessage(err) });
  }
}

export function handleTaskSafeResult(res: ServerResponse, taskId: string): void {
  try {
    if (!isValidTaskId(taskId)) {
      sendJson(res, 400, { error: "Invalid task id" });
      return;
    }
    sendJson(res, 200, safeResult(taskId, { max_items: 12 }));
  } catch (err) {
    sendJson(res, 200, { task_id: taskId, error: errorMessage(err) });
  }
}

export function handleTaskSafeAudit(res: ServerResponse, taskId: string): void {
  try {
    if (!isValidTaskId(taskId)) {
      sendJson(res, 400, { error: "Invalid task id" });
      return;
    }
    sendJson(res, 200, safeAudit(taskId, { max_items: 12 }));
  } catch (err) {
    sendJson(res, 200, { task_id: taskId, error: errorMessage(err) });
  }
}

export function handleTaskSafeTestSummary(res: ServerResponse, taskId: string): void {
  try {
    if (!isValidTaskId(taskId)) {
      sendJson(res, 400, { error: "Invalid task id" });
      return;
    }
    sendJson(res, 200, safeTestSummary(taskId));
  } catch (err) {
    sendJson(res, 200, { task_id: taskId, error: errorMessage(err) });
  }
}

export function handleTaskSafeDiffSummary(res: ServerResponse, taskId: string): void {
  try {
    if (!isValidTaskId(taskId)) {
      sendJson(res, 400, { error: "Invalid task id" });
      return;
    }
    sendJson(res, 200, safeDiffSummary(taskId, { max_items: 12 }));
  } catch (err) {
    sendJson(res, 200, { task_id: taskId, error: errorMessage(err) });
  }
}
