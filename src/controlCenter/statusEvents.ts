import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { errorMessage, fileMtimeIso, readJsonFileSafe } from "./helpers.js";
import { getControlCenterLogDir, MAX_EVENT_LINES } from "./constants.js";
import type { AgentAvailability } from "../tools/listAgents.js";
import type { WatcherStatusSnapshot } from "../watcherStatus.js";
import type { TaskEntry } from "../tools/listTasks.js";
import { type RuntimeHealth } from "./healthProbing.js";
import { type StatusTasks, type StaleClassification } from "./taskManagement.js";
import { PATCHWARDEN_VERSION, TOOL_SCHEMA_EPOCH } from "../version.js";

// ── Control Center status file + activity timeline ────────────────

export interface ControlCenterStatusFile {
  pid: number;
  port: number;
  started_at: string;
  url: string;
  version: string;
}

export function writeStatusFile(port: number, host: string, controlCenterStatusPath: string): void {
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
    console.error(`[control-center] Failed to write status file: ${errorMessage(err)}`);
  }
}

export function removeStatusFile(controlCenterStatusPath: string): void {
  try {
    if (existsSync(controlCenterStatusPath)) {
      unlinkSync(controlCenterStatusPath);
    }
  } catch (err) {
    console.error(`[control-center] Failed to remove status file: ${errorMessage(err)}`);
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
export function recordEvent(type: string, controlCenterEventsPath: string, payload?: Record<string, unknown>): void {
  const event: ControlCenterEvent = {
    timestamp: new Date().toISOString(),
    type,
    payload,
  };
  try {
    mkdirSync(getControlCenterLogDir(), { recursive: true });
    appendFileSync(controlCenterEventsPath, JSON.stringify(event) + "\n", "utf-8");
  } catch (err) {
    console.error(`[control-center] Failed to write event: ${errorMessage(err)}`);
  }
  // Lazy trim: only when the file grows well past the cap.
  try {
    const stat = statSync(controlCenterEventsPath);
    if (stat.size > 512 * 1024) {
      trimEventsFile(controlCenterEventsPath);
    }
  } catch {
    /* ignore */
  }
}

export function trimEventsFile(controlCenterEventsPath: string): void {
  try {
    if (!existsSync(controlCenterEventsPath)) return;
    const raw = readFileSync(controlCenterEventsPath, "utf-8");
    const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
    if (lines.length <= MAX_EVENT_LINES) return;
    const trimmed = lines.slice(lines.length - MAX_EVENT_LINES);
    writeFileSync(controlCenterEventsPath, trimmed.join("\n") + "\n", "utf-8");
  } catch (err) {
    console.error(`[control-center] Failed to trim events file: ${errorMessage(err)}`);
  }
}

export function readEvents(limit: number, controlCenterEventsPath: string): ControlCenterEvent[] {
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

// ── Health suggestions ────────────────────────────────────────────

export interface Suggestion {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  action?: string;
  link?: string;
}

export interface StatusSnapshotForSuggestions {
  core: RuntimeHealth;
  direct: RuntimeHealth;
  watcher: WatcherStatusSnapshot;
  tunnel: { core: Record<string, unknown>; direct: Record<string, unknown> };
  agents: AgentAvailability[];
  tasks: StatusTasks;
}

export function buildSuggestions(s: StatusSnapshotForSuggestions): Suggestion[] {
  const out: Suggestion[] = [];

  if (!s.core.available) {
    out.push({
      code: "core_stopped",
      severity: "warning",
      message: "Core 未运行，建议启动 Core profile",
      action: "/api/core/start",
    });
  }
  if (!s.direct.available) {
    out.push({
      code: "direct_stopped",
      severity: "warning",
      message: "Direct 未运行，建议启动 Direct profile",
      action: "/api/direct/start",
    });
  }

  if (s.watcher.status === "stale" || s.watcher.status === "unreadable") {
    out.push({
      code: "watcher_stale",
      severity: "error",
      message: "Watcher 处于 " + s.watcher.status + " 状态，建议 Restart All",
      action: "/api/restart-all",
    });
  }

  if (s.tasks.stale > 0) {
    out.push({
      code: "stale_task",
      severity: "warning",
      message: "存在 " + s.tasks.stale + " 个 stale 任务，建议查看并 reconcile",
      link: "/pages/tasks.html?filter=stale",
    });
  }

  const coreTunnelReady = !!(s.tunnel.core && s.tunnel.core.ready);
  const directTunnelReady = !!(s.tunnel.direct && s.tunnel.direct.ready);
  if (!coreTunnelReady || !directTunnelReady) {
    out.push({
      code: "tunnel_not_ready",
      severity: "warning",
      message: "Tunnel 未就绪，建议重启 profile 或检查代理",
      action: "/api/restart-all",
    });
  }

  const missingAgents = s.agents.filter((a) => !a.available);
  if (missingAgents.length > 0) {
    out.push({
      code: "agent_missing",
      severity: "info",
      message: "Agent 未就绪：" + missingAgents.map((a) => a.name).join(", ") + "（请检查 opencode/claude 路径）",
    });
  }

  return out;
}

// ── Observed state-change detection (drives activity timeline) ────

export interface StatusSnapshotDigest {
  core_available: boolean;
  direct_available: boolean;
  watcher_status: string;
  task_statuses: Record<string, string>;
}

export function buildStatusDigest(s: StatusSnapshotForSuggestions): StatusSnapshotDigest {
  const task_statuses: Record<string, string> = {};
  for (const t of s.tasks.tasks) {
    const entry = t as TaskEntry & StaleClassification;
    task_statuses[entry.task_id] = entry.status;
  }
  return {
    core_available: s.core.available,
    direct_available: s.direct.available,
    watcher_status: s.watcher.status,
    task_statuses,
  };
}

export function diffAndRecordEvents(prev: StatusSnapshotDigest, curr: StatusSnapshotDigest, controlCenterEventsPath: string): void {
  if (prev.core_available !== curr.core_available) {
    recordEvent("core.status_changed", controlCenterEventsPath, { from: prev.core_available, to: curr.core_available });
  }
  if (prev.direct_available !== curr.direct_available) {
    recordEvent("direct.status_changed", controlCenterEventsPath, { from: prev.direct_available, to: curr.direct_available });
  }
  if (prev.watcher_status !== curr.watcher_status) {
    recordEvent("watcher.status_changed", controlCenterEventsPath, { from: prev.watcher_status, to: curr.watcher_status });
  }
  for (const [taskId, newStatus] of Object.entries(curr.task_statuses)) {
    const oldStatus = prev.task_statuses[taskId];
    if (oldStatus && oldStatus !== newStatus) {
      recordEvent("task.status_changed", controlCenterEventsPath, { task_id: taskId, from: oldStatus, to: newStatus });
    }
  }
}

// ── Parse review verdict ─────────────────────────────────────────

export function parseReviewVerdict(content: string): string | null {
  // independent-review.md format: "**Verdict**: PASS" (case-insensitive)
  const m = content.match(/\*\*Verdict\*\*\s*:\s*([A-Za-z]+)/);
  return m ? m[1].toLowerCase() : null;
}

// ── Audit helper ──────────────────────────────────────────────────

export interface AuditEntry {
  source: string;
  task_id?: string;
  session_id?: string;
  verdict?: string | null;
  checked_at?: string | null;
  content_excerpt?: string;
  [key: string]: unknown;
}

export function collectAudits(
  tasksDir: string,
  sessionsDir: string,
  existsSyncFn: (path: string) => boolean,
  readdirSyncFn: (path: string, options: { withFileTypes: true }) => import("node:fs").Dirent[],
  readTextFileSafeFn: (path: string) => string | null,
  readJsonFileSafeFn: <T = unknown>(path: string) => T | null,
  fileMtimeIsoFn: (path: string) => string | null,
  parseReviewVerdictFn: (content: string) => string | null
): AuditEntry[] {
  const audits: AuditEntry[] = [];

  // 1. tasks/*/independent-review.md (written by audit_task — the primary audit artifact)
  // 2. tasks/*/audit.json (legacy/explicit JSON audit, if present)
  if (existsSyncFn(tasksDir)) {
    let taskEntries: import("node:fs").Dirent[] = [];
    try {
      taskEntries = readdirSyncFn(tasksDir, { withFileTypes: true }).filter((e) => e.isDirectory());
    } catch {
      taskEntries = [];
    }
    for (const entry of taskEntries) {
      const taskDir = join(tasksDir, entry.name);

      // independent-review.md
      const reviewFile = join(taskDir, "independent-review.md");
      if (existsSyncFn(reviewFile)) {
        const content = readTextFileSafeFn(reviewFile) ?? "";
        audits.push({
          task_id: entry.name,
          source: "independent-review.md",
          verdict: parseReviewVerdictFn(content),
          checked_at: fileMtimeIsoFn(reviewFile),
          content_excerpt: content.slice(0, 500),
        });
      }

      // audit.json (explicit JSON audit if present)
      const auditFile = join(taskDir, "audit.json");
      if (existsSyncFn(auditFile)) {
        const data = readJsonFileSafeFn<Record<string, unknown>>(auditFile);
        if (data) {
          audits.push({
            task_id: entry.name,
            source: "audit.json",
            checked_at: typeof data.checked_at === "string" ? data.checked_at : fileMtimeIsoFn(auditFile),
            ...data,
          });
        }
      }
    }
  }

  // 3. direct-sessions/*/audit.json (written by Direct audit_session)
  if (existsSyncFn(sessionsDir)) {
    let sessionEntries: import("node:fs").Dirent[] = [];
    try {
      sessionEntries = readdirSyncFn(sessionsDir, { withFileTypes: true }).filter((e) => e.isDirectory());
    } catch {
      sessionEntries = [];
    }
    for (const entry of sessionEntries) {
      const auditFile = join(sessionsDir, entry.name, "audit.json");
      if (!existsSyncFn(auditFile)) continue;
      const data = readJsonFileSafeFn<Record<string, unknown>>(auditFile);
      if (data) {
        audits.push({
          source: "direct-session",
          session_id: typeof data.session_id === "string" ? data.session_id : entry.name,
          checked_at: fileMtimeIsoFn(auditFile),
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

  return audits.slice(0, 50);
}