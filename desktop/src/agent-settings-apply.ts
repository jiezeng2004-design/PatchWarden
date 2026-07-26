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

/** Match Core's normalized Agent-only revision without hashing unrelated config. */
export function computeAgentConfigRevision(agentsValue: unknown): string {
  const agents = isRecord(agentsValue) ? agentsValue : {};
  const normalized = Object.fromEntries(Object.entries(agents).map(([name, value]) => {
    const agent = isRecord(value) ? value : {};
    const envAllowlist = Array.isArray(agent.envAllowlist)
      ? [...new Set(agent.envAllowlist.filter((entry): entry is string => typeof entry === "string"))]
      : [];
    return [name, {
      ...agent,
      args: Array.isArray(agent.args) ? [...agent.args] : agent.args,
      envAllowlist,
    }];
  }));
  return createHash("sha256").update(stableJsonStringify(normalized)).digest("hex");
}

function stableJsonStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJsonStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as JsonRecord).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJsonStringify(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
