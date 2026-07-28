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

function expectedModel(selection: AgentSettingSelection): string | null {
  return typeof selection.model === "string" && selection.model.trim()
    ? selection.model.trim()
    : null;
}

function isRevision(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

/**
 * Compare Desktop selections with the configuration Core has actually loaded.
 * Core owns the canonical revision algorithm; Desktop only verifies the live
 * model and invocation contract returned by /api/workspace.
 */
export function evaluateAgentSettingsApplication(
  selections: readonly AgentSettingSelection[],
  workspaceResponse: unknown,
): AgentSettingsApplication {
  if (!isRecord(workspaceResponse) || !Array.isArray(workspaceResponse.agents)) {
    return { applied: false, reason: "backend_unavailable" };
  }
  const actual = new Map<string, JsonRecord>();
  for (const value of workspaceResponse.agents) {
    if (isRecord(value) && typeof value.name === "string") actual.set(value.name, value);
  }

  const revisions = new Set<string>();
  for (const selection of selections) {
    const loaded = actual.get(selection.id);
    if (selection.enabled === false) {
      if (loaded) return { applied: false, reason: "backend_stale" };
      continue;
    }
    if (!loaded
      || loaded.effective_model !== expectedModel(selection)
      || loaded.invocation_ready !== true
      || !isRevision(loaded.agent_config_revision)) {
      return { applied: false, reason: "backend_stale" };
    }
    revisions.add(loaded.agent_config_revision);
  }
  if (revisions.size > 1) return { applied: false, reason: "backend_stale" };
  return { applied: true, reason: "applied" };
}
