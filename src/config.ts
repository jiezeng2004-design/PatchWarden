import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { validateWorkspaceRoot } from "./security/workspaceRootGuard.js";
import { stableJsonStringify } from "./utils/stableJson.js";
import {
  extractConfiguredModelArgument,
  getAdapterDescriptor,
  getAdapterRevisionPayload,
  normalizeRepoAgentDefaults,
  optionalModel,
  resolveTaskModelSelection,
  sanitizeModelSelectionEvidence,
  validateRequestedModel,
  type ModelSelectionEvidence,
} from "./agents/modelSelection.js";
import { failureCategoryEvidence, isTaskFailureCategory, type TaskFailureCategory } from "./runner/failureCategories.js";

const GENERATED_PATH_PATTERN_HINT = /(^|\/)(?:\.next|dist|build|out|output|coverage|\.cache|cache|target|__pycache__|generated|release|artifacts?)(?:\/|$)|(?:^|[-_.])(?:generated|output|cache|artifact)(?:[-_.\/]|$)|\.(?:tsbuildinfo|pyc|log|tmp|temp|map|exe|dll|zip|tgz|tar\.gz)(?:$|[*?])/i;

// ── Type definitions ──────────────────────────────────────────────

export interface AgentConfig {
  command: string;
  args: string[];
  envAllowlist?: string[];
  adapter?: string;
  model?: string;
  provider?: string;
  default_model?: string | null;
  available_models?: string[];
  allow_unlisted_model_override?: boolean;
  settings_policy?: "inherit" | "isolated";
}

export interface RuntimeValidationViewport {
  name: string;
  width: number;
  height: number;
}

export interface RuntimeValidationConfig {
  enabled: boolean;
  startCommand: string;
  baseUrl: string;
  routes: string[];
  viewports: RuntimeValidationViewport[];
  checkConsoleErrors: boolean;
  checkBrokenImages: boolean;
  checkHorizontalOverflow: boolean;
  captureScreenshots: boolean;
  startupTimeoutSeconds: number;
  navigationTimeoutSeconds: number;
}

export interface PatchWardenConfig {
  workspaceRoot: string;
  plansDir: string;
  tasksDir: string;
  assessmentsDir: string;
  assessmentTtlSeconds: number;
  agents: Record<string, AgentConfig>;
  agentPriority?: string[];
  maxRetriesPerAgent?: number;
  fallbackOn?: TaskFailureCategory[];
  doNotFallbackOn?: TaskFailureCategory[];
  repoAgentDefaults?: Record<string, Record<string, string | null>>;
  allowedTestCommands: string[];
  repoAllowedTestCommands?: Record<string, string[]>;
  generatedPaths?: string[];
  repoGeneratedPaths?: Record<string, string[]>;
  runtimeValidation?: RuntimeValidationConfig;
  maxReadFileBytes: number;
  defaultTaskTimeoutSeconds: number;
  maxTaskTimeoutSeconds: number;
  watcherStaleSeconds: number;
  taskArchiveRetentionDays?: number;
  taskArchiveCleanupIntervalHours?: number;
  taskArchiveCleanupMaxBatch?: number;
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
  agentPriority: [],
  maxRetriesPerAgent: 0,
  fallbackOn: [],
  doNotFallbackOn: ["policy_block", "scope_violation", "user_confirmation_required", "connector_failure", "watcher_failure"],
  repoAgentDefaults: {},
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
  generatedPaths: [],
  repoGeneratedPaths: {},
  maxReadFileBytes: 200_000,
  defaultTaskTimeoutSeconds: 900,
  maxTaskTimeoutSeconds: 3600,
  watcherStaleSeconds: 30,
  taskArchiveRetentionDays: 30,
  taskArchiveCleanupIntervalHours: 24,
  taskArchiveCleanupMaxBatch: 100,
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

export interface AgentRuntimeMetadata extends ModelSelectionEvidence {
  adapter: string | null;
  exit_code: number | null;
  model_argument_verified?: boolean;
  model_argument_name?: string | null;
}

export interface AgentRuntimeContext {
  requested_agent?: string | null;
  selected_agent?: string;
  fallback_used?: boolean;
  exit_code?: number | null;
  requested_model?: unknown;
  repo_path?: string;
  model_selection?: unknown;
}

export function sanitizeAgentRuntimeMetadata(value: unknown): AgentRuntimeMetadata | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const selection = sanitizeModelSelectionEvidence(record);
  if (!selection) return null;
  return {
    ...selection,
    adapter: typeof record.adapter === "string" ? record.adapter.slice(0, 80) : null,
    exit_code: typeof record.exit_code === "number" && Number.isInteger(record.exit_code)
      ? record.exit_code
      : null,
    ...(typeof record.model_argument_verified === "boolean"
      ? { model_argument_verified: record.model_argument_verified }
      : {}),
    ...(record.model_argument_name === null || record.model_argument_name === "--model" || record.model_argument_name === "-m"
      ? { model_argument_name: record.model_argument_name }
      : {}),
  };
}

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
        const raw = normalizeConfigAliases(JSON.parse(rawText));
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
    const raw = normalizeConfigAliases(JSON.parse(rawText));
    candidate = normalizeConfig({ ...DEFAULT_CONFIG, ...raw } as PatchWardenConfig);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to refresh Agent config "${configPath}": ${message}`);
  }

  if (staticConfigFingerprint(candidate) !== staticConfigFingerprint(current)) {
    throw new Error("Agent config hot reload rejected because non-Agent runtime settings changed; restart PatchWarden Core.");
  }
  validateManagedAgentModels(candidate);
  _config = { ...current, agents: candidate.agents, repoAgentDefaults: candidate.repoAgentDefaults };
  return _config;
}

/** Refresh only when the caller holds the currently cached runtime config. */
export function refreshAgentConfigIfActive(config: PatchWardenConfig): PatchWardenConfig {
  return config === _config ? refreshAgentConfig() : config;
}

export function getAgentConfigRevision(config: PatchWardenConfig): string {
  return createHash("sha256").update(stableJsonStringify({
    agents: config.agents,
    repoAgentDefaults: config.repoAgentDefaults || {},
    adapter_templates: getAdapterRevisionPayload(config),
  })).digest("hex");
}

export function getAgentRuntimeMetadata(
  agentName: string,
  config: PatchWardenConfig,
  context: AgentRuntimeContext = {},
): AgentRuntimeMetadata {
  const agent = config.agents[agentName];
  if (!agent) throw new Error(`Agent "${agentName}" is not configured.`);
  const adapter = getAdapterDescriptor(agentName, agent)?.id ?? null;
  const frozen = sanitizeModelSelectionEvidence(context.model_selection);
  const selection = frozen ?? resolveTaskModelSelection({
    agentName,
    requestedAgent: context.requested_agent,
    selectedAgent: context.selected_agent,
    requestedModel: context.requested_model,
    repoPath: context.repo_path || config.workspaceRoot,
    config,
    agentConfigRevision: getAgentConfigRevision(config),
    agentFallbackUsed: context.fallback_used,
  });
  return {
    ...selection,
    adapter,
    exit_code: typeof context.exit_code === "number" && Number.isInteger(context.exit_code)
      ? context.exit_code
      : null,
  };
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

function normalizeConfigAliases(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("configuration root must be an object");
  }
  const raw = { ...(value as Record<string, unknown>) };
  for (const [legacy, canonical] of [
    ["generated_paths", "generatedPaths"],
    ["repo_generated_paths", "repoGeneratedPaths"],
    ["runtime_validation", "runtimeValidation"],
    ["agent_priority", "agentPriority"],
    ["max_retries_per_agent", "maxRetriesPerAgent"],
    ["fallback_on", "fallbackOn"],
    ["do_not_fallback_on", "doNotFallbackOn"],
  ] as const) {
    if (raw[legacy] !== undefined && raw[canonical] !== undefined) {
      throw new Error(`Configure only ${canonical}; do not also set legacy alias ${legacy}`);
    }
    if (raw[canonical] === undefined && raw[legacy] !== undefined) raw[canonical] = raw[legacy];
    delete raw[legacy];
  }
  return raw;
}

function findActiveConfigPath(): string | null {
  const explicitPath = process.env.PATCHWARDEN_CONFIG;
  const candidates = explicitPath
    ? [resolve(explicitPath)]
    : [resolve(process.cwd(), "patchwarden.config.json"), resolve(process.cwd(), ".patchwarden.json")];
  return candidates.find((candidate) => existsSync(candidate)) || null;
}

function staticConfigFingerprint(config: PatchWardenConfig): string {
  const { agents: _agents, repoAgentDefaults: _repoAgentDefaults, ...staticConfig } = config;
  return createHash("sha256").update(stableJsonStringify(staticConfig)).digest("hex");
}

function validateManagedAgentModels(config: PatchWardenConfig): void {
  for (const name of Object.keys(config.agents)) {
    getAgentRuntimeMetadata(name, config);
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
    const provider = agent.provider === undefined ? undefined : String(agent.provider).trim();
    if (provider !== undefined && (!provider || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(provider))) {
      throw new Error(`agents["${agentName}"].provider must be a safe non-empty provider identifier`);
    }
    const defaultModel = optionalModel(agent.default_model, `agents["${agentName}"].default_model`);
    const legacyModel = optionalModel(agent.model, `agents["${agentName}"].model`);
    const argumentModel = extractConfiguredModelArgument(agent);
    if (defaultModel && legacyModel && defaultModel !== legacyModel) {
      throw new Error(`agents["${agentName}"].default_model does not match legacy model metadata`);
    }
    if (agent.available_models !== undefined && !Array.isArray(agent.available_models)) {
      throw new Error(`agents["${agentName}"].available_models must be an array`);
    }
    const availableModels = [...new Set((agent.available_models || []).map((model) =>
      validateRequestedModel(model, `agents["${agentName}"].available_models`)
    ))];
    if (agent.allow_unlisted_model_override !== undefined && typeof agent.allow_unlisted_model_override !== "boolean") {
      throw new Error(`agents["${agentName}"].allow_unlisted_model_override must be boolean`);
    }
    if (agent.settings_policy !== undefined && agent.settings_policy !== "inherit" && agent.settings_policy !== "isolated") {
      throw new Error(`agents["${agentName}"].settings_policy must be "inherit" or "isolated"`);
    }
    const descriptor = getAdapterDescriptor(agentName, agent);
    if (agent.settings_policy === "isolated" && descriptor?.settings_isolation !== "claude_empty_sources") {
      throw new Error(`Agent "${agentName}" does not support settings_policy="isolated"`);
    }
    const normalizedDefault = defaultModel ?? legacyModel ?? argumentModel;
    if (normalizedDefault && availableModels.length > 0 && agent.allow_unlisted_model_override === false && !availableModels.includes(normalizedDefault)) {
      throw new Error(`Default model for Agent "${agentName}" is not present in available_models`);
    }
    agents[agentName] = {
      ...agent,
      args: [...agent.args],
      envAllowlist: [...new Set(envAllowlist)],
      ...(provider === undefined ? {} : { provider }),
      default_model: normalizedDefault,
      available_models: availableModels,
      allow_unlisted_model_override: agent.allow_unlisted_model_override !== false,
      settings_policy: agent.settings_policy || "inherit",
    };
  }
  const repoAgentDefaults = normalizeRepoAgentDefaults(config.repoAgentDefaults, config.workspaceRoot);
  const agentPriority = normalizeAgentPriority(config.agentPriority, agents);
  const maxRetriesPerAgent = config.maxRetriesPerAgent ?? 0;
  if (!Number.isSafeInteger(maxRetriesPerAgent) || maxRetriesPerAgent < 0 || maxRetriesPerAgent > 3) {
    throw new Error("maxRetriesPerAgent must be an integer from 0 to 3");
  }
  const fallbackOn = normalizeFailureCategoryList(config.fallbackOn, "fallbackOn");
  const hardNoFallback: TaskFailureCategory[] = [
    "policy_block", "scope_violation", "user_confirmation_required", "connector_failure", "watcher_failure",
  ];
  for (const category of fallbackOn) {
    if (!failureCategoryEvidence(category).fallback_eligible || hardNoFallback.includes(category)) {
      throw new Error(`fallbackOn cannot include non-fallback category "${category}"`);
    }
  }
  const configuredDoNotFallback = normalizeFailureCategoryList(config.doNotFallbackOn, "doNotFallbackOn");
  const doNotFallbackOn = [...new Set([...hardNoFallback, ...configuredDoNotFallback])];
  const conflict = fallbackOn.find((category) => doNotFallbackOn.includes(category));
  if (conflict) throw new Error(`fallbackOn and doNotFallbackOn cannot both include "${conflict}"`);
  for (const [repoKey, defaults] of Object.entries(repoAgentDefaults)) {
    for (const [agentName, model] of Object.entries(defaults)) {
      if (model === null) continue;
      const agent = agents[agentName];
      if (!agent) throw new Error(`repoAgentDefaults["${repoKey}"] references unknown Agent "${agentName}"`);
      const descriptor = getAdapterDescriptor(agentName, agent);
      if (!descriptor?.supports_model_override) {
        throw new Error(`repoAgentDefaults["${repoKey}"]["${agentName}"] does not support model overrides`);
      }
      if ((agent.available_models || []).length > 0
        && agent.allow_unlisted_model_override === false
        && !agent.available_models!.includes(model)) {
        throw new Error(`repoAgentDefaults["${repoKey}"]["${agentName}"] is not present in available_models`);
      }
    }
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
  const generatedPaths = normalizeGeneratedPathList(config.generatedPaths ?? [], "generatedPaths");
  if (!config.repoGeneratedPaths || typeof config.repoGeneratedPaths !== "object" || Array.isArray(config.repoGeneratedPaths)) {
    throw new Error("repoGeneratedPaths must be an object mapping workspace-relative repository paths to generated path arrays");
  }
  const repoGeneratedPaths: Record<string, string[]> = {};
  for (const [repoKey, patterns] of Object.entries(config.repoGeneratedPaths)) {
    const normalizedKey = normalizeRepoKey(repoKey);
    const resolvedRepo = resolve(config.workspaceRoot, normalizedKey);
    const relativeRepo = relative(resolve(config.workspaceRoot), resolvedRepo);
    if (isAbsolute(repoKey) || relativeRepo === ".." || relativeRepo.startsWith(`..${sep}`) || isAbsolute(relativeRepo)) {
      throw new Error(`repoGeneratedPaths key must stay inside workspaceRoot: "${repoKey}"`);
    }
    repoGeneratedPaths[normalizedKey] = normalizeGeneratedPathList(patterns, `repoGeneratedPaths["${repoKey}"]`);
  }
  const runtimeValidation = normalizeRuntimeValidation(config.runtimeValidation);
  if (!Number.isFinite(config.maxReadFileBytes) || config.maxReadFileBytes <= 0) {
    throw new Error("maxReadFileBytes must be a positive number");
  }
  const taskArchiveRetentionDays = config.taskArchiveRetentionDays ?? 30;
  if (!Number.isSafeInteger(taskArchiveRetentionDays) || taskArchiveRetentionDays < 1 || taskArchiveRetentionDays > 3650) {
    throw new Error("taskArchiveRetentionDays must be an integer from 1 to 3650");
  }
  const taskArchiveCleanupIntervalHours = config.taskArchiveCleanupIntervalHours ?? 24;
  if (!Number.isSafeInteger(taskArchiveCleanupIntervalHours) || taskArchiveCleanupIntervalHours < 1 || taskArchiveCleanupIntervalHours > 168) {
    throw new Error("taskArchiveCleanupIntervalHours must be an integer from 1 to 168");
  }
  const taskArchiveCleanupMaxBatch = config.taskArchiveCleanupMaxBatch ?? 100;
  if (!Number.isSafeInteger(taskArchiveCleanupMaxBatch) || taskArchiveCleanupMaxBatch < 1 || taskArchiveCleanupMaxBatch > 100) {
    throw new Error("taskArchiveCleanupMaxBatch must be an integer from 1 to 100");
  }
  config.taskArchiveRetentionDays = taskArchiveRetentionDays;
  config.taskArchiveCleanupIntervalHours = taskArchiveCleanupIntervalHours;
  config.taskArchiveCleanupMaxBatch = taskArchiveCleanupMaxBatch;
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
    agentPriority,
    maxRetriesPerAgent,
    fallbackOn,
    doNotFallbackOn,
    repoAgentDefaults,
    workspaceRoot: resolve(config.workspaceRoot),
    allowedTestCommands: [...new Set(config.allowedTestCommands.map((command) => command.trim()))],
    repoAllowedTestCommands,
    generatedPaths,
    repoGeneratedPaths,
    runtimeValidation,
  };
}

function normalizeAgentPriority(value: unknown, agents: Record<string, AgentConfig>): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) throw new Error("agentPriority must be an array with at most 20 entries");
  const normalized = value.map((entry, index) => {
    if (typeof entry !== "string" || !entry.trim()) throw new Error(`agentPriority[${index}] must be a non-empty Agent name`);
    const name = entry.trim();
    if (!agents[name]) throw new Error(`agentPriority references unknown Agent "${name}"`);
    return name;
  });
  if (new Set(normalized).size !== normalized.length) throw new Error("agentPriority entries must be unique");
  return normalized;
}

function normalizeFailureCategoryList(value: unknown, field: string): TaskFailureCategory[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 10) throw new Error(`${field} must be an array with at most 10 entries`);
  const categories = value.map((entry, index) => {
    if (!isTaskFailureCategory(entry)) throw new Error(`${field}[${index}] is not a supported task failure category`);
    return entry;
  });
  if (new Set(categories).size !== categories.length) throw new Error(`${field} entries must be unique`);
  return categories;
}

function normalizeRuntimeValidation(value: unknown): RuntimeValidationConfig | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("runtimeValidation must be an object");
  const raw = value as Record<string, unknown>;
  const field = <T>(camel: string, snake: string, fallback: T): T => (raw[camel] ?? raw[snake] ?? fallback) as T;
  const enabled = field("enabled", "enabled", false);
  if (typeof enabled !== "boolean") throw new Error("runtimeValidation.enabled must be boolean");
  const startCommand = String(field("startCommand", "start_command", "")).trim();
  const baseUrl = String(field("baseUrl", "base_url", "")).trim();
  if (enabled && !startCommand) throw new Error("runtimeValidation.startCommand is required when enabled");
  if (enabled && !baseUrl) throw new Error("runtimeValidation.baseUrl is required when enabled");
  if (startCommand.length > 500) throw new Error("runtimeValidation.startCommand is too long");
  if (baseUrl) assertLoopbackRuntimeUrl(baseUrl);

  const routesValue = field<unknown>("routes", "routes", ["/"]);
  if (!Array.isArray(routesValue) || routesValue.length === 0 || routesValue.length > 50) throw new Error("runtimeValidation.routes must contain 1-50 routes");
  const routes = routesValue.map((route, index) => {
    if (typeof route !== "string" || !route.startsWith("/") || route.startsWith("//") || route.includes("\\") || route.split(/[/?#]/).includes("..") || route.length > 500 || /[\r\n\0]/.test(route)) {
      throw new Error(`runtimeValidation.routes[${index}] must be a safe root-relative route`);
    }
    return route;
  });
  const viewportsValue = field<unknown>("viewports", "viewports", [
    { name: "desktop", width: 1440, height: 900 },
    { name: "mobile", width: 390, height: 844 },
  ]);
  if (!Array.isArray(viewportsValue) || viewportsValue.length === 0 || viewportsValue.length > 8) throw new Error("runtimeValidation.viewports must contain 1-8 entries");
  const viewports = viewportsValue.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`runtimeValidation.viewports[${index}] must be an object`);
    const viewport = entry as Record<string, unknown>;
    const name = String(viewport.name || "").trim();
    const width = Number(viewport.width);
    const height = Number(viewport.height);
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(name) || !Number.isSafeInteger(width) || width < 240 || width > 3840 || !Number.isSafeInteger(height) || height < 240 || height > 2160) {
      throw new Error(`runtimeValidation.viewports[${index}] is invalid`);
    }
    return { name, width, height };
  });
  const booleanField = (camel: string, snake: string, fallback: boolean) => {
    const result = field<unknown>(camel, snake, fallback);
    if (typeof result !== "boolean") throw new Error(`runtimeValidation.${camel} must be boolean`);
    return result;
  };
  const integerField = (camel: string, snake: string, fallback: number, minimum: number, maximum: number) => {
    const result = Number(field<unknown>(camel, snake, fallback));
    if (!Number.isSafeInteger(result) || result < minimum || result > maximum) throw new Error(`runtimeValidation.${camel} must be an integer from ${minimum} to ${maximum}`);
    return result;
  };
  return {
    enabled,
    startCommand,
    baseUrl,
    routes: [...new Set(routes)],
    viewports,
    checkConsoleErrors: booleanField("checkConsoleErrors", "check_console_errors", true),
    checkBrokenImages: booleanField("checkBrokenImages", "check_broken_images", true),
    checkHorizontalOverflow: booleanField("checkHorizontalOverflow", "check_horizontal_overflow", true),
    captureScreenshots: booleanField("captureScreenshots", "capture_screenshots", true),
    startupTimeoutSeconds: integerField("startupTimeoutSeconds", "startup_timeout_seconds", 60, 5, 300),
    navigationTimeoutSeconds: integerField("navigationTimeoutSeconds", "navigation_timeout_seconds", 30, 1, 120),
  };
}

function assertLoopbackRuntimeUrl(value: string): void {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error("runtimeValidation.baseUrl must be a valid URL"); }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (parsed.protocol !== "http:" || !["127.0.0.1", "::1"].includes(hostname) || parsed.username || parsed.password || parsed.hash) {
    throw new Error("runtimeValidation.baseUrl must be a credential-free literal HTTP loopback URL without a fragment");
  }
}

function normalizeGeneratedPathList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array of repository-relative glob patterns`);
  if (value.length > 128) throw new Error(`${field} cannot contain more than 128 patterns`);
  const normalized = value.map((entry, index) => {
    if (typeof entry !== "string") throw new Error(`${field}[${index}] must be a string`);
    const pattern = entry.trim().replace(/\\/g, "/").replace(/^\.\//, "");
    if (!pattern || pattern.length > 256 || pattern.includes("\0")) {
      throw new Error(`${field}[${index}] must be a non-empty pattern no longer than 256 characters`);
    }
    if (pattern.startsWith("/") || /^[A-Za-z]:\//.test(pattern) || pattern.split("/").includes("..")) {
      throw new Error(`${field}[${index}] must stay relative to the repository`);
    }
    if (["*", "**", "**/*", "."].includes(pattern)) {
      throw new Error(`${field}[${index}] is too broad to classify safely`);
    }
    if (!GENERATED_PATH_PATTERN_HINT.test(pattern)) {
      throw new Error(`${field}[${index}] must identify a generated-output path or artifact extension`);
    }
    return pattern;
  });
  return [...new Set(normalized)];
}

export function getRepoAllowedTestCommands(config: PatchWardenConfig, repoPath: string): string[] {
  const target = comparablePath(resolve(repoPath));
  for (const [repoKey, commands] of Object.entries(config.repoAllowedTestCommands || {})) {
    if (comparablePath(resolve(config.workspaceRoot, repoKey)) === target) return [...commands];
  }
  return [];
}

export function getRepoGeneratedPaths(config: PatchWardenConfig, repoPath: string): string[] {
  const target = comparablePath(resolve(repoPath));
  const patterns = [...(config.generatedPaths || [])];
  for (const [repoKey, configured] of Object.entries(config.repoGeneratedPaths || {})) {
    if (comparablePath(resolve(config.workspaceRoot, repoKey)) === target) patterns.push(...configured);
  }
  return [...new Set(patterns)];
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
