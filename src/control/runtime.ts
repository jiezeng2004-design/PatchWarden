/**
 * PatchWarden Control Center — runtime state readers and domain helpers.
 *
 * Provides health probing, runtime file readers (tunnel status, tool manifest,
 * watcher status), stale-task classification, the control-center status/event
 * timeline, hidden-id UI state, and small shared helpers (verdict parsing,
 * file mtime, id validation). These are pure helpers consumed by the route
 * modules; they hold no HTTP-layer concerns beyond reusing `sendJson`.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { get as httpGet } from "node:http";
import { listTasks, type TaskEntry } from "../tools/listTasks.js";
import { listAgents, type AgentAvailability } from "../tools/listAgents.js";
import { readWatcherStatus, type WatcherStatusSnapshot } from "../watcherStatus.js";
import { resolveWorkspaceRoot } from "../config.js";
import { PATCHWARDEN_VERSION } from "../version.js";
import { logger } from "../logging.js";
import {
  config,
  controlCenterEventsPath,
  controlCenterStatusPath,
  CORE_BASE_URL,
  DIRECT_BASE_URL,
  errorMessage,
  getControlCenterLogDir,
  getRuntimeRoot,
  host,
  MAX_EVENT_LINES,
  port,
  readJsonFileSafe,
} from "./shared.js";

// ── Health probing ────────────────────────────────────────────────

export interface HealthProbe {
  available: boolean;
  status: number | null;
  reason: string | null;
}

export function probeHealthStatus(targetUrl: string): Promise<HealthProbe> {
  return new Promise((resolve) => {
    const controller = new AbortController();
    let settled = false;
    const finish = (result: HealthProbe) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try { controller.abort(); } catch { /* ignore */ }
      finish({ available: false, status: null, reason: "timeout after 2000ms" });
    }, 2000);
    try {
      const req = httpGet(targetUrl, { signal: controller.signal }, (resp) => {
        resp.resume();
        const status = resp.statusCode ?? 0;
        // Only 2xx counts as available. A 404 from an unrelated service (or a
        // 4xx/5xx from the real service) must NOT be treated as healthy.
        if (status >= 200 && status < 300) {
          finish({ available: true, status, reason: null });
        } else {
          finish({ available: false, status, reason: `unexpected status ${status}` });
        }
      });
      req.on("error", (err) => {
        finish({ available: false, status: null, reason: err.message });
      });
    } catch (err) {
      finish({ available: false, status: null, reason: errorMessage(err) });
    }
  });
}

export interface RuntimeHealth {
  available: boolean;
  reason: string | null;
  healthz: { status: number } | null;
  readyz: { status: number } | null;
}

export async function probeRuntimeHealth(baseUrl: string): Promise<RuntimeHealth> {
  const [h, r] = await Promise.all([
    probeHealthStatus(`${baseUrl}/healthz`),
    probeHealthStatus(`${baseUrl}/readyz`),
  ]);
  if (h.available && r.available && h.status !== null && r.status !== null) {
    return { available: true, reason: null, healthz: { status: h.status }, readyz: { status: r.status } };
  }
  const failed = !h.available ? h : r;
  return { available: false, reason: failed.reason ?? "unavailable", healthz: null, readyz: null };
}

// ── Runtime file readers ──────────────────────────────────────────

export function readTunnelStatus(direct: boolean): Record<string, unknown> {
  const filePath = join(getRuntimeRoot(direct), "tunnel-status.json");
  if (!existsSync(filePath)) return { observed: false };
  try {
    const data = readJsonFileSafe<Record<string, unknown>>(filePath);
    if (data === null) return { observed: true, error: "invalid JSON" };
    return { observed: true, ...data };
  } catch (err) {
    return { observed: true, error: errorMessage(err) };
  }
}

export interface ToolManifestSummary {
  tool_profile: string | null;
  tool_count: number | null;
  schema_epoch: string | null;
  tool_manifest_sha256: string | null;
  tool_names: string[] | null;
}

export function readToolManifest(direct: boolean): ToolManifestSummary {
  const empty: ToolManifestSummary = {
    tool_profile: null,
    tool_count: null,
    schema_epoch: null,
    tool_manifest_sha256: null,
    tool_names: null,
  };
  const filePath = join(getRuntimeRoot(direct), "tool-manifest.json");
  if (!existsSync(filePath)) return empty;
  const data = readJsonFileSafe<Record<string, unknown>>(filePath);
  if (!data) return empty;
  return {
    tool_profile: typeof data.tool_profile === "string" ? data.tool_profile : null,
    tool_count: typeof data.tool_count === "number" ? data.tool_count : null,
    schema_epoch: typeof data.schema_epoch === "string" ? data.schema_epoch : null,
    tool_manifest_sha256: typeof data.tool_manifest_sha256 === "string" ? data.tool_manifest_sha256 : null,
    tool_names: Array.isArray(data.tool_names) ? (data.tool_names as string[]) : null,
  };
}

export function readTunnelUrl(direct: boolean): { url: string | null; reason: string | null } {
  const filePath = join(getRuntimeRoot(direct), "tunnel-health-url.txt");
  if (!existsSync(filePath)) return { url: null, reason: "tunnel-health-url.txt not found" };
  try {
    const content = readFileSync(filePath, "utf-8").trim();
    if (!content) return { url: null, reason: "tunnel-health-url.txt is empty" };
    return { url: content, reason: null };
  } catch (err) {
    return { url: null, reason: errorMessage(err) };
  }
}

// ── Safe wrappers around reusable modules ─────────────────────────

export function readWatcherStatusSafe(): WatcherStatusSnapshot {
  try {
    return readWatcherStatus(config);
  } catch (err) {
    return {
      status: "unreadable",
      available: false,
      stale_after_seconds: config.watcherStaleSeconds,
      last_heartbeat_at: null,
      heartbeat_age_seconds: null,
      heartbeat_pid: null,
      instance_id: null,
      launcher_pid: null,
      reason: errorMessage(err),
      activity: null,
    };
  }
}

export function listAgentsSafe(): AgentAvailability[] {
  try {
    return listAgents().agents;
  } catch {
    return [];
  }
}

export function resolveWorkspaceRootSafe(): string | null {
  try {
    return resolveWorkspaceRoot(config);
  } catch {
    return null;
  }
}

// ── Stale task classification ─────────────────────────────────────

export interface StatusTasks {
  tasks: unknown[];
  total: number;
  active: number;
  stale: number;
  stale_task_ids: string[];
  reason: string | null;
}

export interface StaleClassification {
  is_stale: boolean;
  stale_reasons: string[];
}

export const TERMINAL_TASK_STATUSES = new Set([
  "done",
  "done_by_agent",
  "failed",
  "failed_verification",
  "failed_scope_violation",
  "failed_policy_violation",
  "canceled",
  "timeout",
]);

/**
 * Classify a task as stale based on Phase 2 rules:
 *  - status=running but last_heartbeat_at exceeds threshold
 *  - phase=collecting_artifacts exceeds threshold
 *  - current_command=null AND watcher currently healthy
 *  - task last_heartbeat_at significantly earlier than current watcher heartbeat
 *
 * Only pending/running tasks can be stale; terminal tasks are never stale.
 */
export function classifyStaleTask(
  task: TaskEntry,
  watcher: WatcherStatusSnapshot,
  nowMs = Date.now()
): StaleClassification {
  const reasons: string[] = [];
  if (TERMINAL_TASK_STATUSES.has(task.status)) {
    return { is_stale: false, stale_reasons: reasons };
  }
  // Only pending/running are candidates for staleness.
  if (task.status !== "pending" && task.status !== "running") {
    return { is_stale: false, stale_reasons: reasons };
  }

  const staleThresholdMs = config.watcherStaleSeconds * 1000;
  const hbMs = Date.parse(task.last_heartbeat_at || "");
  const heartbeatAgeMs = Number.isFinite(hbMs) ? Math.max(0, nowMs - hbMs) : null;

  // Rule 1: running with stale heartbeat
  if (task.status === "running" && heartbeatAgeMs !== null && heartbeatAgeMs > staleThresholdMs) {
    reasons.push("heartbeat_stale");
  }

  // Rule 2: collecting_artifacts phase exceeds threshold
  if (task.phase === "collecting_artifacts" && heartbeatAgeMs !== null && heartbeatAgeMs > staleThresholdMs) {
    reasons.push("collecting_artifacts_stale");
  }

  // Rule 3: running with no current_command while watcher is healthy
  if (
    task.status === "running" &&
    (task.current_command === null || task.current_command === "") &&
    watcher.status === "healthy"
  ) {
    reasons.push("running_no_command_watcher_healthy");
  }

  // Rule 4: task heartbeat significantly earlier than watcher heartbeat
  if (heartbeatAgeMs !== null && watcher.last_heartbeat_at) {
    const watcherHbMs = Date.parse(watcher.last_heartbeat_at);
    if (Number.isFinite(watcherHbMs)) {
      const gapMs = watcherHbMs - hbMs;
      // Task heartbeat is "significantly earlier" than watcher heartbeat when
      // the task has not heartbeat for at least 2x the stale threshold while
      // the watcher is alive.
      if (gapMs > staleThresholdMs * 2 && watcher.status === "healthy") {
        reasons.push("heartbeat_far_behind_watcher");
      }
    }
  }

  return { is_stale: reasons.length > 0, stale_reasons: reasons };
}

export function augmentTaskWithStale(task: TaskEntry, watcher: WatcherStatusSnapshot, nowMs = Date.now()): TaskEntry & StaleClassification {
  const cls = classifyStaleTask(task, watcher, nowMs);
  return { ...task, is_stale: cls.is_stale, stale_reasons: cls.stale_reasons };
}

export function listTasksForStatus(): StatusTasks {
  try {
    const result = listTasks({ limit: 100 });
    const watcher = result.watcher;
    const now = Date.now();
    let active = 0;
    let stale = 0;
    const staleTaskIds: string[] = [];
    const augmented = result.tasks.map((t) => {
      const a = augmentTaskWithStale(t, watcher, now);
      if (t.status === "pending" || t.status === "running") active++;
      if (a.is_stale) {
        stale++;
        staleTaskIds.push(t.task_id);
      }
      return a;
    });
    return { tasks: augmented, total: result.total, active, stale, stale_task_ids: staleTaskIds, reason: null };
  } catch (err) {
    return { tasks: [], total: 0, active: 0, stale: 0, stale_task_ids: [], reason: errorMessage(err) };
  }
}

// ── Control Center status file + activity timeline ────────────────

export interface ControlCenterStatusFile {
  pid: number;
  port: number;
  started_at: string;
  url: string;
  version: string;
}

export function writeStatusFile(): void {
  const status: ControlCenterStatusFile = {
    pid: process.pid,
    port,
    started_at: new Date().toISOString(),
    url: `http://${host}:${port}/`,
    version: PATCHWARDEN_VERSION,
  };
  try {
    mkdirSync(getControlCenterLogDir(), { recursive: true });
    writeFileSync(controlCenterStatusPath, JSON.stringify(status, null, 2), "utf-8");
  } catch (err) {
    logger.error("[control-center] Failed to write status file", { error: errorMessage(err) });
  }
}

export function removeStatusFile(): void {
  try {
    if (existsSync(controlCenterStatusPath)) {
      unlinkSync(controlCenterStatusPath);
    }
  } catch (err) {
    logger.error("[control-center] Failed to remove status file", { error: errorMessage(err) });
  }
}

export interface ControlCenterEvent {
  timestamp: string;
  type: string;
  payload?: Record<string, unknown>;
}

/**
 * Append a single event line to the JSONL timeline. Best-effort: a write
 * failure is logged but never crashes the server. Trims the file to
 * MAX_EVENT_LINES lazily when it grows past 1.5x the cap, so we don't pay the
 * trim cost on every event.
 */
export function recordEvent(type: string, payload?: Record<string, unknown>): void {
  const event: ControlCenterEvent = {
    timestamp: new Date().toISOString(),
    type,
    payload,
  };
  try {
    mkdirSync(getControlCenterLogDir(), { recursive: true });
    appendFileSync(controlCenterEventsPath, JSON.stringify(event) + "\n", "utf-8");
  } catch (err) {
    logger.error("[control-center] Failed to write event", { error: errorMessage(err) });
  }
  // Lazy trim: only when the file grows well past the cap.
  try {
    const stat = statSync(controlCenterEventsPath);
    if (stat.size > 512 * 1024) {
      trimEventsFile();
    }
  } catch {
    /* ignore */
  }
}

function trimEventsFile(): void {
  try {
    if (!existsSync(controlCenterEventsPath)) return;
    const raw = readFileSync(controlCenterEventsPath, "utf-8");
    const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
    if (lines.length <= MAX_EVENT_LINES) return;
    const trimmed = lines.slice(lines.length - MAX_EVENT_LINES);
    writeFileSync(controlCenterEventsPath, trimmed.join("\n") + "\n", "utf-8");
  } catch (err) {
    logger.error("[control-center] Failed to trim events file", { error: errorMessage(err) });
  }
}

export function readEvents(limit: number): ControlCenterEvent[] {
  if (!existsSync(controlCenterEventsPath)) return [];
  try {
    const raw = readFileSync(controlCenterEventsPath, "utf-8");
    const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
    const sliced = lines.slice(Math.max(0, lines.length - limit));
    const events: ControlCenterEvent[] = [];
    for (const line of sliced) {
      try {
        events.push(JSON.parse(line) as ControlCenterEvent);
      } catch {
        /* skip malformed line */
      }
    }
    return events;
  } catch {
    return [];
  }
}

// ── Hidden stale task IDs (local UI state) ────────────────────────

export function readHiddenStaleIds(): string[] {
  const p = join(getControlCenterLogDir(), "hidden-stale-ids.json");
  if (!existsSync(p)) return [];
  return readJsonFileSafe<string[]>(p) || [];
}

export function writeHiddenStaleIds(ids: string[]): void {
  const dir = getControlCenterLogDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "hidden-stale-ids.json"), JSON.stringify(ids, null, 2));
}

// ── Hidden direct session IDs (local UI state) ────────────────────

export function readHiddenDirectSessionIds(): string[] {
  const p = join(getControlCenterLogDir(), "hidden-direct-session-ids.json");
  if (!existsSync(p)) return [];
  return readJsonFileSafe<string[]>(p) || [];
}

export function writeHiddenDirectSessionIds(ids: string[]): void {
  const dir = getControlCenterLogDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "hidden-direct-session-ids.json"), JSON.stringify(ids, null, 2));
}

export function isValidDirectSessionId(sessionId: string): boolean {
  // Allow alphanumeric, dash, underscore only — reject path traversal and NUL.
  return (
    sessionId.length > 0 &&
    /^[A-Za-z0-9_-]+$/.test(sessionId) &&
    !sessionId.includes("\0")
  );
}

export function isValidTaskId(taskId: string): boolean {
  return !(
    taskId === "." ||
    taskId === ".." ||
    taskId.includes("/") ||
    taskId.includes("\\") ||
    taskId.includes("\0")
  );
}

// ── Small shared helpers ──────────────────────────────────────────

export function parseReviewVerdict(content: string): string | null {
  // independent-review.md format: "**Verdict**: PASS" (case-insensitive)
  const m = content.match(/\*\*Verdict\*\*\s*:\s*([A-Za-z]+)/);
  return m ? m[1].toLowerCase() : null;
}

export function fileMtimeIso(filePath: string): string | null {
  try {
    const m = statSync(filePath).mtime;
    return m ? m.toISOString() : null;
  } catch {
    return null;
  }
}
