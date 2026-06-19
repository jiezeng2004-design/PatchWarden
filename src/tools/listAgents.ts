import { existsSync, statSync } from "node:fs";
import { basename, delimiter, extname, isAbsolute, join } from "node:path";
import { getConfig } from "../config.js";

export interface AgentAvailability {
  name: string;
  configured: true;
  available: boolean;
  command: string;
  reason: string | null;
  checked_at: string;
}

export function listAgents(): { agents: AgentAvailability[]; total: number } {
  const config = getConfig();
  const checkedAt = new Date().toISOString();
  const agents = Object.entries(config.agents)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, agent]) => {
      const available = commandExists(agent.command);
      return {
        name,
        configured: true as const,
        available,
        command: basename(agent.command),
        reason: available ? null : "Configured executable was not found on disk or PATH.",
        checked_at: checkedAt,
      };
    });
  return { agents, total: agents.length };
}

function commandExists(command: string): boolean {
  if (isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    return isFile(command);
  }

  const pathEntries = (process.env.PATH || "").split(delimiter).filter(Boolean);
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  const candidates = extname(command)
    ? pathEntries.map((entry) => join(entry, command))
    : pathEntries.flatMap((entry) => extensions.map((extension) => join(entry, `${command}${extension}`)));
  return candidates.some(isFile);
}

function isFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}
