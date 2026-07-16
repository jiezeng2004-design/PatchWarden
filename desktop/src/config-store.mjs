import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { AGENT_ADAPTERS, buildAgentRegistration, getAgentAdapter, validateModelId } from "./agent-adapters.mjs";

export const DEFAULT_PREFERENCES = Object.freeze({ theme: "system", closeBehavior: "tray", language: "system", connectionMode: "chatgpt" });
export const DEFAULT_RUNTIME_SETTINGS = Object.freeze({
  tunnelClientPath: null,
  enableDirectProfile: false,
  tunnelProxy: {
    scope: "shared",
    core: { mode: "environment" },
    direct: { mode: "environment" },
  },
});
const ALLOWED_THEMES = new Set(["system", "light", "dark"]);
const ALLOWED_CLOSE_BEHAVIORS = new Set(["tray", "quit"]);
const ALLOWED_LANGUAGES = new Set(["system", "zh-CN", "en"]);
const ALLOWED_CONNECTION_MODES = new Set(["chatgpt", "local"]);

export function resolveDesktopLanguage(preference, systemLocale) {
  if (preference === "zh-CN" || preference === "en") return preference;
  return /^zh(?:-|$)/i.test(systemLocale || "") ? "zh-CN" : "en";
}

export function resolveDesktopPaths(env, userDataPath) {
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

export function readJson(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

export function readPreferences(path) {
  const raw = readJson(path) || {};
  return {
    theme: ALLOWED_THEMES.has(raw.theme) ? raw.theme : DEFAULT_PREFERENCES.theme,
    closeBehavior: ALLOWED_CLOSE_BEHAVIORS.has(raw.closeBehavior) ? raw.closeBehavior : DEFAULT_PREFERENCES.closeBehavior,
    language: ALLOWED_LANGUAGES.has(raw.language) ? raw.language : DEFAULT_PREFERENCES.language,
    connectionMode: ALLOWED_CONNECTION_MODES.has(raw.connectionMode) ? raw.connectionMode : DEFAULT_PREFERENCES.connectionMode,
  };
}

export function updatePreferences(path, patch) {
  const current = readPreferences(path);
  const next = {
    theme: patch && ALLOWED_THEMES.has(patch.theme) ? patch.theme : current.theme,
    closeBehavior: patch && ALLOWED_CLOSE_BEHAVIORS.has(patch.closeBehavior) ? patch.closeBehavior : current.closeBehavior,
    language: patch && ALLOWED_LANGUAGES.has(patch.language) ? patch.language : current.language,
    connectionMode: patch && ALLOWED_CONNECTION_MODES.has(patch.connectionMode) ? patch.connectionMode : current.connectionMode,
  };
  atomicWriteJson(path, next, false);
  return next;
}

export function buildConfig(workspaceRoot, detectedAgents, selections = []) {
  const agents = {};
  const selectedById = new Map(selections.map((selection) => [selection.id, selection]));
  for (const agent of detectedAgents) {
    const id = agent.id || agent.name;
    const normalizedAgent = { ...agent, command: agent.command || agent.executablePath, prefixArgs: agent.prefixArgs || [] };
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

export function readAgentSettings(configPath) {
  const config = readJson(configPath) || {};
  const configured = config.agents && typeof config.agents === "object" ? config.agents : {};
  return Object.entries(configured).map(([id, agent]) => {
    const adapterId = getAgentAdapter(agent?.adapter) ? agent.adapter : getAgentAdapter(id) ? id : null;
    const modelArg = Array.isArray(agent?.args) ? agent.args.findIndex((arg) => arg === "--model" || arg === "-m") : -1;
    const inferredModel = modelArg >= 0 ? agent.args[modelArg + 1] : null;
    return {
      id,
      adapter: adapterId,
      managed: Boolean(adapterId),
      enabled: true,
      model: typeof agent?.model === "string" ? agent.model : inferredModel || null,
    };
  });
}

export function updateAgentSettings(configPath, detections, selections) {
  const config = readJson(configPath);
  if (!config || typeof config.workspaceRoot !== "string") throw new Error("PatchWarden 配置尚未完成");
  if (!Array.isArray(selections)) throw new Error("Agent 设置数据无效");
  const detectionById = new Map(detections.map((agent) => [agent.id || agent.name, agent]));
  const nextAgents = { ...(config.agents || {}) };
  for (const adapter of AGENT_ADAPTERS) {
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
    nextAgents[adapter.id] = buildAgentRegistration(adapter.id, detection, selection.model);
  }
  const updated = { ...config, agents: nextAgents };
  atomicWriteJson(configPath, updated, true);
  return readAgentSettings(configPath);
}

function normalizeProxyEndpoint(value) {
  const mode = value && ["environment", "none", "manual"].includes(value.mode) ? value.mode : "environment";
  if (mode !== "manual") return { mode };
  const url = typeof value.url === "string" ? value.url.trim() : "";
  if (!url) throw new Error("手动代理需要填写 URL");
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error("代理 URL 格式无效"); }
  if (!["http:", "https:", "socks5:"].includes(parsed.protocol)) throw new Error("代理仅支持 http、https 或 socks5");
  if (parsed.username || parsed.password) throw new Error("代理 URL 不能包含用户名或密码");
  return { mode, url: parsed.toString().replace(/\/$/, "") };
}

export function readRuntimeSettings(configPath) {
  const config = readJson(configPath) || {};
  const proxy = config.tunnelProxy && typeof config.tunnelProxy === "object" ? config.tunnelProxy : {};
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

export function updateRuntimeSettings(configPath, patch) {
  const config = readJson(configPath);
  if (!config || typeof config.workspaceRoot !== "string") throw new Error("PatchWarden 配置尚未完成");
  const current = readRuntimeSettings(configPath);
  const tunnelClientPath = patch && Object.hasOwn(patch, "tunnelClientPath") ? patch.tunnelClientPath : current.tunnelClientPath;
  const next = {
    tunnelClientPath: tunnelClientPath || null,
    enableDirectProfile: patch && typeof patch.enableDirectProfile === "boolean" ? patch.enableDirectProfile : current.enableDirectProfile,
    tunnelProxy: patch && patch.tunnelProxy ? {
      scope: patch.tunnelProxy.scope === "separate" ? "separate" : "shared",
      core: normalizeProxyEndpoint(patch.tunnelProxy.core),
      direct: normalizeProxyEndpoint(patch.tunnelProxy.direct),
    } : current.tunnelProxy,
  };
  const updated = { ...config, enableDirectProfile: next.enableDirectProfile, tunnelProxy: next.tunnelProxy };
  if (next.tunnelClientPath) updated.tunnelClientPath = next.tunnelClientPath;
  else delete updated.tunnelClientPath;
  atomicWriteJson(configPath, updated, true);
  return next;
}

export function atomicWriteJson(path, value, backup = true) {
  mkdirSync(dirname(path), { recursive: true });
  if (backup && existsSync(path)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    copyFileSync(path, `${path}.bak-${stamp}`);
  }
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "w" });
  renameSync(temp, path);
}
