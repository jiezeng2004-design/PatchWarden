import { getConfig } from "../config.js";
import {
  listAllTasks,
  type ListTasksOutput,
} from "../tools/tasks/listTasks.js";
import type { TaskHistoryState } from "../tools/tasks/taskHistory.js";

const DEFAULT_TTL_MS = 1_500;
const MAX_CACHE_ENTRIES = 64;

interface CacheEntry<T> {
  expires_at: number;
  value: T;
}

const cache = new Map<string, CacheEntry<unknown>>();

/**
 * Reuse bounded read-only Control Center snapshots for a short interval.
 * This prevents one dashboard refresh from scanning the same task/evidence
 * directories several times while keeping mutations visible almost
 * immediately. State-writing requests clear the cache in server.ts.
 */
export function getCachedControlData<T>(
  key: string,
  load: () => T,
  ttlMs = DEFAULT_TTL_MS,
  nowMs = Date.now(),
): T {
  const current = cache.get(key) as CacheEntry<T> | undefined;
  if (current && current.expires_at > nowMs) return current.value;

  const value = load();
  cache.delete(key);
  cache.set(key, { value, expires_at: nowMs + Math.max(1, ttlMs) });
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return value;
}

export function getControlTaskSnapshot(
  historyState: TaskHistoryState | "all" = "active",
): ListTasksOutput {
  const config = getConfig();
  const key = [
    "tasks",
    config.workspaceRoot,
    config.tasksDir,
    historyState,
  ].join("\u0000");
  return getCachedControlData(key, () => listAllTasks({ history_state: historyState }));
}

export function clearControlDataCache(): void {
  cache.clear();
}
