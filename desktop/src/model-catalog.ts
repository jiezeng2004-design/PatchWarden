import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { atomicWriteJson, readJson } from "./config-store.js";
import { validateModelId } from "./agent-adapters.js";
import type { AgentDetection, DiscoveredModel } from "./agent-adapters.js";

const CACHE_SCHEMA_VERSION = 1;
const MAX_CACHE_ENTRIES = 32;
const MAX_MODELS_PER_ENTRY = 256;
export const MODEL_CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1000;

export type PrimaryModelAgent = "codex" | "opencode" | "claude";
export type ModelCatalogStrategy = "config_only" | "opencode_cli";
export type ModelCatalogState = "not_checked" | "cached" | "fresh" | "empty" | "unavailable" | "unsupported";
export type ModelCatalogReason =
  | "ok"
  | "catalog_empty"
  | "agent_unavailable"
  | "refresh_unsupported"
  | "refresh_timed_out"
  | "refresh_failed"
  | "cache_unavailable";

export interface ModelCatalogCacheEntry {
  readonly agentId: PrimaryModelAgent;
  readonly workspaceKey: string;
  readonly executableFingerprint: string;
  readonly models: readonly DiscoveredModel[];
  readonly state: "fresh" | "empty";
  readonly reasonCode: "ok" | "catalog_empty";
  readonly refreshedAt: string;
}

interface ModelCatalogCacheFile {
  readonly schemaVersion: number;
  readonly entries: readonly ModelCatalogCacheEntry[];
}

export function isPrimaryModelAgent(id: string): id is PrimaryModelAgent {
  return id === "codex" || id === "opencode" || id === "claude";
}

export function modelCatalogStrategy(id: string): ModelCatalogStrategy {
  return id === "opencode" ? "opencode_cli" : "config_only";
}

export function workspaceCatalogKey(workspaceRoot: string): string {
  return fingerprint(resolve(workspaceRoot));
}

export function executableCatalogFingerprint(detection: Pick<AgentDetection, "command" | "prefixArgs" | "executablePath">): string {
  const command = detection.executablePath || detection.command || "";
  let metadata = "missing";
  try {
    if (command && existsSync(command)) {
      const stat = statSync(command);
      metadata = `${stat.size}:${Math.trunc(stat.mtimeMs)}`;
    }
  } catch {
    metadata = "unavailable";
  }
  return fingerprint([command, ...(detection.prefixArgs || []), metadata].join("\0"));
}

export function findModelCatalogCache(
  cachePath: string,
  agentId: string,
  workspaceRoot: string,
  detection: Pick<AgentDetection, "command" | "prefixArgs" | "executablePath">,
  nowMs: number = Date.now(),
): ModelCatalogCacheEntry | null {
  if (!isPrimaryModelAgent(agentId)) return null;
  const workspaceKey = workspaceCatalogKey(workspaceRoot);
  const executableFingerprint = executableCatalogFingerprint(detection);
  const entry = readCache(cachePath).entries.find((candidate) => (
    candidate.agentId === agentId
    && candidate.workspaceKey === workspaceKey
    && candidate.executableFingerprint === executableFingerprint
  )) || null;
  if (!entry) return null;
  const refreshedAt = Date.parse(entry.refreshedAt);
  const ageMs = nowMs - refreshedAt;
  return ageMs > MODEL_CATALOG_TTL_MS || ageMs < -MAX_FUTURE_CLOCK_SKEW_MS ? null : entry;
}

export function writeModelCatalogCache(
  cachePath: string,
  agentId: PrimaryModelAgent,
  workspaceRoot: string,
  detection: Pick<AgentDetection, "command" | "prefixArgs" | "executablePath">,
  models: readonly DiscoveredModel[],
): ModelCatalogCacheEntry {
  const normalizedModels = normalizeModels(models);
  const entry: ModelCatalogCacheEntry = {
    agentId,
    workspaceKey: workspaceCatalogKey(workspaceRoot),
    executableFingerprint: executableCatalogFingerprint(detection),
    models: normalizedModels,
    state: normalizedModels.length > 0 ? "fresh" : "empty",
    reasonCode: normalizedModels.length > 0 ? "ok" : "catalog_empty",
    refreshedAt: new Date().toISOString(),
  };
  const previous = readCache(cachePath);
  const entries = [
    entry,
    ...previous.entries.filter((candidate) => !sameEntry(candidate, entry)),
  ].slice(0, MAX_CACHE_ENTRIES);
  atomicWriteJson(cachePath, { schemaVersion: CACHE_SCHEMA_VERSION, entries }, false);
  return entry;
}

function readCache(cachePath: string): ModelCatalogCacheFile {
  const value = readJson(cachePath);
  if (!isRecord(value) || value.schemaVersion !== CACHE_SCHEMA_VERSION || !Array.isArray(value.entries)) {
    return { schemaVersion: CACHE_SCHEMA_VERSION, entries: [] };
  }
  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    entries: value.entries.map(normalizeEntry).filter((entry): entry is ModelCatalogCacheEntry => entry !== null),
  };
}

function normalizeEntry(value: unknown): ModelCatalogCacheEntry | null {
  if (!isRecord(value)) return null;
  const agentId = String(value.agentId);
  if (!isPrimaryModelAgent(agentId)) return null;
  if (typeof value.workspaceKey !== "string" || !/^[a-f0-9]{64}$/i.test(value.workspaceKey)) return null;
  if (typeof value.executableFingerprint !== "string" || !/^[a-f0-9]{64}$/i.test(value.executableFingerprint)) return null;
  if (!Array.isArray(value.models) || (value.state !== "fresh" && value.state !== "empty")) return null;
  if (value.reasonCode !== "ok" && value.reasonCode !== "catalog_empty") return null;
  if (typeof value.refreshedAt !== "string" || !Number.isFinite(Date.parse(value.refreshedAt))) return null;
  return {
    agentId,
    workspaceKey: value.workspaceKey,
    executableFingerprint: value.executableFingerprint,
    models: normalizeModels(value.models),
    state: value.state,
    reasonCode: value.reasonCode,
    refreshedAt: value.refreshedAt,
  };
}

function normalizeModels(values: readonly unknown[]): DiscoveredModel[] {
  const models = new Map<string, DiscoveredModel>();
  for (const value of values.slice(0, MAX_MODELS_PER_ENTRY)) {
    const rawId = isRecord(value) ? value.id : value;
    try {
      const id = validateModelId(rawId);
      if (id) models.set(id, { id, label: id, source: "Agent CLI cache" });
    } catch {
      // Invalid cache and CLI values are never surfaced to the renderer.
    }
  }
  return [...models.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function sameEntry(left: ModelCatalogCacheEntry, right: ModelCatalogCacheEntry): boolean {
  return left.agentId === right.agentId
    && left.workspaceKey === right.workspaceKey
    && left.executableFingerprint === right.executableFingerprint;
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

