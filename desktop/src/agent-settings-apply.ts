import { createHash } from "node:crypto";

export interface AgentSettingSelection {
  readonly id: string;
  readonly enabled?: boolean;
  readonly model?: string | null;
}

export interface AgentSettingsApplication {
  readonly applied: boolean;
  readonly reason: "applied" | "backend_unavailable" | "backend_stale";
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Compare Desktop selections with the Agent view loaded by the running Core. */
export function evaluateAgentSettingsApplication(
  selections: readonly AgentSettingSelection[],
  expectedRevision: string,
  workspaceResponse: unknown,
): AgentSettingsApplication {
  if (!isRecord(workspaceResponse) || !Array.isArray(workspaceResponse.agents)) {
    return { applied: false, reason: "backend_unavailable" };
  }
  const actual = new Map<string, JsonRecord>();
  for (const value of workspaceResponse.agents) {
    if (isRecord(value) && typeof value.name === "string") actual.set(value.name, value);
  }
  for (const selection of selections) {
    const loaded = actual.get(selection.id);
    if (selection.enabled === false) {
      if (loaded) return { applied: false, reason: "backend_stale" };
      continue;
    }
    const expectedModel = typeof selection.model === "string" && selection.model.trim()
      ? selection.model.trim()
      : null;
    if (!loaded || (loaded.model ?? null) !== expectedModel || loaded.invocation_ready !== true) {
      return { applied: false, reason: "backend_stale" };
    }
    if (loaded.agent_config_revision !== expectedRevision) {
      return { applied: false, reason: "backend_stale" };
    }
  }
  return { applied: true, reason: "applied" };
}

const ADAPTER_TEMPLATES: Readonly<Record<string, Readonly<Record<string, unknown>>>> = Object.freeze({
  codex: template("codex", "codex-model-v1"),
  claude: template("claude", "claude-model-settings-v2", "claude_empty_sources"),
  opencode: template("opencode", "opencode-model-v1"),
  gemini: template("gemini", "gemini-model-v1"),
  copilot: template("copilot", "copilot-model-v1"),
  qwen: template("qwen", "qwen-model-v1"),
  kimi: template("kimi", "kimi-model-v1"),
  aider: template("aider", "aider-model-v1"),
});

/** Match Core's normalized Agent/project-default/template revision without hashing unrelated config. */
export function computeAgentConfigRevision(configValue: unknown): string {
  const config = isRecord(configValue) && isRecord(configValue.agents)
    ? configValue
    : { agents: isRecord(configValue) ? configValue : {} };
  const agentsValue = isRecord(config.agents) ? config.agents : {};
  const agents = normalizeAgents(agentsValue);
  const repoAgentDefaults = normalizeRepoAgentDefaults(config.repoAgentDefaults);
  const adapterTemplates = Object.fromEntries(Object.entries(agents).sort(([left], [right]) => left.localeCompare(right)).map(([name, value]) => {
    const agent = isRecord(value) ? value : {};
    const adapter = typeof agent.adapter === "string" && agent.adapter.trim() ? agent.adapter.trim() : name;
    return [name, ADAPTER_TEMPLATES[adapter] || null];
  }));
  return createHash("sha256").update(stableJsonStringify({
    agents,
    repoAgentDefaults,
    adapter_templates: adapterTemplates,
  })).digest("hex");
}

function normalizeAgents(agentsValue: JsonRecord): JsonRecord {
  const normalized = Object.fromEntries(Object.entries(agentsValue).map(([name, value]) => {
    const agent = isRecord(value) ? value : {};
    const envAllowlist = Array.isArray(agent.envAllowlist)
      ? [...new Set(agent.envAllowlist.filter((entry): entry is string => typeof entry === "string"))]
      : [];
    const argumentModel = readModelArgument(agent.args);
    const defaultModel = cleanString(agent.default_model) ?? cleanString(agent.model) ?? argumentModel;
    return [name, {
      ...agent,
      args: Array.isArray(agent.args) ? [...agent.args] : agent.args,
      envAllowlist,
      ...(agent.provider === undefined ? {} : { provider: cleanString(agent.provider) }),
      default_model: defaultModel,
      available_models: Array.isArray(agent.available_models)
        ? [...new Set(agent.available_models.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()))]
        : [],
      allow_unlisted_model_override: agent.allow_unlisted_model_override !== false,
      settings_policy: agent.settings_policy === "isolated" ? "isolated" : "inherit",
    }];
  }));
  return normalized;
}

function normalizeRepoAgentDefaults(value: unknown): JsonRecord {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([repo, defaults]) => {
    const key = repo.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "") || ".";
    return [key, isRecord(defaults)
      ? Object.fromEntries(Object.entries(defaults).map(([agent, model]) => [
          agent,
          model === null ? null : cleanString(model),
        ]))
      : {}];
  }));
}

function readModelArgument(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "--model" || value[index] === "-m") return cleanString(value[index + 1]);
  }
  return null;
}

function cleanString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function template(id: string, templateRevision: string, settingsIsolation?: string): Readonly<Record<string, unknown>> {
  return Object.freeze({
    id,
    supports_model_override: true,
    model_flags: ["--model", "-m"],
    settings_isolation: settingsIsolation ?? null,
    template_revision: templateRevision,
  });
}

function stableJsonStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJsonStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as JsonRecord).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJsonStringify(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
