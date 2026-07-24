import {
  existsSync,
  readdirSync,
  readFileSync,
  mkdirSync,
  statSync,
  type Dirent,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { getTasksDir, getConfig, type PatchWardenConfig } from "../../config.js";
import { diagnoseTask, type DiagnosisType, type DiagnosisConfidence, type SafeAction } from "./diagnoseTask.js";
import { syncSubgoalOnTaskDone, readTaskGoalMeta } from "../../goal/subgoalSync.js";
import { mutateTaskStatus } from "../../runner/taskStatusStore.js";
import { writeTaskRuntime } from "../../runner/taskRuntime.js";
import type { TaskPhase } from "./createTask.js";
import { atomicWriteFileSync, atomicWriteJsonFileSync } from "../../utils/atomicFile.js";
import { appendBoundedTextFileSync } from "../../utils/boundedFile.js";
import { isActiveTaskStatus } from "./taskStates.js";

// ── v0.7.0: reconcile_tasks types ──────────────────────────────────

export type ReconcileMode = "report_only" | "safe_fix";

export interface ReconcileTasksInput {
  max_age_minutes?: number;
  mode?: ReconcileMode;
  include_done_candidates?: boolean;
  task_ids?: string[];
}

export interface ReconcileTaskReport {
  task_id: string;
  status: string;
  phase: string | null;
  diagnosis: DiagnosisType;
  confidence: DiagnosisConfidence;
  reasons: string[];
  safe_actions: SafeAction[];
  age_seconds: number | null;
  action_taken: "left_unchanged" | "marked_failed_stale" | "marked_orphaned" | "marked_done_by_agent" | "marked_canceled" | "marked_timed_out";
  previous_status: string | null;
  new_status: string | null;
  applied_at: string | null;
  applied_by: string | null;
  evidence_summary: {
    heartbeat_age_seconds: number | null;
    stdout_age_seconds: number | null;
    child_pid: number | null;
    child_pid_alive: boolean | null;
    watcher_owns_task: boolean;
  };
}

export interface ReconcileTasksOutput {
  mode: ReconcileMode;
  scanned: number;
  candidates: number;
  reconciled: number;
  skipped_low_confidence: number;
  skipped_active_watcher: number;
  reports: ReconcileTaskReport[];
  reconcile_log_path: string | null;
}

// ── Defaults ────────────────────────────────────────────────────────

const DEFAULT_MAX_AGE_MINUTES = 30;
const RECONCILE_LOG_NAME = "reconcile.log";

// ── Main entry point ──────────────────────────────────────────────

export function reconcileTasks(
  input: ReconcileTasksInput = {},
  config: PatchWardenConfig = getConfig()
): ReconcileTasksOutput {
  const mode: ReconcileMode = input.mode === "safe_fix" ? "safe_fix" : "report_only";
  const maxAgeMinutes =
    typeof input.max_age_minutes === "number" && input.max_age_minutes > 0
      ? Math.min(input.max_age_minutes, 24 * 60)
      : DEFAULT_MAX_AGE_MINUTES;
  const includeDoneCandidates = input.include_done_candidates !== false; // default true
  const requestedTaskIds = input.task_ids?.length
    ? new Set(input.task_ids.filter((taskId) => /^task[-_][a-zA-Z0-9_-]+$/.test(taskId)))
    : null;
  const maxAgeSeconds = maxAgeMinutes * 60;

  const tasksDir = getTasksDir(config);
  const reports: ReconcileTaskReport[] = [];
  let scanned = 0;
  let candidates = 0;
  let reconciled = 0;
  let skippedLowConfidence = 0;
  let skippedActiveWatcher = 0;
  const nowMs = Date.now();

  if (!existsSync(tasksDir)) {
    return {
      mode,
      scanned: 0,
      candidates: 0,
      reconciled: 0,
      skipped_low_confidence: 0,
      skipped_active_watcher: 0,
      reports: [],
      reconcile_log_path: null,
    };
  }

  let entries: Dirent[] = [];
  try {
    entries = readdirSync(tasksDir, { withFileTypes: true });
  } catch {
    return {
      mode,
      scanned: 0,
      candidates: 0,
      reconciled: 0,
      skipped_low_confidence: 0,
      skipped_active_watcher: 0,
      reports: [],
      reconcile_log_path: null,
    };
  }

  const taskDirs = entries.filter((e) => e.isDirectory());

  for (const entry of taskDirs) {
    const taskId = entry.name;
    if (requestedTaskIds && !requestedTaskIds.has(taskId)) continue;
    scanned += 1;
    const taskDir = resolve(tasksDir, taskId);
    const statusFile = join(taskDir, "status.json");
    if (!existsSync(statusFile)) continue;

    let statusData: Record<string, unknown>;
    try {
      statusData = JSON.parse(readFileSync(statusFile, "utf-8"));
    } catch {
      continue; // corrupted status, skip
    }

    const statusStr = typeof statusData.status === "string" ? statusData.status : "unknown";

    // Scan every persisted non-terminal lifecycle spelling, including legacy
    // phase-as-status records left by older Watchers.
    const isCandidate =
      isActiveTaskStatus(statusStr) ||
      (includeDoneCandidates && statusStr === "done_by_agent");
    if (!isCandidate) continue;

    // Use the oldest reliable timestamp for ordinary stale detection. Explicit
    // cancel, persisted deadline, and Watcher-instance mismatch bypass this
    // age gate so a restart cannot extend the task's total budget.
    const ageSeconds = taskAgeSeconds(taskDir, statusData, nowMs);

    // Diagnose the task
    let diagnosis;
    try {
      diagnosis = diagnoseTask({ task_id: taskId }, config);
    } catch {
      continue; // diagnosis failed — skip
    }
    const cancellationRequested = statusData.cancel_requested === true || statusStr === "cancel_requested";
    const deadlineExceeded = taskDeadlineExceeded(statusData, nowMs);
    const urgentRecovery = cancellationRequested
      || deadlineExceeded
      || diagnosis.diagnosis === "orphaned_running";
    if (ageSeconds !== null && ageSeconds < maxAgeSeconds && !urgentRecovery) continue;

    candidates += 1;

    const report: ReconcileTaskReport = {
      task_id: taskId,
      status: diagnosis.status,
      phase: diagnosis.phase,
      diagnosis: diagnosis.diagnosis,
      confidence: diagnosis.confidence,
      reasons: diagnosis.reasons,
      safe_actions: diagnosis.safe_actions,
      age_seconds: ageSeconds,
      action_taken: "left_unchanged",
      previous_status: null,
      new_status: null,
      applied_at: null,
      applied_by: null,
      evidence_summary: {
        heartbeat_age_seconds: diagnosis.evidence.heartbeat_age_seconds,
        stdout_age_seconds: diagnosis.evidence.stdout_age_seconds,
        child_pid: diagnosis.evidence.child_pid,
        child_pid_alive: diagnosis.evidence.child_pid_alive,
        watcher_owns_task: diagnosis.evidence.watcher_owns_task,
      },
    };

    // ── safe_fix rules ──
    //
    // safe_fix is ONLY applied when:
    //   1. mode === "safe_fix"
    //   2. diagnosis.confidence === "high"
    //   3. The task is NOT still owned by an active watcher (we must not
    //      touch tasks the live watcher is executing).
    //   4. The diagnosis type maps to a reconcilable action.
    //
    // Anything else is left_unchanged and recorded for audit.

    const deterministicRecovery = !diagnosis.evidence.watcher_owns_task
      && (cancellationRequested || deadlineExceeded);
    if (mode === "safe_fix" && (diagnosis.confidence === "high" || deterministicRecovery)) {
      if (diagnosis.evidence.watcher_owns_task) {
        // Hard rule: do not touch tasks the live watcher still owns.
        skippedActiveWatcher += 1;
        report.reasons = [
          ...report.reasons,
          "safe_fix skipped: task is still owned by an active watcher instance",
        ];
      } else {
        const fixResult = applySafeFix(taskDir, taskId, statusData, diagnosis.diagnosis, diagnosis.reasons, diagnosis.evidence, config);
        if (fixResult.applied) {
          report.action_taken = fixResult.action_taken;
          report.previous_status = fixResult.previous_status;
          report.new_status = fixResult.new_status;
          report.applied_at = fixResult.applied_at;
          report.applied_by = "reconcile_tasks";
          reconciled += 1;
        } else {
          report.reasons = [
            ...report.reasons,
            `safe_fix skipped: ${fixResult.skip_reason || "task state could not be updated safely"}`,
          ];
          skippedLowConfidence += 1;
        }
      }
    } else if (mode === "safe_fix" && diagnosis.confidence !== "high") {
      skippedLowConfidence += 1;
      report.reasons = [
        ...report.reasons,
        `safe_fix skipped: confidence is "${diagnosis.confidence}", only "high" is eligible`,
      ];
    }

    if (reports.length < 200) {
      reports.push(report);
    }
    if (reports.length >= 200) break;
  }

  // ── Write reconcile.log when safe_fix applied any change ──
  let reconcileLogPath: string | null = null;
  if (mode === "safe_fix" && reconciled > 0) {
    reconcileLogPath = writeReconcileLog(tasksDir, config, reports.filter((r) => r.action_taken !== "left_unchanged"));
  }

  return {
    mode,
    scanned,
    candidates,
    reconciled,
    skipped_low_confidence: skippedLowConfidence,
    skipped_active_watcher: skippedActiveWatcher,
    reports,
    reconcile_log_path: reconcileLogPath,
  };
}

// ── safe_fix application ──────────────────────────────────────────

interface SafeFixResult {
  applied: boolean;
  action_taken: ReconcileTaskReport["action_taken"];
  previous_status: string;
  new_status: string;
  applied_at: string;
  skip_reason: string | null;
}

type SafeFixMutationOutcome =
  | { applied: true }
  | { applied: false; reason: string };

function applySafeFix(
  taskDir: string,
  taskId: string,
  currentStatus: Record<string, unknown>,
  diagnosis: DiagnosisType,
  reasons: string[],
  evidence: {
    heartbeat_age_seconds: number | null;
    stdout_age_seconds: number | null;
    child_pid: number | null;
    child_pid_alive: boolean | null;
    watcher_owns_task: boolean;
    watcher_instance_id: string | null;
    current_watcher_instance_id: string | null;
  },
  config: PatchWardenConfig
): SafeFixResult {
  // Map diagnosis type to new status. Only high-confidence, well-understood
  // diagnoses are eligible. "possibly_stale_running" and "unknown" are NOT
  // eligible even if confidence were high (which they never are).
  const previousStatus = typeof currentStatus.status === "string" ? currentStatus.status : "unknown";
  let newStatus: string | null = null;
  let actionTaken: ReconcileTaskReport["action_taken"] = "left_unchanged";

  const cancellationRequested = currentStatus.cancel_requested === true || previousStatus === "cancel_requested";
  if (!evidence.watcher_owns_task && cancellationRequested) {
    newStatus = "canceled";
    actionTaken = "marked_canceled";
  } else if (!evidence.watcher_owns_task && taskDeadlineExceeded(currentStatus)) {
    newStatus = "timeout";
    actionTaken = "marked_timed_out";
  } else switch (diagnosis) {
    case "stale_running":
      newStatus = "failed_stale";
      actionTaken = "marked_failed_stale";
      break;
    case "orphaned_running":
      newStatus = "orphaned";
      actionTaken = "marked_orphaned";
      break;
    case "done_candidate":
      newStatus = "done_by_agent";
      actionTaken = "marked_done_by_agent";
      break;
    case "artifact_collection_stuck":
      // Treat as failed_stale — artifact collection should not hang.
      newStatus = "failed_stale";
      actionTaken = "marked_failed_stale";
      break;
    default:
      // active_running, possibly_stale_running, unknown, terminal — not eligible
      return {
        applied: false,
        action_taken: "left_unchanged",
        previous_status: previousStatus,
        new_status: previousStatus,
        applied_at: new Date().toISOString(),
        skip_reason: `diagnosis "${diagnosis}" has no automatic safe_fix action`,
      };
  }

  const appliedAt = new Date().toISOString();
  const statusFile = join(taskDir, "status.json");
  const backupFile = join(taskDir, "status.json.bak");

  // Revalidate and update under the shared task status lock. Any heartbeat or
  // ownership-related status change after diagnosis makes this repair stale.
  try {
    const outcome = mutateTaskStatus<SafeFixMutationOutcome>(statusFile, (current) => {
      if (JSON.stringify(current) !== JSON.stringify(currentStatus)) {
        return { result: { applied: false as const, reason: "task status changed after diagnosis" } };
      }

      const lockedPreviousStatus = typeof current.status === "string" ? current.status : "unknown";
      const next: Record<string, unknown> = {
        ...current,
        status: newStatus,
        phase: newStatus,
        updated_at: appliedAt,
        last_heartbeat_at: appliedAt,
        finished_at: appliedAt,
        previous_status: lockedPreviousStatus,
        diagnosis: {
          type: diagnosis,
          confidence: "high" as DiagnosisConfidence,
          applied_by: "reconcile_tasks",
          applied_at: appliedAt,
          reasons,
          evidence: {
            heartbeat_age_seconds: evidence.heartbeat_age_seconds,
            stdout_age_seconds: evidence.stdout_age_seconds,
            child_pid: evidence.child_pid,
            child_pid_alive: evidence.child_pid_alive,
            watcher_instance_id: evidence.watcher_instance_id,
            current_watcher_instance_id: evidence.current_watcher_instance_id,
          },
        },
        process_cleanup_required: !evidence.watcher_owns_task,
        process_cleanup_reason: !evidence.watcher_owns_task
          ? "The previous runner is no longer owned by this Watcher; child-process termination could not be confirmed and no untrusted PID was killed."
          : null,
      };

      if (newStatus === "canceled") {
        next.canceled_at = appliedAt;
        next.cancel_reason = "Cancellation converged after the original task runner stopped responding.";
        next.termination_reason = "canceled";
        next.error_code = "runner_lost_during_cancel";
      } else if (actionTaken === "marked_timed_out") {
        next.error = `Task exceeded its configured timeout of ${Number(current.timeout_seconds)} seconds after the original runner stopped responding.`;
        next.termination_reason = "timeout";
        next.error_code = "task_timeout";
      } else if (diagnosis === "artifact_collection_stuck") {
        next.error = "Artifact collection was interrupted and could not be safely resumed after the original runner stopped responding.";
        next.error_code = "artifact_collection_interrupted";
      } else if (diagnosis === "orphaned_running") {
        next.error = "The original task runner was lost and its child process ownership could not be re-established.";
        next.error_code = "agent_lost";
      } else if (diagnosis === "stale_running") {
        next.error = "The task runner heartbeat expired and no current Runner ownership could be proven.";
        next.error_code = "agent_lost";
      }

      if (newStatus === "done_by_agent") {
        next.acceptance_status = "pending";
        next.legacy_status = "done";
      }

      // The backup is created while the same lock protects the exact record
      // being replaced, so it cannot capture an unrelated newer state.
      if (!existsSync(backupFile)) atomicWriteFileSync(backupFile, readFileSync(statusFile, "utf-8"));
      return {
        next,
        result: { applied: true as const },
      };
    });
    if (!outcome.applied) {
      return {
        applied: false,
        action_taken: "left_unchanged",
        previous_status: previousStatus,
        new_status: previousStatus,
        applied_at: appliedAt,
        skip_reason: outcome.reason,
      };
    }
  } catch {
    return {
      applied: false,
      action_taken: "left_unchanged",
      previous_status: previousStatus,
      new_status: previousStatus,
      applied_at: appliedAt,
      skip_reason: "task status could not be locked, backed up, and updated",
    };
  }

  if (newStatus !== "done_by_agent") {
    writeRecoveryArtifacts(taskDir, taskId, currentStatus, newStatus, actionTaken, appliedAt);
  }

  // Keep the persisted runtime view terminal as well. get_task_status merges
  // runtime.json over status.json, so leaving an old executing phase here
  // would make a successfully reconciled task appear active again.
  writeTaskRuntime(taskDir, {
    phase: newStatus as TaskPhase,
    current_command: null,
    last_heartbeat_at: appliedAt,
    child_pid: undefined,
    child_started_at: undefined,
    child_owned_by_runner_instance_id: undefined,
  });

  // v0.8.0: 当状态变为 done_by_agent 时，同步关联 subgoal 状态（running → done_by_agent）
  if (newStatus === "done_by_agent") {
    const goalMeta = readTaskGoalMeta(taskDir);
    if (goalMeta.subgoal_id) {
      syncSubgoalOnTaskDone(taskId, goalMeta, config.workspaceRoot);
    }
  }

  return {
    applied: true,
    action_taken: actionTaken,
    previous_status: previousStatus,
    new_status: newStatus,
    applied_at: appliedAt,
    skip_reason: null,
  };
}

function writeRecoveryArtifacts(
  taskDir: string,
  taskId: string,
  status: Record<string, unknown>,
  newStatus: string,
  actionTaken: ReconcileTaskReport["action_taken"],
  recoveredAt: string,
): void {
  const timeoutSeconds = Number(status.timeout_seconds);
  const summary = actionTaken === "marked_timed_out"
    ? `Task exceeded its configured timeout of ${timeoutSeconds} seconds after the original runner stopped responding.`
    : actionTaken === "marked_canceled"
      ? "Cancellation converged after the original task runner stopped responding."
      : `Task was reconciled to ${newStatus} after the original runner stopped responding.`;
  const errorCode = actionTaken === "marked_timed_out"
    ? "task_timeout"
    : actionTaken === "marked_canceled"
      ? "runner_lost_during_cancel"
      : newStatus === "orphaned"
        ? "agent_lost"
        : newStatus === "failed_stale" && String(status.phase || status.status) === "collecting_artifacts"
          ? "artifact_collection_interrupted"
          : "agent_lost";
  const requestedCommands = Array.isArray(status.verify_commands)
    ? status.verify_commands.map(String)
    : [];
  const artifacts = {
    "verify.json": {
      status: "failed",
      requested_commands: requestedCommands,
      commands: [],
      failure_reason: "runner_recovery",
      error_code: errorCode,
    },
    "result.json": {
      task_id: taskId,
      status: newStatus,
      agent: status.agent || "",
      repo_path: status.repo_path || "",
      resolved_repo_path: status.resolved_repo_path || "",
      summary,
      artifact_status: "partial",
      changed_files: [],
      diff_available: false,
      verify_status: "failed",
      failure_reason: "runner_recovery",
      error_code: errorCode,
      termination_reason: actionTaken === "marked_timed_out"
        ? "timeout"
        : actionTaken === "marked_canceled"
          ? "canceled"
          : "runner_stale",
      recovered_at: recoveredAt,
      warnings: ["The original runner stopped before complete change and verification evidence could be collected."],
    },
  };
  for (const [name, value] of Object.entries(artifacts)) {
    const path = join(taskDir, name);
    if (!existsSync(path)) atomicWriteJsonFileSync(path, value);
  }
  const textArtifacts: Record<string, string> = {
    "result.md": `# PatchWarden Task Result\n\n## Status\n${newStatus}\n\n## Summary\n${summary}\n\n## Artifact Status\npartial\n`,
    "test.log": `(not run)\nExit code: not run\n${summary}\n`,
    "git.diff": `(unavailable: ${summary})\n`,
    "diff.patch": `(unavailable: ${summary})\n`,
  };
  for (const [name, content] of Object.entries(textArtifacts)) {
    const path = join(taskDir, name);
    if (!existsSync(path)) atomicWriteFileSync(path, content);
  }
}

function taskDeadlineExceeded(status: Record<string, unknown>, nowMs = Date.now()): boolean {
  const timeoutSeconds = Number(status.timeout_seconds);
  const startedAt = typeof status.started_at === "string"
    ? Date.parse(status.started_at)
    : typeof status.created_at === "string"
      ? Date.parse(status.created_at)
      : NaN;
  return Number.isFinite(startedAt)
    && Number.isFinite(timeoutSeconds)
    && timeoutSeconds > 0
    && nowMs >= startedAt + timeoutSeconds * 1000;
}

// ── reconcile.log writer ───────────────────────────────────────────

function writeReconcileLog(
  tasksDir: string,
  config: PatchWardenConfig,
  appliedReports: ReconcileTaskReport[]
): string {
  // The reconcile.log lives at the .patchwarden/ root (parent of tasksDir),
  // so it captures every reconcile run across all tasks.
  const logDir = dirname(tasksDir);
  const logPath = join(logDir, RECONCILE_LOG_NAME);
  try {
    mkdirSync(logDir, { recursive: true });
  } catch { /* ignore */ }

  const lines: string[] = [];
  for (const report of appliedReports) {
    lines.push(JSON.stringify({
      timestamp: report.applied_at,
      task_id: report.task_id,
      previous_status: report.previous_status,
      new_status: report.new_status,
      diagnosis: report.diagnosis,
      confidence: report.confidence,
      applied_by: report.applied_by,
      reasons: report.reasons,
      evidence: report.evidence_summary,
    }));
  }
  try {
    appendBoundedTextFileSync(logPath, lines.join("\n") + "\n");
  } catch {
    // If we cannot write the log, the status change still happened —
    // the status.json itself contains the diagnosis audit fields.
  }
  return logPath;
}

// ── Task age helper ────────────────────────────────────────────────

function taskAgeSeconds(
  taskDir: string,
  status: Record<string, unknown>,
  nowMs: number
): number | null {
  // Prefer created_at; fall back to status.json mtime.
  const createdStr = typeof status.created_at === "string" ? status.created_at : null;
  if (createdStr) {
    const ms = Date.parse(createdStr);
    if (Number.isFinite(ms)) {
      return Math.max(0, Math.round((nowMs - ms) / 1000));
    }
  }
  try {
    const stat = statSync(join(taskDir, "status.json"));
    return Math.max(0, Math.round((nowMs - stat.mtimeMs) / 1000));
  } catch {
    return null;
  }
}
