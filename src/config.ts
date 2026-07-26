import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { validateWorkspaceRoot } from "./security/workspaceRootGuard.js";
import { stableJsonStringify } from "./utils/stableJson.js";

// ── Type definitions ──────────────────────────────────────────────

export interface AgentConfig {
  command: string;
  args: string[];
  envAllowlist?: string[];
  adapter?: string;
  model?: string;
}

export interface PatchWardenConfig {
  workspaceRoot: string;
  plansDir: string;
  tasksDir: string;
  assessmentsDir: string;
  assessmentTtlSeconds: number;
  agents: Record<string, AgentConfig>;
  allowedTestCommands: string[];
  repoAllowedTestCommands?: Record<string, string[]>;
  maxReadFileBytes: number;
  defaultTaskTimeoutSeconds: number;
  maxTaskTimeoutSeconds: number;
  watcherStaleSeconds: number;
  toolProfile?: "full" | "chatgpt_core" | "chatgpt_direct" | "chatgpt_search";
  repoAliases?: Record<string, string>;
  httpPort?: number;
  http?: { port?: number; host?: string; ownerTokenEnv?: string };
  enableRunTaskTool?: boolean;
  enableAgentAssessment?: boolean;
  agentAssessmentTimeoutSeconds?: number;
  agentAssessmentMaxOutputBytes?: number;
  agentAssessmentAgentName?: string;
  enableDirectProfile?: boolean;
  tunnelClientPath?: string;
  tunnelProxy?: {
    scope: "shared" | "separate";
    core: { mode: "environment" | "none" | "manual"; url?: string };
    direct: { mode: "environment" | "none" | "manual"; url?: string };
  };
  directSessionsDir: string;
  directSessionTtlSeconds: number;
  directMaxPatchBytes: number;
  directMaxFileBytes: number;
  directAllowedCommands?: string[];
  repoDirectAllowedCommands?: Record<string, string[]>;
}

// ── Defaults ──────────────────────────────────────────────────────

const DEFAULT_CONFIG: PatchWardenConfig = {
  workspaceRoot: process.cwd(),
  plansDir: ".patchwarden/plans",
  tasksDir: ".patchwarden/tasks",
  assessmentsDir: ".patchwarden/assessments",
  assessmentTtlSeconds: 3600,
  agents: {},
  allowedTestCommands: [
    "npm test",
    "npm run test",
    "npm run lint",
    "npm run format:check",
    "npm run build",
    "npm run dist",
    "npm run doctor",
    "pnpm test",
    "pnpm run test",
    "pnpm run lint",
    "pnpm run format:check",
    "pnpm run build",
    "pnpm run dist",
    "pnpm run doctor",
    "pytest",
    "cargo test",
  ],
  repoAllowedTestCommands: {},
  maxReadFileBytes: 200_000,
  defaultTaskTimeoutSeconds: 900,
  maxTaskTimeoutSeconds: 3600,
  watcherStaleSeconds: 30,
  toolProfile: "full",
  enableAgentAssessment: false,
  agentAssessmentTimeoutSeconds: 120,
  agentAssessmentMaxOutputBytes: 524288,
  enableDirectProfile: false,
  directSessionsDir: ".patchwarden/direct-sessions",
  directSessionTtlSeconds: 3600,
  directMaxPatchBytes: 200_000,
  directMaxFileBytes: 500_000,
  directAllowedCommands: [
    "npm test",
    "npm run test",
    "npm run build",
    "npm run lint",
    "node --check main.js",
  ],
  repoDirectAllowedCommands: {},
};

// ── Load config ───────────────────────────────────────────────────

let _config: PatchWardenConfig | null = null;

export interface AgentRuntimeMetadata {
  adapter: string | null;
  provider: string | null;
  requested_agent: string;
  selected_agent: string;
  effective_model: string | null;
  agent_config_revision: string;
  model_argument_present: boolean;
  fallback_used: boolean;
  exit_code: number | null;
}

export interface AgentRuntimeContext {
  requested_agent?: string | null;
  selected_agent?: string;
  fallback_used?: boolean;
  exit_code?: number | null;
}

export function sanitizeAgentRuntimeMetadata(value: unknown): AgentRuntimeMetadata | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const revision = typeof record.agent_config_revision === "string"
    ? record.agent_config_revision.slice(0, 64)
    : "";
  if (!/^[a-f0-9]{64}$/i.test(revision)) return null;
  return {
    adapter: typeof record.adapter === "string" ? record.adapter.slice(0, 80) : null,
    provider: typeof record.provider === "string" ? record.provider.slice(0, 80) : null,
    requested_agent: typeof record.requested_agent === "string" ? record.requested_agent.slice(0, 120) : "",
    selected_agent: typeof record.selected_agent === "string" ? record.selected_agent.slice(0, 120) : "",
    effective_model: typeof record.effective_model === "string" ? record.effective_model.slice(0, 200) : null,
    agent_config_revision: revision,
    model_argument_present: record.model_argument_present === true,
    fallback_used: record.fallback_used === true,
    exit_code: typeof record.exit_code === "number" && Number.isInteger(record.exit_code)
      ? record.exit_code
      : null,
  };
}

const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;
const KNOWN_AGENT_ADAPTERS = new Set([
  "codex", "claude", "gemini", "copilot", "qwen", "opencode", "kimi", "aider",
]);
const ADAPTER_PROVIDERS: Readonly<Record<string, string>> = Object.freeze({
  codex: "openai",
  claude: "anthropic",
  gemini: "google",
  copilot: "github",
  qwen: "qwen",
  kimi: "moonshot",
  aider: "aider",
});

export function loadConfig(configPath?: string): PatchWardenConfig {
  if (_config) return _config;
  return loadConfigInternal(configPath);
}

export function reloadConfig(configPath?: string): PatchWardenConfig {
  _config = null;
  return loadConfigInternal(configPath);
}

function loadConfigInternal(configPath?: string): PatchWardenConfig {
  const explicitPath = configPath || process.env.PATCHWARDEN_CONFIG;
  const candidatePaths = explicitPath
    ? [explicitPath]
    : [
        resolve(process.cwd(), "patchwarden.config.json"),
        resolve(process.cwd(), ".patchwarden.json"),
      ];

  for (const p of candidatePaths) {
    if (existsSync(p)) {
      try {
        const rawText = stripBom(readFileSync(p, "utf-8"));
        const raw = JSON.parse(rawText);
        _config = normalizeConfig({ ...DEFAULT_CONFIG, ...raw } as PatchWardenConfig);
        return _config;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to load PatchWarden config "${p}": ${message}`);
      }
    }
  }

  if (explicitPath) {
    throw new Error(`PatchWarden config not found: "${explicitPath}"`);
  }

  _config = normalizeConfig({ ...DEFAULT_CONFIG });
  return _config;
}

export function getConfig(): PatchWardenConfig {
  if (!_config) return loadConfig();
  return _config;
}

/**
 * Reload only trusted Agent registrations for long-running processes.
 * Runtime paths and policy fields must remain byte-for-byte equivalent after
 * normalization; those changes still require a full process restart.
 */
export function refreshAgentConfig(): PatchWardenConfig {
  const current = getConfig();
  const configPath = findActiveConfigPath();
  if (!configPath) return current;

  let candidate: PatchWardenConfig;
  try {
    const rawText = stripBom(readFileSync(configPath, "utf-8"));
    const raw = JSON.parse(rawText);
    candidate = normalizeConfig({ ...DEFAULT_CONFIG, ...raw } as PatchWardenConfig);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to refresh Agent config "${configPath}": ${message}`);
  }

  if (staticConfigFingerprint(candidate) !== staticConfigFingerprint(current)) {
    throw new Error("Agent config hot reload rejected because non-Agent runtime settings changed; restart PatchWarden Core.");
  }
  validateManagedAgentModels(candidate.agents);
  _config = { ...current, agents: candidate.agents };
  return _config;
}

/** Refresh only when the caller holds the currently cached runtime config. */
export function refreshAgentConfigIfActive(config: PatchWardenConfig): PatchWardenConfig {
  return config === _config ? refreshAgentConfig() : config;
}

export function getAgentConfigRevision(config: PatchWardenConfig): string {
  return createHash("sha256").update(stableJsonStringify(config.agents)).digest("hex");
}

export function getAgentRuntimeMetadata(
  agentName: string,
  config: PatchWardenConfig,
  context: AgentRuntimeContext = {},
): AgentRuntimeMetadata {
  const agent = config.agents[agentName];
  if (!agent) throw new Error(`Agent "${agentName}" is not configured.`);
  const adapter = typeof agent.adapter === "string"
    ? agent.adapter
    : KNOWN_AGENT_ADAPTERS.has(agentName) ? agentName : null;
  const modelArgs = agent.args.flatMap((arg, index) =>
    arg === "--model" || arg === "-m" ? [agent.args[index + 1]] : []
  ).filter((value): value is string => typeof value === "string" && value.length > 0);
  const uniqueModelArgs = [...new Set(modelArgs)];
  const configuredModel = typeof agent.model === "string" && agent.model.trim() ? agent.model.trim() : null;

  if (adapter && uniqueModelArgs.length > 1) {
    throw new Error(`Managed Agent "${agentName}" has conflicting model arguments.`);
  }
  const argumentModel = uniqueModelArgs[0] || null;
  if (adapter && configuredModel && argumentModel !== configuredModel) {
    throw new Error(`Managed Agent "${agentName}" model metadata does not match its CLI argument.`);
  }
  const effectiveModel = configuredModel || argumentModel;
  if (effectiveModel && !MODEL_PATTERN.test(effectiveModel)) {
    throw new Error(`Managed Agent "${agentName}" has an invalid model identifier.`);
  }
  return {
    adapter,
    provider: resolveAgentProvider(adapter, effectiveModel),
    requested_agent: String(context.requested_agent ?? agentName).slice(0, 120),
    selected_agent: String(context.selected_agent || agentName).slice(0, 120),
    effective_model: effectiveModel,
    agent_config_revision: getAgentConfigRevision(config),
    model_argument_present: argumentModel !== null,
    fallback_used: context.fallback_used === true,
    exit_code: typeof context.exit_code === "number" && Number.isInteger(context.exit_code)
      ? context.exit_code
      : null,
  };
}

function resolveAgentProvider(adapter: string | null, model: string | null): string | null {
  if (model?.includes("/")) return model.split("/", 1)[0].slice(0, 80) || null;
  if (!adapter) return null;
  return ADAPTER_PROVIDERS[adapter] || adapter;
}

/** Resolve workspaceRoot: expand relative paths */
export function resolveWorkspaceRoot(config: PatchWardenConfig): string {
  return resolve(config.workspaceRoot);
}

/** Resolve plans/tasks dirs relative to workspaceRoot */
export function getPlansDir(config: PatchWardenConfig): string {
  return resolve(config.workspaceRoot, config.plansDir);
}

export function getTasksDir(config: PatchWardenConfig): string {
  return resolve(config.workspaceRoot, config.tasksDir);
}

export function getAssessmentsDir(config: PatchWardenConfig): string {
  return resolve(config.workspaceRoot, config.assessmentsDir);
}

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function findActiveConfigPath(): string | null {
  const explicitPath = process.env.PATCHWARDEN_CONFIG;
  const candidates = explicitPath
    ? [resolve(explicitPath)]
    : [resolve(process.cwd(), "patchwarden.config.json"), resolve(process.cwd(), ".patchwarden.json")];
  return candidates.find((candidate) => existsSync(candidate)) || null;
}

function staticConfigFingerprint(config: PatchWardenConfig): string {
  const { agents: _agents, ...staticConfig } = config;
  return createHash("sha256").update(stableJsonStringify(staticConfig)).digest("hex");
}

function validateManagedAgentModels(agents: Record<string, AgentConfig>): void {
  const validationConfig = { agents } as PatchWardenConfig;
  for (const name of Object.keys(agents)) {
    getAgentRuntimeMetadata(name, validationConfig);
  }
}

function normalizeConfig(config: PatchWardenConfig): PatchWardenConfig {
  if (!config.workspaceRoot || typeof config.workspaceRoot !== "string") {
    throw new Error("workspaceRoot must be a non-empty string");
  }
  const workspaceValidation = validateWorkspaceRoot(config.workspaceRoot);
  if (!workspaceValidation.ok) {
    throw new Error(`Invalid workspaceRoot: ${workspaceValidation.reason} (${workspaceValidation.path})`);
  }
  config.workspaceRoot = workspaceValidation.path;
  if (!config.plansDir || typeof config.plansDir !== "string") {
    throw new Error("plansDir must be a non-empty string");
  }
  if (!config.tasksDir || typeof config.tasksDir !== "string") {
    throw new Error("tasksDir must be a non-empty string");
  }
  if (!config.assessmentsDir || typeof config.assessmentsDir !== "string") {
    throw new Error("assessmentsDir must be a non-empty string");
  }
  if (!Number.isInteger(config.assessmentTtlSeconds) || config.assessmentTtlSeconds < 60 || config.assessmentTtlSeconds > 86400) {
    throw new Error("assessmentTtlSeconds must be an integer from 60 to 86400");
  }
  if (!config.agents || typeof config.agents !== "object") {
    throw new Error("agents must be an object");
  }
  const agents: Record<string, AgentConfig> = {};
  for (const [agentName, agent] of Object.entries(config.agents)) {
    if (!agent || typeof agent !== "object" || typeof agent.command !== "string" || !Array.isArray(agent.args)) {
      throw new Error(`agents["${agentName}"] must define command and args`);
    }
    const envAllowlist = agent.envAllowlist ?? [];
    if (!Array.isArray(envAllowlist) || envAllowlist.some((name) => typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) {
      throw new Error(`agents["${agentName}"].envAllowlist must contain only environment variable names`);
    }
    const blockedNames = new Set(["CONTROL_PLANE_API_KEY", "PATCHWARDEN_OWNER_TOKEN", config.http?.ownerTokenEnv?.toUpperCase()]);
    const blocked = envAllowlist.find((name) => blockedNames.has(name.toUpperCase()));
    if (blocked) throw new Error(`agents["${agentName}"].envAllowlist cannot include reserved variable "${blocked}"`);
    agents[agentName] = { ...agent, args: [...agent.args], envAllowlist: [...new Set(envAllowlist)] };
  }
  if (!Array.isArray(config.allowedTestCommands)) {
    throw new Error("allowedTestCommands must be an array");
  }
  if (config.allowedTestCommands.some((command) => typeof command !== "string" || command.trim() === "")) {
    throw new Error("allowedTestCommands must contain only non-empty command strings");
  }
  if (!config.repoAllowedTestCommands || typeof config.repoAllowedTestCommands !== "object" || Array.isArray(config.repoAllowedTestCommands)) {
    throw new Error("repoAllowedTestCommands must be an object mapping workspace-relative repository paths to command arrays");
  }
  const repoAllowedTestCommands: Record<string, string[]> = {};
  for (const [repoKey, commands] of Object.entries(config.repoAllowedTestCommands)) {
    const normalizedKey = normalizeRepoKey(repoKey);
    const resolvedRepo = resolve(config.workspaceRoot, normalizedKey);
    const relativeRepo = relative(resolve(config.workspaceRoot), resolvedRepo);
    if (isAbsolute(repoKey) || relativeRepo === ".." || relativeRepo.startsWith(`..${sep}`) || isAbsolute(relativeRepo)) {
      throw new Error(`repoAllowedTestCommands key must stay inside workspaceRoot: "${repoKey}"`);
    }
    if (!Array.isArray(commands) || commands.some((command) => typeof command !== "string" || command.trim() === "")) {
      throw new Error(`repoAllowedTestCommands["${repoKey}"] must be an array of non-empty command strings`);
    }
    repoAllowedTestCommands[normalizedKey] = [...new Set(commands.map((command) => command.trim()))];
  }
  if (!Number.isFinite(config.maxReadFileBytes) || config.maxReadFileBytes <= 0) {
    throw new Error("maxReadFileBytes must be a positive number");
  }
  if (!Number.isInteger(config.defaultTaskTimeoutSeconds) || config.defaultTaskTimeoutSeconds <= 0) {
    throw new Error("defaultTaskTimeoutSeconds must be a positive integer");
  }
  if (!Number.isInteger(config.maxTaskTimeoutSeconds) || config.maxTaskTimeoutSeconds <= 0) {
    throw new Error("maxTaskTimeoutSeconds must be a positive integer");
  }
  if (config.defaultTaskTimeoutSeconds > config.maxTaskTimeoutSeconds) {
    throw new Error("defaultTaskTimeoutSeconds cannot exceed maxTaskTimeoutSeconds");
  }
  if (!Number.isInteger(config.watcherStaleSeconds) || config.watcherStaleSeconds < 5 || config.watcherStaleSeconds > 3600) {
    throw new Error("watcherStaleSeconds must be an integer from 5 to 3600");
  }
  if (
    config.toolProfile !== undefined &&
    config.toolProfile !== "full" &&
    config.toolProfile !== "chatgpt_core" &&
    config.toolProfile !== "chatgpt_direct" &&
    config.toolProfile !== "chatgpt_search"
  ) {
    throw new Error('toolProfile must be "full", "chatgpt_core", "chatgpt_direct", or "chatgpt_search"');
  }
  if (config.repoAliases !== undefined) {
    if (typeof config.repoAliases !== "object" || config.repoAliases === null || Array.isArray(config.repoAliases)) {
      throw new Error("repoAliases must be an object mapping alias names to repository paths");
    }
    for (const [alias, target] of Object.entries(config.repoAliases)) {
      if (typeof target !== "string") {
        throw new Error(`repoAliases["${alias}"] must be a string`);
      }
    }
  }
  if (config.httpPort !== undefined) {
    if (typeof config.httpPort !== "number" || !Number.isInteger(config.httpPort) || config.httpPort < 1 || config.httpPort > 65535) {
      throw new Error("httpPort must be an integer from 1 to 65535");
    }
  }
  if (config.http !== undefined) {
    if (typeof config.http !== "object" || config.http === null || Array.isArray(config.http)) {
      throw new Error("http must be an object");
    }
    if (config.http.port !== undefined) {
      if (typeof config.http.port !== "number" || !Number.isInteger(config.http.port) || config.http.port < 1 || config.http.port > 65535) {
        throw new Error("http.port must be an integer from 1 to 65535");
      }
    }
    if (config.http.host !== undefined && typeof config.http.host !== "string") {
      throw new Error("http.host must be a string");
    }
    if (
      config.http.ownerTokenEnv !== undefined
      && (
        typeof config.http.ownerTokenEnv !== "string"
        || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.http.ownerTokenEnv)
      )
    ) {
      throw new Error("http.ownerTokenEnv must be a valid environment variable name");
    }
  }
  if (config.enableRunTaskTool !== undefined && typeof config.enableRunTaskTool !== "boolean") {
    throw new Error("enableRunTaskTool must be a boolean");
  }
  if (config.enableAgentAssessment !== undefined && typeof config.enableAgentAssessment !== "boolean") {
    throw new Error("enableAgentAssessment must be a boolean");
  }
  if (config.agentAssessmentTimeoutSeconds !== undefined) {
    if (!Number.isInteger(config.agentAssessmentTimeoutSeconds) || config.agentAssessmentTimeoutSeconds < 10 || config.agentAssessmentTimeoutSeconds > 600) {
      throw new Error("agentAssessmentTimeoutSeconds must be an integer from 10 to 600");
    }
  }
  if (config.agentAssessmentMaxOutputBytes !== undefined) {
    if (!Number.isInteger(config.agentAssessmentMaxOutputBytes) || config.agentAssessmentMaxOutputBytes < 16384 || config.agentAssessmentMaxOutputBytes > 8388608) {
      throw new Error("agentAssessmentMaxOutputBytes must be an integer from 16384 to 8388608");
    }
  }
  if (config.agentAssessmentAgentName !== undefined && typeof config.agentAssessmentAgentName !== "string") {
    throw new Error("agentAssessmentAgentName must be a string");
  }
  if (config.enableDirectProfile !== undefined && typeof config.enableDirectProfile !== "boolean") {
    throw new Error("enableDirectProfile must be a boolean");
  }
  if (config.tunnelClientPath !== undefined) {
    if (typeof config.tunnelClientPath !== "string" || !isAbsolute(config.tunnelClientPath)) {
      throw new Error("tunnelClientPath must be an absolute path");
    }
    if (basename(config.tunnelClientPath).toLowerCase() !== "tunnel-client.exe") {
      throw new Error("tunnelClientPath must point to tunnel-client.exe");
    }
  }
  if (config.tunnelProxy !== undefined) {
    if (!config.tunnelProxy || typeof config.tunnelProxy !== "object" || !["shared", "separate"].includes(config.tunnelProxy.scope)) {
      throw new Error("tunnelProxy.scope must be shared or separate");
    }
    for (const key of ["core", "direct"] as const) {
      const endpoint = config.tunnelProxy[key];
      if (!endpoint || typeof endpoint !== "object" || !["environment", "none", "manual"].includes(endpoint.mode)) {
        throw new Error(`tunnelProxy.${key}.mode must be environment, none, or manual`);
      }
      if (endpoint.mode === "manual") {
        if (typeof endpoint.url !== "string") throw new Error(`tunnelProxy.${key}.url is required in manual mode`);
        let parsed: URL;
        try { parsed = new URL(endpoint.url); } catch { throw new Error(`tunnelProxy.${key}.url must be a valid URL`); }
        if (!["http:", "https:", "socks5:"].includes(parsed.protocol)) {
          throw new Error(`tunnelProxy.${key}.url must use http, https, or socks5`);
        }
        if (parsed.username || parsed.password) throw new Error(`tunnelProxy.${key}.url must not contain credentials`);
      } else if (endpoint.url !== undefined) {
        throw new Error(`tunnelProxy.${key}.url is only allowed in manual mode`);
      }
    }
  }
  if (!config.directSessionsDir || typeof config.directSessionsDir !== "string") {
    throw new Error("directSessionsDir must be a non-empty string");
  }
  if (!Number.isInteger(config.directSessionTtlSeconds) || config.directSessionTtlSeconds < 60 || config.directSessionTtlSeconds > 86400) {
    throw new Error("directSessionTtlSeconds must be an integer from 60 to 86400");
  }
  if (!Number.isInteger(config.directMaxPatchBytes) || config.directMaxPatchBytes <= 0) {
    throw new Error("directMaxPatchBytes must be a positive integer");
  }
  if (!Number.isInteger(config.directMaxFileBytes) || config.directMaxFileBytes <= 0) {
    throw new Error("directMaxFileBytes must be a positive integer");
  }
  if (config.directAllowedCommands !== undefined) {
    if (!Array.isArray(config.directAllowedCommands)) {
      throw new Error("directAllowedCommands must be an array");
    }
    if (config.directAllowedCommands.some((command) => typeof command !== "string" || command.trim() === "")) {
      throw new Error("directAllowedCommands must contain only non-empty command strings");
    }
  }
  if (config.repoDirectAllowedCommands !== undefined) {
    if (typeof config.repoDirectAllowedCommands !== "object" || Array.isArray(config.repoDirectAllowedCommands)) {
      throw new Error("repoDirectAllowedCommands must be an object mapping workspace-relative repository paths to command arrays");
    }
    const repoDirectAllowedCommands: Record<string, string[]> = {};
    for (const [repoKey, commands] of Object.entries(config.repoDirectAllowedCommands)) {
      const normalizedKey = normalizeRepoKey(repoKey);
      const resolvedRepo = resolve(config.workspaceRoot, normalizedKey);
      const relativeRepo = relative(resolve(config.workspaceRoot), resolvedRepo);
      if (isAbsolute(repoKey) || relativeRepo === ".." || relativeRepo.startsWith(`..${sep}`) || isAbsolute(relativeRepo)) {
        throw new Error(`repoDirectAllowedCommands key must stay inside workspaceRoot: "${repoKey}"`);
      }
      if (!Array.isArray(commands) || commands.some((command) => typeof command !== "string" || command.trim() === "")) {
        throw new Error(`repoDirectAllowedCommands["${repoKey}"] must be an array of non-empty command strings`);
      }
      repoDirectAllowedCommands[normalizedKey] = [...new Set(commands.map((command) => command.trim()))];
    }
    config.repoDirectAllowedCommands = repoDirectAllowedCommands;
  }

  return {
    ...config,
    agents,
    workspaceRoot: resolve(config.workspaceRoot),
    allowedTestCommands: [...new Set(config.allowedTestCommands.map((command) => command.trim()))],
    repoAllowedTestCommands,
  };
}

export function getRepoAllowedTestCommands(config: PatchWardenConfig, repoPath: string): string[] {
  const target = comparablePath(resolve(repoPath));
  for (const [repoKey, commands] of Object.entries(config.repoAllowedTestCommands || {})) {
    if (comparablePath(resolve(config.workspaceRoot, repoKey)) === target) return [...commands];
  }
  return [];
}

export function getAllConfiguredTestCommands(config: PatchWardenConfig): string[] {
  return [...new Set([
    ...config.allowedTestCommands,
    ...Object.values(config.repoAllowedTestCommands || {}).flat(),
  ])];
}

export function getDirectSessionsDir(config: PatchWardenConfig): string {
  return resolve(config.workspaceRoot, config.directSessionsDir);
}

export function getRepoDirectAllowedCommands(config: PatchWardenConfig, repoPath: string): string[] {
  const target = comparablePath(resolve(repoPath));
  for (const [repoKey, commands] of Object.entries(config.repoDirectAllowedCommands || {})) {
    if (comparablePath(resolve(config.workspaceRoot, repoKey)) === target) return [...commands];
  }
  return [];
}

export function getAllConfiguredDirectCommands(config: PatchWardenConfig): string[] {
  return [...new Set([
    ...(config.directAllowedCommands || []),
    ...Object.values(config.repoDirectAllowedCommands || {}).flat(),
  ])];
}

function normalizeRepoKey(value: string): string {
  const trimmed = String(value).trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
  return trimmed === "" ? "." : trimmed;
}

function comparablePath(value: string): string {
  const normalized = resolve(value).replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
