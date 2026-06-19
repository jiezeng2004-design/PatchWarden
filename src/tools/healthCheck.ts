import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getConfig, getTasksDir } from "../config.js";
import { listAgents } from "./listAgents.js";

const SERVER_STARTED_AT = Date.now();

export function healthCheck() {
  const config = getConfig();
  const heartbeatFile = join(dirname(getTasksDir(config)), "watcher-heartbeat.json");
  let watcher: Record<string, unknown> = {
    available: false,
    reason: "Watcher heartbeat has not been observed. Start npm run watch.",
  };

  if (existsSync(heartbeatFile)) {
    try {
      const data = JSON.parse(readFileSync(heartbeatFile, "utf-8"));
      const ageMs = Date.now() - Date.parse(data.last_heartbeat_at || "");
      watcher = {
        available: Number.isFinite(ageMs) && ageMs < 15_000,
        last_heartbeat_at: data.last_heartbeat_at || null,
        heartbeat_age_seconds: Number.isFinite(ageMs) ? Math.max(0, Math.round(ageMs / 1000)) : null,
        reason: Number.isFinite(ageMs) && ageMs < 15_000 ? null : "Watcher heartbeat is stale.",
      };
    } catch {
      watcher = { available: false, reason: "Watcher heartbeat file is unreadable." };
    }
  }

  const agents = listAgents();
  return {
    status: watcher.available ? "healthy" : "degraded",
    mcp_server: {
      available: true,
      pid: process.pid,
      uptime_seconds: Math.round((Date.now() - SERVER_STARTED_AT) / 1000),
      checked_at: new Date().toISOString(),
    },
    watcher,
    agents: agents.agents,
  };
}
