/**
 * Control Center routes — runtime status, events, diagnostics, tunnel URLs.
 *
 * `handleStatus` is the dashboard's primary poll endpoint: it fans out health
 * probes, watcher/task snapshots, and suggestion generation, and records
 * observed state-change events (core/direct/watcher/task transitions) into the
 * activity timeline. The remaining endpoints expose the control-center status
 * file, the event timeline, diagnostics (redacted), and tunnel UI URLs.
 */
import { existsSync } from "node:fs";
import { type ServerResponse } from "node:http";
import { type AgentAvailability } from "../../tools/listAgents.js";
import { type TaskEntry } from "../../tools/listTasks.js";
import { type WatcherStatusSnapshot } from "../../watcherStatus.js";
import { PATCHWARDEN_VERSION, TOOL_SCHEMA_EPOCH } from "../../version.js";
import { redactSensitiveValue } from "../../security/contentRedaction.js";
import {
  type ControlCenterStatusFile,
  type RuntimeHealth,
  type StaleClassification,
  type StatusTasks,
  listAgentsSafe,
  listTasksForStatus,
  probeRuntimeHealth,
  readEvents,
  recordEvent,
  readToolManifest,
  readTunnelStatus,
  readTunnelUrl,
  readWatcherStatusSafe,
  resolveWorkspaceRootSafe,
} from "../runtime.js";
import { findTunnelClientExecutable } from "./process.js";
import {
  config,
  configIdentitySha256,
  controlCenterStatusPath,
  CORE_BASE_URL,
  DIRECT_BASE_URL,
  errorMessage,
  readJsonFileSafe,
  sendJson,
} from "../shared.js";

// ── Health suggestions ────────────────────────────────────────────

interface Suggestion {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  action?: string;
  link?: string;
}

interface StatusSnapshotForSuggestions {
  core: RuntimeHealth;
  direct: RuntimeHealth;
  watcher: WatcherStatusSnapshot;
  tunnel: { core: Record<string, unknown>; direct: Record<string, unknown> };
  agents: AgentAvailability[];
  tasks: StatusTasks;
  direct_profile_enabled: boolean;
}

export function reconcileTunnelStatus(
  status: Record<string, unknown>,
  health: RuntimeHealth,
): Record<string, unknown> {
  if (!health.available) return status;
  return {
    ...status,
    observed: true,
    status: "running",
    ready: true,
    reason_code: "health_endpoint_ready",
    health_observed: true,
  };
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
  if (s.direct_profile_enabled && !s.direct.available) {
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
      message: "Watcher 处于 " + s.watcher.status + " 状态，建议重启 Core",
      action: "/api/core/restart",
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
  if (!coreTunnelReady || (s.direct_profile_enabled && !directTunnelReady)) {
    out.push({
      code: "tunnel_not_ready",
      severity: "warning",
      message: "Tunnel 未就绪，建议启动 profile 或检查代理",
      action: "/api/start-all",
    });
  }

  const missingAgents = s.agents.filter((a) => !a.available);
  if (missingAgents.length > 0) {
    out.push({
      code: "agent_missing",
      severity: "info",
      message: "Agent 未就绪：" + missingAgents.map((a) => a.name).join(", ") + "（请检查对应 CLI 安装与路径）",
    });
  }

  return out;
}

// ── Observed state-change detection (drives activity timeline) ────

interface StatusSnapshotDigest {
  core_available: boolean;
  direct_available: boolean;
  watcher_status: string;
  task_statuses: Record<string, string>;
}

let lastStatusDigest: StatusSnapshotDigest | null = null;

function buildStatusDigest(s: StatusSnapshotForSuggestions): StatusSnapshotDigest {
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

function diffAndRecordEvents(prev: StatusSnapshotDigest, curr: StatusSnapshotDigest): void {
  if (prev.core_available !== curr.core_available) {
    recordEvent("core.status_changed", { from: prev.core_available, to: curr.core_available });
  }
  if (prev.direct_available !== curr.direct_available) {
    recordEvent("direct.status_changed", { from: prev.direct_available, to: curr.direct_available });
  }
  if (prev.watcher_status !== curr.watcher_status) {
    recordEvent("watcher.status_changed", { from: prev.watcher_status, to: curr.watcher_status });
  }
  for (const [taskId, newStatus] of Object.entries(curr.task_statuses)) {
    const oldStatus = prev.task_statuses[taskId];
    if (oldStatus && oldStatus !== newStatus) {
      recordEvent("task.status_changed", { task_id: taskId, from: oldStatus, to: newStatus });
    }
  }
}

// ── Handlers ──────────────────────────────────────────────────────

export async function handleStatus(res: ServerResponse): Promise<void> {
  try {
    const [coreHealth, directHealth, watcher, tunnelCoreRaw, tunnelDirectRaw, toolsCore, toolsDirect, agents, workspaceRoot, tasks] = await Promise.all([
      probeRuntimeHealth(CORE_BASE_URL).catch((err): RuntimeHealth => ({
        available: false,
        reason: errorMessage(err),
        healthz: null,
        readyz: null,
      })),
      probeRuntimeHealth(DIRECT_BASE_URL).catch((err): RuntimeHealth => ({
        available: false,
        reason: errorMessage(err),
        healthz: null,
        readyz: null,
      })),
      Promise.resolve(readWatcherStatusSafe()),
      Promise.resolve(readTunnelStatus(false)),
      Promise.resolve(readTunnelStatus(true)),
      Promise.resolve(readToolManifest(false)),
      Promise.resolve(readToolManifest(true)),
      Promise.resolve(listAgentsSafe()),
      Promise.resolve(resolveWorkspaceRootSafe()),
      Promise.resolve(listTasksForStatus()),
    ]);
    const tunnelCore = reconcileTunnelStatus(tunnelCoreRaw, coreHealth);
    const tunnelDirect = reconcileTunnelStatus(tunnelDirectRaw, directHealth);
    const snapshotForSuggestions: StatusSnapshotForSuggestions = {
      core: coreHealth,
      direct: directHealth,
      watcher,
      tunnel: { core: tunnelCore, direct: tunnelDirect },
      agents,
      tasks,
      direct_profile_enabled: config.enableDirectProfile === true,
    };
    const suggestions = buildSuggestions(snapshotForSuggestions);
    const tunnelClientExe = findTunnelClientExecutable();

    // Diff against the previous poll to record observed state-change events.
    // This is the only place that observes Core/Direct/watcher/task transitions
    // (the control center is otherwise stateless and pull-driven).
    const digest = buildStatusDigest(snapshotForSuggestions);
    if (lastStatusDigest) {
      diffAndRecordEvents(lastStatusDigest, digest);
    }
    lastStatusDigest = digest;

    sendJson(res, 200, {
      core: coreHealth,
      direct: directHealth,
      watcher,
      tunnel: { core: tunnelCore, direct: tunnelDirect },
      tools: { core: toolsCore, direct: toolsDirect },
      agents,
      workspace_root: workspaceRoot,
      tasks,
      suggestions,
      direct_profile_enabled: config.enableDirectProfile === true,
      setup: {
        tunnel_client: {
          available: tunnelClientExe !== null,
          path: tunnelClientExe,
          source: config.tunnelClientPath && tunnelClientExe === config.tunnelClientPath ? "config" : "detected",
        },
        workspace_root: workspaceRoot,
        watcher: {
          status: watcher.status,
          available: watcher.available,
          reason: watcher.reason,
        },
      },
    });
  } catch (err) {
    sendJson(res, 200, { error: errorMessage(err), partial: true });
  }
}

export function handleControlCenterStatus(res: ServerResponse): void {
  // Public read of the status file (used by tray/launcher to confirm identity).
  if (!existsSync(controlCenterStatusPath)) {
    sendJson(res, 200, { running: false });
    return;
  }
  const data = readJsonFileSafe<ControlCenterStatusFile>(controlCenterStatusPath);
  if (!data) {
    sendJson(res, 200, { running: false });
    return;
  }
  sendJson(res, 200, { running: true, ...data });
}

export function handleEvents(res: ServerResponse, limit: number): void {
  const events = readEvents(limit);
  sendJson(res, 200, {
    events,
    total: events.length,
    limit,
  });
}

export function handleTunnelUiUrl(res: ServerResponse): void {
  sendJson(res, 200, {
    core: readTunnelUrl(false),
    direct: readTunnelUrl(true),
  });
}

export async function handleDiagnostics(res: ServerResponse): Promise<void> {
  try {
    const watcher = readWatcherStatusSafe();
    const [coreHealth, directHealth] = await Promise.all([
      probeRuntimeHealth(CORE_BASE_URL),
      probeRuntimeHealth(DIRECT_BASE_URL),
    ]);
    const tunnelCore = reconcileTunnelStatus(readTunnelStatus(false), coreHealth);
    const tunnelDirect = reconcileTunnelStatus(readTunnelStatus(true), directHealth);
    const toolsCore = readToolManifest(false);
    const toolsDirect = readToolManifest(true);
    const agents = listAgentsSafe();

    let workspaceRoot: string | null = null;
    try {
      workspaceRoot = resolveWorkspaceRootSafe();
    } catch {
      workspaceRoot = null;
    }

    // Recent failures: last 5 failed tasks (status contains "failed")
    let recentFailures: Array<{ task_id: string; status: string }> = [];
    try {
      const result = listTasksForStatus();
      recentFailures = (result.tasks as Array<{ task_id: string; status: string }>)
        .filter((t) => typeof t.status === "string" && t.status.includes("failed"))
        .slice(0, 5)
        .map((t) => ({ task_id: t.task_id, status: t.status }));
    } catch {
      recentFailures = [];
    }

    const coreReady = !!(tunnelCore && tunnelCore.ready);
    const directReady = !!(tunnelDirect && tunnelDirect.ready);

    const diagnostics = {
      server_version: PATCHWARDEN_VERSION,
      schema_epoch: TOOL_SCHEMA_EPOCH,
      tool_manifest_sha256: toolsCore.tool_manifest_sha256,
      watcher_status: watcher.status,
      tunnel_core_ready: coreReady,
      tunnel_direct_ready: directReady,
      core_tool_count: toolsCore.tool_count,
      direct_tool_count: toolsDirect.tool_count,
      agent_status: agents.map((a) => ({ name: a.name, available: a.available })),
      workspace_root: workspaceRoot,
      recent_failures: recentFailures,
      direct_profile_enabled: config.enableDirectProfile ?? false,
      config_identity_sha256: configIdentitySha256,
    };

    // Redact any sensitive content that may have leaked into string fields.
    const redacted = redactSensitiveValue(diagnostics);
    sendJson(res, 200, redacted.value);
  } catch (err) {
    sendJson(res, 200, { error: errorMessage(err) });
  }
}
