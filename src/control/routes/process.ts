/**
 * Control Center routes — process lifecycle proxy (/api/start-all,
 * /api/stop-all, /api/restart-all, /api/core/*, /api/direct/*).
 *
 * Proxies start/stop/restart actions to scripts/control/manage-patchwarden.ps1
 * and exposes open-logs-folder. Start/restart actions run a preflight that
 * verifies the tunnel-client executable and launcher files exist before
 * launching, so the non-interactive web UI never deadlocks on a missing
 * dependency. All endpoints are POST routes gated by the control token.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { delimiter, extname, join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { type ServerResponse } from "node:http";
import {
  buildChildEnvironment,
  redactProcessOutput,
  resolveTrustedExecutable,
  sanitizeTrustedPath,
} from "../../runner/processSecurity.js";
import { recordEvent } from "../runtime.js";
import { launchFileManager } from "../fileManager.js";
import {
  config,
  CORE_BASE_URL,
  DIRECT_BASE_URL,
  errorMessage,
  getRuntimeRoot,
  manageScriptPath,
  projectRoot,
  sendJson,
} from "../shared.js";

type ControlMode = "core" | "direct";

interface ManageResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const MAX_MANAGE_OUTPUT_CHARS = 128 * 1024;
const MANAGE_ALLOWED_ENVIRONMENT = [
  "PATCHWARDEN_CONFIG",
  "PATCHWARDEN_TUNNEL_ID",
  "PATCHWARDEN_CREDENTIAL_PATH",
  "PATCHWARDEN_TUNNEL_CLIENT_EXE",
  "TUNNEL_CLIENT_EXE",
  "OPENCODE_BIN_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
] as const;

function runManageAction(action: string, mode: string): Promise<ManageResult> {
  return new Promise((resolveP, rejectP) => {
    let child;
    let exactValues: string[] = [];
    try {
      const env = buildManageEnvironment();
      exactValues = manageSensitiveValues(env);
      const command = resolveTrustedExecutable("powershell.exe", projectRoot, { pathValue: env.PATH });
      child = spawn(
        command,
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", manageScriptPath, action, mode, "-Background"],
        { cwd: projectRoot, windowsHide: true, env }
      );
    } catch (err) {
      rejectP(err);
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* ignore */ }
      rejectP(new Error(`manage-patchwarden.ps1 timed out after 60s (action=${action}, mode=${mode})`));
    }, 60_000);
    child.stdout.on("data", (d: Buffer) => {
      stdout = appendBoundedManageOutput(stdout, d.toString("utf-8"));
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr = appendBoundedManageOutput(stderr, d.toString("utf-8"));
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectP(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveP({
        exitCode: code ?? -1,
        stdout: redactProcessOutput(stdout, exactValues),
        stderr: redactProcessOutput(stderr, exactValues),
      });
    });
  });
}

export function resolveManageProfiles(mode: string, action: string, directEnabled: boolean): { selected: ControlMode[]; skipped: ControlMode[] } {
  if (mode === "core" || mode === "direct") return { selected: [mode], skipped: [] };
  if ((action === "start" || action === "restart") && !directEnabled) return { selected: ["core"], skipped: ["direct"] };
  return { selected: ["core", "direct"], skipped: [] };
}

function selectedControlModes(mode: string, action = "status"): ControlMode[] {
  return resolveManageProfiles(mode, action, config.enableDirectProfile === true).selected;
}

function skippedControlModes(mode: string, action: string): ControlMode[] {
  return resolveManageProfiles(mode, action, config.enableDirectProfile === true).skipped;
}

function effectiveManageMode(modes: ControlMode[]): string {
  return modes.length === 1 ? modes[0] : "all";
}

function launcherPathForMode(mode: ControlMode): string {
  const launcherName = mode === "direct" ? "Start-PatchWarden-Direct-Tunnel.cmd" : "Start-PatchWarden-Tunnel.cmd";
  return join(projectRoot, "scripts", "launchers", launcherName);
}

function findExecutableOnPath(fileName: string): string | null {
  const pathValue = sanitizeTrustedPath(process.env.PATH || "", projectRoot);
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
      : [""];
  for (const entry of pathValue.split(delimiter)) {
    if (!entry) continue;
    const direct = join(entry, fileName);
    if (isRegularFile(direct)) return direct;
    if (process.platform === "win32" && !extname(fileName)) {
      for (const ext of extensions) {
        const candidate = join(entry, fileName + ext.toLowerCase());
        if (isRegularFile(candidate)) return candidate;
      }
    }
  }
  return null;
}

function findTunnelClientExecutable(): string | null {
  if (process.env.PATCHWARDEN_CONTROL_FORCE_MISSING_TUNNEL_CLIENT === "1") return null;
  const configured = config.tunnelClientPath;
  if (configured && isRegularFile(configured)) return configured;
  const explicit = process.env.PATCHWARDEN_TUNNEL_CLIENT_EXE || process.env.TUNNEL_CLIENT_EXE;
  if (explicit && isRegularFile(explicit)) return explicit;
  const fromPath = findExecutableOnPath("tunnel-client.exe") ?? findExecutableOnPath("tunnel-client");
  if (fromPath) return fromPath;

  const candidates = [
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "PatchWarden", "tunnel-client.exe") : null,
    process.env.APPDATA ? join(process.env.APPDATA, "tunnel-client", "tunnel-client.exe") : null,
    join(homedir(), "tunnel-client", "tunnel-client.exe"),
  ].filter((v): v is string => typeof v === "string" && v.length > 0);
  for (const candidate of candidates) {
    if (isRegularFile(candidate)) return candidate;
  }
  return null;
}

export function buildManageEnvironment(): NodeJS.ProcessEnv {
  const agentEnvironmentNames = [...new Set(Object.values(config.agents)
    .flatMap((agent) => agent.envAllowlist ?? []))];
  const env = buildChildEnvironment({
    cwd: projectRoot,
    allowedNames: [...MANAGE_ALLOWED_ENVIRONMENT, ...agentEnvironmentNames],
    blockedNames: [config.http?.ownerTokenEnv || "PATCHWARDEN_OWNER_TOKEN"],
  });
  const lifecycleNames = new Set(MANAGE_ALLOWED_ENVIRONMENT.map((name) => name.toUpperCase()));
  const providerOnlyNames = agentEnvironmentNames.filter(
    (name) => !lifecycleNames.has(name.toUpperCase()),
  );
  env.PATCHWARDEN_AGENT_ENV_ALLOWLIST = providerOnlyNames.join(";");
  const tunnelClient = findTunnelClientExecutable();
  if (tunnelClient) {
    env.PATCHWARDEN_TUNNEL_CLIENT_EXE = tunnelClient;
    env.TUNNEL_CLIENT_EXE = tunnelClient;
  }
  const proxy = config.tunnelProxy;
  const core = proxy?.core || { mode: "environment" as const };
  const direct = proxy?.scope === "separate" ? proxy.direct : core;
  env.PATCHWARDEN_TUNNEL_PROXY_MODE = core.mode;
  env.PATCHWARDEN_TUNNEL_PROXY_URL = core.mode === "manual" ? core.url || "" : "";
  env.PATCHWARDEN_DIRECT_PROXY_MODE = direct.mode;
  env.PATCHWARDEN_DIRECT_PROXY_URL = direct.mode === "manual" ? direct.url || "" : "";
  return env;
}

// Re-exported so the status route can surface tunnel-client availability in
// /api/status without duplicating the discovery logic.
export { findTunnelClientExecutable };

function profilePathForMode(mode: ControlMode): string | null {
  if (!process.env.APPDATA) return null;
  return join(process.env.APPDATA, "tunnel-client", mode === "direct" ? "patchwarden-direct.yaml" : "patchwarden.yaml");
}

function credentialPath(): string | null {
  return process.env.APPDATA ? join(process.env.APPDATA, "patchwarden", "control-plane-api-key.dpapi") : null;
}

function preflightManageAction(action: string, mode: string): { status: number; body: Record<string, unknown> } | null {
  if (action !== "start" && action !== "restart") return null;

  const selectedModes = selectedControlModes(mode, action);
  const missingLaunchers = selectedModes
    .map((m) => ({ mode: m, path: launcherPathForMode(m) }))
    .filter((entry) => !existsSync(entry.path));
  const tunnelClient = findTunnelClientExecutable();
  const missingProfiles = selectedModes
    .map((m) => ({ mode: m, path: profilePathForMode(m) }))
    .filter((entry) => !entry.path || !existsSync(entry.path));
  const savedCredential = credentialPath();
  const missing: string[] = [];
  if (!tunnelClient) missing.push("tunnel-client.exe");
  for (const entry of missingLaunchers) missing.push(`${entry.mode} launcher`);
  for (const entry of missingProfiles) missing.push(`${entry.mode} profile`);
  if (!savedCredential || !existsSync(savedCredential)) missing.push("tunnel runtime credential");

  if (missing.length === 0) return null;

  const reasonCode = !tunnelClient
    ? "tunnel_client_missing"
    : missingLaunchers.length > 0
      ? "launcher_missing"
      : missingProfiles.length > 0
        ? "tunnel_profile_missing"
        : "tunnel_credential_missing";

  return {
    status: 409,
    body: {
      ok: false,
      action,
      mode,
      reason_code: reasonCode,
      error:
        "Control Center preflight failed. Start/restart from the Web UI is non-interactive, so required runtime dependencies must be available before launching.",
      missing,
      next_steps: [
        "在桌面设置中自动检测或选择 tunnel-client.exe，也可设置 PATCHWARDEN_TUNNEL_CLIENT_EXE。",
        "在桌面设置中配置 Tunnel ID 和专用 runtime API key，并完成 doctor 验证。",
        "确认 scripts/launchers 下的启动器存在，然后重试。",
      ],
    },
  };
}

function preflightDirectProfile(action: string, mode: string): { status: number; body: Record<string, unknown> } | null {
  if ((action !== "start" && action !== "restart") || mode !== "direct") return null;
  if (config.enableDirectProfile === true) return null;
  return {
    status: 409,
    body: {
      ok: false,
      action,
      mode,
      reason_code: "direct_profile_disabled",
      error: "Direct profile 尚未启用。请先在桌面设置中启用 Direct，再启动对应隧道。",
      next_steps: ["打开 设置 -> MCP 与隧道", "启用 Direct profile 并保存", "重新启动 Direct"],
    },
  };
}

function readRuntimeState(mode: ControlMode, fileName: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(join(getRuntimeRoot(mode === "direct"), fileName), "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

function readRuntimeLog(mode: ControlMode, fileName: string): string {
  try {
    const value = readFileSync(join(getRuntimeRoot(mode === "direct"), fileName), "utf8");
    return value.length > 64_000 ? value.slice(-64_000) : value;
  } catch {
    return "";
  }
}

export function classifySupervisorFailure(diagnosticText: string): string {
  if (/unsupported_country_region_territory|unsupported.{0,30}(country|region|territory)/i.test(diagnosticText)) return "unsupported_region";
  if (/\b(401|403)\b|unauthori[sz]ed|invalid.{0,30}(api.?key|credential)|api.?key.{0,30}(invalid|missing)/i.test(diagnosticText)) return "auth_failed";
  if (/proxy|ECONNREFUSED|ENETUNREACH|ETIMEDOUT|could not resolve|name resolution|connection (failed|refused)/i.test(diagnosticText)) return "proxy_unreachable";
  if (/tool manifest preflight|tool_manifest_(check_failed|invalid)|mcp-manifest-check/i.test(diagnosticText)) return "tool_manifest_check_failed";
  if (/spawn EPERM|access (is )?denied|permission denied/i.test(diagnosticText)) return "supervisor_permission_denied";
  if (/watcher.{0,40}(failed|unhealthy|missing|exited)/i.test(diagnosticText)) return "watcher_unhealthy";
  if (/profile.{0,30}(missing|invalid)|config.{0,30}(missing|invalid)|launcher.{0,30}(missing|not found)/i.test(diagnosticText)) return "config_error";
  return "supervisor_exited";
}

function processIsAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function inspectSupervisor(mode: ControlMode, startedAt: number): { terminal: boolean; reasonCode: string | null } {
  const state = readRuntimeState(mode, "supervisor-status.json");
  const checkedAt = typeof state?.checked_at === "string" ? Date.parse(state.checked_at) : 0;
  const fresh = Number.isFinite(checkedAt) && checkedAt >= startedAt - 2000;
  if (!fresh) return { terminal: false, reasonCode: null };
  const explicitlyFailed = state?.status === "failed";
  if (!explicitlyFailed && processIsAlive(state?.pid)) return { terminal: false, reasonCode: null };
  const diagnostics = `${readRuntimeLog(mode, "supervisor.stderr.log")}\n${readRuntimeLog(mode, "supervisor.stdout.log")}`;
  const recordedReason = typeof state?.reason_code === "string" ? state.reason_code : null;
  return { terminal: true, reasonCode: recordedReason || classifySupervisorFailure(diagnostics) };
}

async function probeReady(baseUrl: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(`${baseUrl}/readyz`, { signal: controller.signal, cache: "no-store" });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function inspectStartup(mode: ControlMode, startedAt: number): Promise<Record<string, unknown>> {
  const tunnel = readRuntimeState(mode, "tunnel-status.json");
  const checkedAt = typeof tunnel?.checked_at === "string" ? Date.parse(tunnel.checked_at) : 0;
  const fresh = Number.isFinite(checkedAt) && checkedAt >= startedAt - 2000;
  const endpointReady = await probeReady(mode === "direct" ? DIRECT_BASE_URL : CORE_BASE_URL);
  const watcher = mode === "core" ? readRuntimeState(mode, "watcher-status.json") : null;
  const watcherReady = mode === "direct" || watcher?.status === "healthy";
  const ready = endpointReady && tunnel?.ready !== false && watcherReady;
  const terminalStatuses = new Set(["failed", "error", "stopped", "restart_limit_reached"]);
  const tunnelTerminal = fresh && terminalStatuses.has(String(tunnel?.status || "")) && tunnel?.reason_code !== "stopped_by_manager";
  const supervisor = inspectSupervisor(mode, startedAt);
  const terminal = tunnelTerminal || supervisor.terminal;
  const reasonCode = tunnelTerminal
    ? (typeof tunnel?.reason_code === "string" ? tunnel.reason_code : "startup_failed")
    : supervisor.reasonCode;
  return {
    mode,
    ready,
    endpoint_ready: endpointReady,
    watcher_ready: watcherReady,
    status: tunnel?.status || "starting",
    reason_code: reasonCode,
    error: tunnel?.last_error || null,
    terminal,
  };
}

async function waitForStartup(modes: ControlMode[], startedAt: number): Promise<{ ok: boolean; profiles: Record<string, unknown>[]; reasonCode?: string }> {
  const configured = Number(process.env.PATCHWARDEN_CONTROL_START_TIMEOUT_MS || "30000");
  const timeoutMs = Number.isFinite(configured) ? Math.min(Math.max(configured, 1000), 120000) : 30000;
  const deadline = Date.now() + timeoutMs;
  let profiles: Record<string, unknown>[] = [];
  while (Date.now() < deadline) {
    profiles = await Promise.all(modes.map((mode) => inspectStartup(mode, startedAt)));
    if (profiles.every((profile) => profile.ready === true)) return { ok: true, profiles };
    const failed = profiles.find((profile) => profile.terminal === true);
    if (failed) {
      const reasonCode = typeof failed.reason_code === "string" ? failed.reason_code : "supervisor_exited";
      return { ok: false, profiles, reasonCode };
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  profiles = await Promise.all(modes.map((mode) => inspectStartup(mode, startedAt)));
  return { ok: false, profiles, reasonCode: "startup_timeout" };
}

export async function handleManageAction(res: ServerResponse, action: string, mode: string): Promise<void> {
  try {
    const directPreflight = preflightDirectProfile(action, mode);
    if (directPreflight) {
      recordEvent("manage." + mode + "." + action + ".profile_disabled", { reason_code: "direct_profile_disabled" });
      sendJson(res, directPreflight.status, directPreflight.body);
      return;
    }
    const selectedModes = selectedControlModes(mode, action);
    const skippedModes = skippedControlModes(mode, action);
    const managedMode = effectiveManageMode(selectedModes);
    const preflight = preflightManageAction(action, mode);
    if (preflight) {
      recordEvent("manage." + mode + "." + action + ".preflight_failed", {
        missing: preflight.body.missing,
      });
      sendJson(res, preflight.status, {
        ...preflight.body,
        started_profiles: [],
        skipped_profiles: skippedModes,
      });
      return;
    }
    const startedAt = Date.now();
    const result = await runManageAction(action, managedMode);
    if (result.exitCode !== 0) {
      recordEvent("manage." + mode + "." + action, { exit_code: result.exitCode, ok: false });
      sendJson(res, 500, {
        ok: false,
        action,
        mode,
        started_profiles: [],
        skipped_profiles: skippedModes,
        reason_code: "manager_failed",
        error: result.stderr.trim() || result.stdout.trim() || `manage-patchwarden.ps1 exited with code ${result.exitCode}`,
      });
      return;
    }
    if (action === "start" || action === "restart") {
      const startup = await waitForStartup(selectedModes, startedAt);
      if (!startup.ok) {
        const timeout = startup.reasonCode === "startup_timeout";
        recordEvent("manage." + mode + "." + action + ".not_ready", { reason_code: startup.reasonCode, profiles: startup.profiles });
        sendJson(res, timeout ? 504 : 502, {
          ok: false,
          action,
          mode,
          started_profiles: selectedModes,
          skipped_profiles: skippedModes,
          reason_code: startup.reasonCode,
          error: timeout
            ? "启动命令已执行，但服务未在等待时间内通过就绪检查。"
            : "隧道 supervisor 在服务就绪前退出。",
          profiles: startup.profiles,
          next_steps: ["检查设置中的 tunnel-client 与代理", "运行健康检查", "查看本次 Core / Direct 日志"],
        });
        return;
      }
    }
    recordEvent("manage." + mode + "." + action, {
      exit_code: result.exitCode,
      ok: result.exitCode === 0,
    });
    sendJson(res, 200, {
      ok: result.exitCode === 0,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      verified: action === "start" || action === "restart",
      started_profiles: action === "start" || action === "restart" ? selectedModes : [],
      skipped_profiles: skippedModes,
      reason_code: skippedModes.length > 0 ? "direct_profile_disabled" : null,
    });
  } catch (err) {
    recordEvent("manage." + mode + "." + action + ".failed", { error: errorMessage(err) });
    sendJson(res, 500, { error: errorMessage(err) });
  }
}

export function handleOpenLogsFolder(res: ServerResponse): void {
  try {
    const target = getRuntimeRoot(false);
    launchFileManager(target, projectRoot);
    sendJson(res, 200, { ok: true, path: target });
  } catch (err) {
    sendJson(res, 500, { error: errorMessage(err) });
  }
}

function appendBoundedManageOutput(current: string, next: string): string {
  if (current.length >= MAX_MANAGE_OUTPUT_CHARS) return current;
  return current + next.slice(0, MAX_MANAGE_OUTPUT_CHARS - current.length);
}

function manageSensitiveValues(env: NodeJS.ProcessEnv): string[] {
  const agentEnvironmentValues = Object.values(config.agents)
    .flatMap((agent) => agent.envAllowlist ?? [])
    .map((name) => findEnvironmentValue(env, name));
  const values = [
    env.HTTP_PROXY,
    env.HTTPS_PROXY,
    env.ALL_PROXY,
    env.PATCHWARDEN_TUNNEL_PROXY_URL,
    env.PATCHWARDEN_DIRECT_PROXY_URL,
    ...agentEnvironmentValues,
  ].filter((value): value is string => typeof value === "string" && Buffer.byteLength(value, "utf-8") >= 8);
  return [...new Set(values)].sort((left, right) => right.length - left.length);
}

function findEnvironmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (process.platform !== "win32") return env[name];
  const match = Object.keys(env).find((key) => key.toUpperCase() === name.toUpperCase());
  return match ? env[match] : undefined;
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
