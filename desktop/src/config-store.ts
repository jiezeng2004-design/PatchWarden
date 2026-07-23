import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { AGENT_ADAPTERS, buildAgentRegistration, getAgentAdapter, validateModelId } from "./agent-adapters.js";
import type { AgentAdapter, AgentDetectionInput, AgentRegistration } from "./agent-adapters.js";

/** Desktop UI preferences persisted to disk. */
export interface DesktopPreferences {
  readonly theme: "system" | "light" | "dark";
  readonly closeBehavior: "tray" | "quit";
  readonly language: "system" | "zh-CN" | "en";
  readonly connectionMode: "chatgpt" | "local";
}

/** Proxy endpoint configuration for the MCP tunnel. */
export interface ProxyEndpoint {
  readonly mode: "environment" | "none" | "manual";
  readonly url?: string;
}

/** Tunnel proxy settings, optionally split between core and direct profiles. */
export interface TunnelProxyConfig {
  readonly scope: "shared" | "separate";
  readonly core: ProxyEndpoint;
  readonly direct: ProxyEndpoint;
}

/** Runtime settings managed by the desktop app. */
export interface RuntimeSettings {
  readonly tunnelClientPath: string | null;
  readonly enableDirectProfile: boolean;
  readonly tunnelProxy: TunnelProxyConfig;
}

/** PatchWarden desktop paths resolved from the environment. */
export interface DesktopPaths {
  readonly root: string;
  readonly config: string;
  readonly preferences: string;
  readonly logs: string;
  readonly credential: string;
  readonly tunnelSetupStatus: string;
}

/** Agent selection submitted by the renderer. */
export interface AgentSelection {
  readonly id: string;
  readonly enabled?: boolean;
  readonly model?: string | null;
}

/** Agent settings read from the PatchWarden config. */
export interface AgentSetting {
  readonly id: string;
  readonly adapter: string | null;
  readonly managed: boolean;
  readonly enabled: boolean;
  readonly model: string | null;
}

/** Top-level PatchWarden config schema (subset used by desktop). */
export interface PatchwardenConfig {
  workspaceRoot?: string;
  agents?: Record<string, AgentRegistration>;
  tunnelClientPath?: string;
  enableDirectProfile?: boolean;
  tunnelProxy?: { scope?: string; core?: unknown; direct?: unknown };
  [key: string]: unknown;
}

export const DEFAULT_PREFERENCES: Readonly<DesktopPreferences> = Object.freeze({ theme: "system", closeBehavior: "tray", language: "system", connectionMode: "chatgpt" });
export const DEFAULT_RUNTIME_SETTINGS: Readonly<RuntimeSettings> = Object.freeze({
  tunnelClientPath: null,
  enableDirectProfile: false,
  tunnelProxy: {
    scope: "shared",
    core: { mode: "environment" },
    direct: { mode: "environment" },
  },
} as RuntimeSettings);
const ALLOWED_THEMES = new Set(["system", "light", "dark"]);
const ALLOWED_CLOSE_BEHAVIORS = new Set(["tray", "quit"]);
const ALLOWED_LANGUAGES = new Set(["system", "zh-CN", "en"]);
const ALLOWED_CONNECTION_MODES = new Set(["chatgpt", "local"]);
const TRANSIENT_WINDOWS_RENAME_ERRORS = new Set(["EACCES", "EBUSY", "EPERM"]);
const RENAME_RETRY_DEADLINE_MS = 1_000;
const RENAME_RETRY_DELAY_MS = 10;
const RENAME_WAIT_ARRAY = new Int32Array(new SharedArrayBuffer(4));

export function resolveDesktopLanguage(preference: string | undefined, systemLocale: string): "zh-CN" | "en" {
  if (preference === "zh-CN" || preference === "en") return preference;
  return /^zh(?:-|$)/i.test(systemLocale || "") ? "zh-CN" : "en";
}

export function resolveDesktopPaths(env: NodeJS.ProcessEnv, userDataPath: string): DesktopPaths {
  const localRoot = env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "PatchWarden") : userDataPath;
  return {
    root: localRoot,
    config: env.PATCHWARDEN_CONFIG ? resolve(env.PATCHWARDEN_CONFIG) : join(localRoot, "patchwarden.config.json"),
    preferences: join(localRoot, "desktop-preferences.json"),
    logs: env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "patchwarden", "control-center") : join(userDataPath, "control-center"),
    credential: env.APPDATA ? join(env.APPDATA, "patchwarden", "control-plane-api-key.dpapi") : join(localRoot, "control-plane-api-key.dpapi"),
    tunnelSetupStatus: join(localRoot, "tunnel-setup-status.json"),
  };
}

export function readJson(path: string): unknown {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

export function readPreferences(path: string): DesktopPreferences {
  const raw = asRecord(readJson(path));
  return {
    theme: typeof raw.theme === "string" && ALLOWED_THEMES.has(raw.theme)
      ? raw.theme as DesktopPreferences["theme"]
      : DEFAULT_PREFERENCES.theme,
    closeBehavior: typeof raw.closeBehavior === "string" && ALLOWED_CLOSE_BEHAVIORS.has(raw.closeBehavior)
      ? raw.closeBehavior as DesktopPreferences["closeBehavior"]
      : DEFAULT_PREFERENCES.closeBehavior,
    language: typeof raw.language === "string" && ALLOWED_LANGUAGES.has(raw.language)
      ? raw.language as DesktopPreferences["language"]
      : DEFAULT_PREFERENCES.language,
    connectionMode: typeof raw.connectionMode === "string" && ALLOWED_CONNECTION_MODES.has(raw.connectionMode)
      ? raw.connectionMode as DesktopPreferences["connectionMode"]
      : DEFAULT_PREFERENCES.connectionMode,
  };
}

export function updatePreferences(path: string, patch: unknown): DesktopPreferences {
  const current = readPreferences(path);
  const input = asRecord(patch);
  const next: DesktopPreferences = {
    theme: typeof input.theme === "string" && ALLOWED_THEMES.has(input.theme)
      ? input.theme as DesktopPreferences["theme"]
      : current.theme,
    closeBehavior: typeof input.closeBehavior === "string" && ALLOWED_CLOSE_BEHAVIORS.has(input.closeBehavior)
      ? input.closeBehavior as DesktopPreferences["closeBehavior"]
      : current.closeBehavior,
    language: typeof input.language === "string" && ALLOWED_LANGUAGES.has(input.language)
      ? input.language as DesktopPreferences["language"]
      : current.language,
    connectionMode: typeof input.connectionMode === "string" && ALLOWED_CONNECTION_MODES.has(input.connectionMode)
      ? input.connectionMode as DesktopPreferences["connectionMode"]
      : current.connectionMode,
  };
  atomicWriteJson(path, next, false);
  return next;
}

export function buildConfig(workspaceRoot: string, detectedAgents: readonly AgentDetectionInput[], selections: readonly AgentSelection[] = []): PatchwardenConfig {
  const agents: Record<string, AgentRegistration> = {};
  const selectedById = new Map(selections.map((selection) => [selection.id, selection]));
  for (const agent of detectedAgents) {
    const id = agent.id || agent.name;
    if (!id) continue;
    const normalizedAgent: AgentDetectionInput = { ...agent, command: agent.command || agent.executablePath, prefixArgs: agent.prefixArgs || [] };
    if (!getAgentAdapter(id) || !normalizedAgent.available || !normalizedAgent.command) continue;
    const selection = selectedById.get(id);
    if (selection && selection.enabled === false) continue;
    agents[id] = buildAgentRegistration(id, normalizedAgent, selection?.model);
  }
  return {
    workspaceRoot,
    plansDir: ".patchwarden/plans",
    tasksDir: ".patchwarden/tasks",
    assessmentsDir: ".patchwarden/assessments",
    agents,
    allowedTestCommands: [
      "npm test", "npm run test", "npm run lint", "npm run format:check", "npm run build",
      "pnpm test", "pnpm run test", "pnpm run lint", "pnpm run build", "pytest", "cargo test"
    ],
    maxReadFileBytes: 200000,
    defaultTaskTimeoutSeconds: 900,
    maxTaskTimeoutSeconds: 3600,
    watcherStaleSeconds: 30,
    toolProfile: "full",
    enableDirectProfile: false,
    tunnelProxy: {
      scope: "shared",
      core: { mode: "environment" },
      direct: { mode: "environment" }
    }
  };
}

export function readAgentSettings(configPath: string): AgentSetting[] {
  const config = asRecord(readJson(configPath));
  const configured = asRecord(config.agents);
  return Object.entries(configured).map(([id, value]) => {
    const agent = asRecord(value);
    const adapter = typeof agent.adapter === "string" ? agent.adapter : "";
    const adapterId = getAgentAdapter(adapter) ? adapter : getAgentAdapter(id) ? id : null;
    const args = Array.isArray(agent.args)
      ? agent.args.filter((arg): arg is string => typeof arg === "string")
      : [];
    const modelArg = args.findIndex((arg) => arg === "--model" || arg === "-m");
    const inferredModel = modelArg >= 0 ? args[modelArg + 1] : null;
    return {
      id,
      adapter: adapterId,
      managed: Boolean(adapterId),
      enabled: true,
      model: typeof agent.model === "string" ? agent.model : inferredModel || null,
    };
  });
}

export function updateAgentSettings(configPath: string, detections: readonly AgentDetectionInput[], selections: readonly AgentSelection[]): AgentSetting[] {
  const config = asPatchwardenConfig(readJson(configPath));
  if (!config || typeof config.workspaceRoot !== "string") throw new Error("PatchWarden 配置尚未完成");
  if (!Array.isArray(selections)) throw new Error("Agent 设置数据无效");
  const detectionById = new Map(detections.map((agent) => [agent.id || agent.name || "", agent]));
  const nextAgents: Record<string, AgentRegistration> = { ...(config.agents || {}) };
  for (const adapter of AGENT_ADAPTERS as readonly AgentAdapter[]) {
    const selection = selections.find((item) => item && item.id === adapter.id);
    if (!selection) continue;
    if (selection.enabled === false) {
      delete nextAgents[adapter.id];
      continue;
    }
    validateModelId(selection.model);
    const detection = detectionById.get(adapter.id);
    if ((!detection?.available || !detection.command) && nextAgents[adapter.id]) {
      continue;
    }
    const previousEnvAllowlist = nextAgents[adapter.id]?.envAllowlist;
    nextAgents[adapter.id] = {
      ...buildAgentRegistration(adapter.id, detection, selection.model),
      ...(Array.isArray(previousEnvAllowlist) ? { envAllowlist: [...previousEnvAllowlist] } : {}),
    };
  }
  const updated = { ...config, agents: nextAgents };
  atomicWriteJson(configPath, updated, true);
  return readAgentSettings(configPath);
}

function normalizeProxyEndpoint(value: unknown): ProxyEndpoint {
  const endpoint = asRecord(value);
  const mode: ProxyEndpoint["mode"] = typeof endpoint.mode === "string" && ["environment", "none", "manual"].includes(endpoint.mode)
    ? endpoint.mode as ProxyEndpoint["mode"]
    : "environment";
  if (mode !== "manual") return { mode };
  const url = typeof endpoint.url === "string" ? endpoint.url.trim() : "";
  if (!url) throw new Error("手动代理需要填写 URL");
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error("代理 URL 格式无效"); }
  if (!["http:", "https:", "socks5:"].includes(parsed.protocol)) throw new Error("代理仅支持 http、https 或 socks5");
  if (parsed.username || parsed.password) throw new Error("代理 URL 不能包含用户名或密码");
  return { mode, url: parsed.toString().replace(/\/$/, "") };
}

export function readRuntimeSettings(configPath: string): RuntimeSettings {
  const config = asRecord(readJson(configPath));
  const proxy = asRecord(config.tunnelProxy);
  return {
    tunnelClientPath: typeof config.tunnelClientPath === "string" ? config.tunnelClientPath : null,
    enableDirectProfile: config.enableDirectProfile === true,
    tunnelProxy: {
      scope: proxy.scope === "separate" ? "separate" : "shared",
      core: normalizeProxyEndpoint(proxy.core),
      direct: normalizeProxyEndpoint(proxy.direct),
    },
  };
}

export function updateRuntimeSettings(configPath: string, patch: unknown): RuntimeSettings {
  const config = asPatchwardenConfig(readJson(configPath));
  if (!config || typeof config.workspaceRoot !== "string") throw new Error("PatchWarden 配置尚未完成");
  const current = readRuntimeSettings(configPath);
  const input = asRecord(patch);
  const tunnelClientPath = Object.hasOwn(input, "tunnelClientPath")
    ? (typeof input.tunnelClientPath === "string" ? input.tunnelClientPath : null)
    : current.tunnelClientPath;
  const tunnelProxy = isRecord(input.tunnelProxy) ? input.tunnelProxy : null;
  const next: RuntimeSettings = {
    tunnelClientPath: tunnelClientPath || null,
    enableDirectProfile: typeof input.enableDirectProfile === "boolean" ? input.enableDirectProfile : current.enableDirectProfile,
    tunnelProxy: tunnelProxy ? {
      scope: tunnelProxy.scope === "separate" ? "separate" : "shared",
      core: normalizeProxyEndpoint(tunnelProxy.core),
      direct: normalizeProxyEndpoint(tunnelProxy.direct),
    } : current.tunnelProxy,
  };
  const updated: PatchwardenConfig = { ...config, enableDirectProfile: next.enableDirectProfile, tunnelProxy: next.tunnelProxy };
  if (next.tunnelClientPath) updated.tunnelClientPath = next.tunnelClientPath;
  else delete updated.tunnelClientPath;
  atomicWriteJson(configPath, updated, true);
  return next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function asPatchwardenConfig(value: unknown): PatchwardenConfig | null {
  return isRecord(value) ? value as PatchwardenConfig : null;
}

export function atomicWriteJson(path: string, value: unknown, backup: boolean = true): void {
  mkdirSync(dirname(path), { recursive: true });
  if (backup && existsSync(path)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    copyFileSync(path, `${path}.bak-${stamp}`);
  }
  const temp = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    replaceFile(temp, path);
  } catch (error) {
    try { rmSync(temp, { force: true }); } catch { /* best-effort cleanup */ }
    throw error;
  }
}

function replaceFile(temp: string, path: string): void {
  const deadline = Date.now() + RENAME_RETRY_DEADLINE_MS;
  while (true) {
    try {
      renameSync(temp, path);
      return;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? String((error as NodeJS.ErrnoException).code || "")
        : "";
      if (
        process.platform !== "win32"
        || !TRANSIENT_WINDOWS_RENAME_ERRORS.has(code)
        || Date.now() >= deadline
      ) {
        throw error;
      }
      Atomics.wait(RENAME_WAIT_ARRAY, 0, 0, RENAME_RETRY_DELAY_MS);
    }
  }
}
