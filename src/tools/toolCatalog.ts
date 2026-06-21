import { createHash } from "node:crypto";
import { SAFE_BIFROST_VERSION, TOOL_SCHEMA_EPOCH } from "../version.js";

export type ToolProfile = "full" | "chatgpt_core";

export interface CatalogTool {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface ToolCatalogSnapshot {
  server_version: string;
  schema_epoch: string;
  tool_profile: ToolProfile;
  tool_count: number;
  tool_names: string[];
  tool_manifest_sha256: string;
}

export const CHATGPT_CORE_TOOL_NAMES = [
  "health_check",
  "list_agents",
  "list_workspace",
  "read_workspace_file",
  "save_plan",
  "create_task",
  "wait_for_task",
  "get_task_summary",
  "get_diff",
  "get_result",
  "get_result_json",
  "get_test_log",
  "get_task_status",
  "list_tasks",
  "cancel_task",
  "audit_task",
] as const;

let lastSnapshot: ToolCatalogSnapshot | null = null;

export function resolveToolProfile(configProfile?: string): ToolProfile {
  const raw = (process.env.SAFE_BIFROST_TOOL_PROFILE || configProfile || "full").trim();
  if (raw !== "full" && raw !== "chatgpt_core") {
    throw new Error(`Invalid tool profile "${raw}". Expected "full" or "chatgpt_core".`);
  }
  return raw;
}

export function selectToolsForProfile<T extends CatalogTool>(tools: T[], profile: ToolProfile): T[] {
  if (profile === "full") return tools;
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return CHATGPT_CORE_TOOL_NAMES.map((name) => {
    const tool = byName.get(name);
    if (!tool) throw new Error(`chatgpt_core tool profile requires missing tool "${name}".`);
    return tool;
  });
}

export function buildToolCatalogSnapshot(tools: CatalogTool[], profile: ToolProfile): ToolCatalogSnapshot {
  const manifestInput = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
  const tool_manifest_sha256 = createHash("sha256")
    .update(stableJson(manifestInput))
    .digest("hex");
  lastSnapshot = {
    server_version: SAFE_BIFROST_VERSION,
    schema_epoch: TOOL_SCHEMA_EPOCH,
    tool_profile: profile,
    tool_count: tools.length,
    tool_names: tools.map((tool) => tool.name),
    tool_manifest_sha256,
  };
  return lastSnapshot;
}

export function getLastToolCatalogSnapshot(): ToolCatalogSnapshot | null {
  return lastSnapshot ? { ...lastSnapshot, tool_names: [...lastSnapshot.tool_names] } : null;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
