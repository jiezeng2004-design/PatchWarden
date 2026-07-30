import { validateModelId } from "./agent-adapters.js";

export type ModelProbeRequestAgent = "codex" | "opencode" | "claude";

export interface ModelProbeRequest {
  readonly agentId: ModelProbeRequestAgent;
  readonly modelId: string;
}

/** Parse the exact renderer contract; commands, paths, environment and prompts are never accepted. */
export function parseModelProbeRequest(value: unknown): ModelProbeRequest | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes("agentId") || !keys.includes("modelId")) return null;
  if (value.agentId !== "codex" && value.agentId !== "opencode" && value.agentId !== "claude") return null;
  try {
    const modelId = validateModelId(value.modelId);
    return modelId ? { agentId: value.agentId, modelId } : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

