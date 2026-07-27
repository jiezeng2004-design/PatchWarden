import { isAbsolute, relative, resolve, sep } from "node:path";
import { PatchWardenError } from "../errors.js";
import type { AgentConfig, PatchWardenConfig } from "../config.js";

export const MODEL_ID_MAX_LENGTH = 200;
export const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;

export type ModelSource =
  | "task_override"
  | "agent_config_default"
  | "provider_default"
  | "agent_default_unobserved"
  | "fallback";

export interface ModelSelectionEvidence {
  requested_agent: string;
  selected_agent: string;
  requested_model: string | null;
  configured_default_model: string | null;
  effective_model: string | null;
  model_source: ModelSource;
  provider: string | null;
  model_argument_present: boolean;
  agent_config_revision: string;
  fallback_used: boolean;
  agent_fallback_used: boolean;
  model_fallback_used: boolean;
}

export interface AdapterDescriptor {
  id: string;
  supports_model_override: boolean;
  model_flags: readonly string[];
  prompt_value_flags: readonly string[];
  settings_isolation?: "claude_empty_sources";
  template_revision: string;
}

const ADAPTERS: Readonly<Record<string, AdapterDescriptor>> = Object.freeze({
  codex: descriptor("codex", "codex-model-v1"),
  claude: descriptor("claude", "claude-model-settings-v2", "claude_empty_sources"),
  opencode: descriptor("opencode", "opencode-model-v1"),
  gemini: descriptor("gemini", "gemini-model-v2", undefined, ["--prompt"]),
  copilot: descriptor("copilot", "copilot-model-v2", undefined, ["-p"]),
  qwen: descriptor("qwen", "qwen-model-v2", undefined, ["--prompt"]),
  kimi: descriptor("kimi", "kimi-model-v2", undefined, ["--prompt"]),
  aider: descriptor("aider", "aider-model-v2", undefined, ["--message"]),
});

function descriptor(
  id: string,
  templateRevision: string,
  settingsIsolation?: "claude_empty_sources",
  promptValueFlags: readonly string[] = [],
): AdapterDescriptor {
  return {
    id,
    supports_model_override: true,
    model_flags: ["--model", "-m"],
    prompt_value_flags: [...promptValueFlags],
    ...(settingsIsolation ? { settings_isolation: settingsIsolation } : {}),
    template_revision: templateRevision,
  };
}

export function getAdapterDescriptor(agentName: string, agent: AgentConfig): AdapterDescriptor | null {
  const adapter = typeof agent.adapter === "string" && agent.adapter.trim()
    ? agent.adapter.trim()
    : agentName;
  return ADAPTERS[adapter] || null;
}

export function getAdapterRevisionPayload(config: PatchWardenConfig): Record<string, unknown> {
  return Object.fromEntries(Object.entries(config.agents).sort(([left], [right]) => left.localeCompare(right)).map(([name, agent]) => {
    const adapter = getAdapterDescriptor(name, agent);
    return [name, adapter ? {
      id: adapter.id,
      supports_model_override: adapter.supports_model_override,
      model_flags: [...adapter.model_flags],
      prompt_value_flags: [...adapter.prompt_value_flags],
      settings_isolation: adapter.settings_isolation ?? null,
      template_revision: adapter.template_revision,
    } : null];
  }));
}

export function validateRequestedModel(value: unknown, field = "requested_model"): string {
  if (typeof value !== "string") {
    throw modelInputError("invalid_model_argument", `${field} must be a non-empty string.`);
  }
  const model = value.trim();
  if (!model || model.length > MODEL_ID_MAX_LENGTH || !MODEL_ID_PATTERN.test(model)) {
    throw modelInputError(
      "invalid_model_argument",
      `${field} must be 1-${MODEL_ID_MAX_LENGTH} characters and contain only model identifier characters.`,
    );
  }
  return model;
}

export function optionalModel(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  return validateRequestedModel(value, field);
}

export function extractConfiguredModelArgument(agent: AgentConfig): string | null {
  const descriptor = getAdapterDescriptor("", agent);
  const flags = new Set(descriptor?.model_flags || ["--model", "-m"]);
  const values: string[] = [];
  for (let index = 0; index < agent.args.length; index += 1) {
    const arg = agent.args[index];
    const inlineFlag = [...flags].find((flag) => arg.startsWith(`${flag}=`));
    if (inlineFlag) {
      values.push(validateRequestedModel(arg.slice(inlineFlag.length + 1), "model argument"));
      continue;
    }
    if (flags.has(arg)) {
      const value = agent.args[index + 1];
      if (typeof value === "string" && value) values.push(validateRequestedModel(value, "model argument"));
      index += 1;
    }
  }
  const unique = [...new Set(values)];
  if (unique.length > 1) {
    throw new Error("Managed Agent has conflicting model arguments.");
  }
  return unique[0] || null;
}

export function resolveTaskModelSelection(input: {
  agentName: string;
  requestedAgent?: string | null;
  selectedAgent?: string;
  requestedModel?: unknown;
  repoPath: string;
  repoDefaultsPath?: string;
  config: PatchWardenConfig;
  agentConfigRevision: string;
  agentFallbackUsed?: boolean;
}): ModelSelectionEvidence {
  const agent = input.config.agents[input.agentName];
  if (!agent) throw new Error(`Agent "${input.agentName}" is not configured.`);
  const adapter = getAdapterDescriptor(input.agentName, agent);
  const requestedModel = input.requestedModel === undefined || input.requestedModel === null
    ? null
    : validateRequestedModel(input.requestedModel);
  if (requestedModel && !adapter?.supports_model_override) {
    throw modelInputError("model_override_not_supported", `Agent "${input.agentName}" does not support model overrides.`);
  }

  const availableModels = agent.available_models ?? [];
  if (
    requestedModel
    && availableModels.length > 0
    && agent.allow_unlisted_model_override === false
    && !availableModels.includes(requestedModel)
  ) {
    throw modelInputError("model_not_allowed", `Model "${requestedModel}" is not allowed for Agent "${input.agentName}".`);
  }

  const projectDefault = getRepoAgentDefault(
    input.config,
    input.repoDefaultsPath ?? input.repoPath,
    input.agentName,
  );
  const metadataDefault = agent.default_model
    ?? optionalModel(agent.model, `agents["${input.agentName}"].model`);
  const argumentDefault = extractConfiguredModelArgument(agent);
  if (metadataDefault && argumentDefault && metadataDefault !== argumentDefault) {
    throw new Error(`Managed Agent "${input.agentName}" model metadata does not match its CLI argument.`);
  }
  const globalDefault = metadataDefault ?? argumentDefault;
  const configuredDefault = projectDefault ?? globalDefault;
  const effectiveModel = requestedModel ?? configuredDefault;
  const modelSource: ModelSource = requestedModel
    ? "task_override"
    : configuredDefault
      ? "agent_config_default"
      : "agent_default_unobserved";
  const provider = resolveProvider(agent, effectiveModel);
  const agentFallbackUsed = input.agentFallbackUsed === true;

  return {
    requested_agent: String(input.requestedAgent ?? input.agentName).slice(0, 120),
    selected_agent: String(input.selectedAgent || input.agentName).slice(0, 120),
    requested_model: requestedModel,
    configured_default_model: configuredDefault,
    effective_model: effectiveModel,
    model_source: modelSource,
    provider,
    model_argument_present: effectiveModel !== null,
    agent_config_revision: input.agentConfigRevision,
    fallback_used: agentFallbackUsed,
    agent_fallback_used: agentFallbackUsed,
    model_fallback_used: false,
  };
}

export function applyAdapterInvocationArgs(
  agentName: string,
  agent: AgentConfig,
  effectiveModel: string | null,
  requestedModel: string | null = null,
): string[] {
  const descriptor = getAdapterDescriptor(agentName, agent);
  if (!descriptor) {
    if (requestedModel) {
      throw modelInputError("model_override_not_supported", `Agent "${agentName}" does not support model overrides.`);
    }
    return [...agent.args];
  }

  const flags = new Set(descriptor.model_flags);
  const output: string[] = [];
  for (let index = 0; index < agent.args.length; index += 1) {
    const arg = agent.args[index];
    if ([...flags].some((flag) => arg.startsWith(`${flag}=`))) {
      continue;
    }
    if (flags.has(arg)) {
      index += 1;
      continue;
    }
    if (descriptor.settings_isolation && agent.settings_policy === "isolated") {
      if (arg === "--setting-sources") {
        index += 1;
        continue;
      }
      if (arg.startsWith("--setting-sources=")) continue;
    }
    output.push(arg);
  }

  const additions: string[] = [];
  if (descriptor.settings_isolation && agent.settings_policy === "isolated") {
    additions.push("--setting-sources", "");
  }
  if (effectiveModel) additions.push("--model", effectiveModel);
  const promptIndex = output.indexOf("{prompt}");
  if (promptIndex < 0) return [...output, ...additions];
  const insertionIndex = promptIndex > 0 && descriptor.prompt_value_flags.includes(output[promptIndex - 1])
    ? promptIndex - 1
    : promptIndex;
  return [...output.slice(0, insertionIndex), ...additions, ...output.slice(insertionIndex)];
}

export function sanitizeModelSelectionEvidence(value: unknown): ModelSelectionEvidence | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const revision = typeof record.agent_config_revision === "string" ? record.agent_config_revision.slice(0, 64) : "";
  if (!/^[a-f0-9]{64}$/i.test(revision)) return null;
  const source = typeof record.model_source === "string" && new Set<ModelSource>([
    "task_override", "agent_config_default", "provider_default", "agent_default_unobserved", "fallback",
  ]).has(record.model_source as ModelSource)
    ? record.model_source as ModelSource
    : "agent_default_unobserved";
  const requestedModel = safeModel(record.requested_model);
  const configuredDefault = safeModel(record.configured_default_model);
  const effectiveModel = safeModel(record.effective_model);
  const agentFallbackUsed = record.agent_fallback_used === true || record.fallback_used === true;
  return {
    requested_agent: typeof record.requested_agent === "string" ? record.requested_agent.slice(0, 120) : "",
    selected_agent: typeof record.selected_agent === "string" ? record.selected_agent.slice(0, 120) : "",
    requested_model: requestedModel,
    configured_default_model: configuredDefault,
    effective_model: effectiveModel,
    model_source: source,
    provider: typeof record.provider === "string" ? record.provider.slice(0, 80) : null,
    model_argument_present: record.model_argument_present === true,
    agent_config_revision: revision,
    fallback_used: agentFallbackUsed,
    agent_fallback_used: agentFallbackUsed,
    model_fallback_used: record.model_fallback_used === true,
  };
}

function safeModel(value: unknown): string | null {
  return typeof value === "string" && MODEL_ID_PATTERN.test(value) ? value.slice(0, MODEL_ID_MAX_LENGTH) : null;
}

function getRepoAgentDefault(config: PatchWardenConfig, repoPath: string, agentName: string): string | null {
  const target = comparablePath(resolve(repoPath));
  const workspaceRoot = typeof config.workspaceRoot === "string" && config.workspaceRoot ? config.workspaceRoot : repoPath;
  for (const [repoKey, defaults] of Object.entries(config.repoAgentDefaults || {})) {
    if (comparablePath(resolve(workspaceRoot, repoKey)) !== target) continue;
    return defaults[agentName] ?? null;
  }
  return null;
}

export function normalizeRepoAgentDefaults(
  value: unknown,
  workspaceRoot: string,
): Record<string, Record<string, string | null>> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("repoAgentDefaults must map workspace-relative repository paths to Agent model defaults");
  }
  const output: Record<string, Record<string, string | null>> = {};
  for (const [repoKey, rawDefaults] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = normalizeRepoKey(repoKey);
    const resolvedRepo = resolve(workspaceRoot, normalizedKey);
    const relativeRepo = relative(resolve(workspaceRoot), resolvedRepo);
    if (isAbsolute(repoKey) || relativeRepo === ".." || relativeRepo.startsWith(`..${sep}`) || isAbsolute(relativeRepo)) {
      throw new Error(`repoAgentDefaults key must stay inside workspaceRoot: "${repoKey}"`);
    }
    if (!rawDefaults || typeof rawDefaults !== "object" || Array.isArray(rawDefaults)) {
      throw new Error(`repoAgentDefaults["${repoKey}"] must map Agent names to model identifiers`);
    }
    output[normalizedKey] = Object.fromEntries(Object.entries(rawDefaults as Record<string, unknown>).map(([agent, model]) => [
      agent,
      model === null ? null : validateRequestedModel(model, `repoAgentDefaults["${repoKey}"]["${agent}"]`),
    ]));
  }
  return output;
}

function resolveProvider(agent: AgentConfig, model: string | null): string | null {
  if (typeof agent.provider === "string" && agent.provider.trim()) return agent.provider.trim().slice(0, 80);
  if (model?.includes("/")) return model.split("/", 1)[0].slice(0, 80) || null;
  return null;
}

function modelInputError(reason: string, message: string): PatchWardenError {
  return new PatchWardenError(reason, message, "Choose a valid model for the explicitly selected Agent.");
}

function normalizeRepoKey(value: string): string {
  const trimmed = String(value).trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
  return trimmed === "" ? "." : trimmed;
}

function comparablePath(value: string): string {
  const normalized = resolve(value).replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
