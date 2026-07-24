import { existsSync, statSync } from "node:fs";
import { basename, delimiter, extname, isAbsolute, join, resolve } from "node:path";
import { getConfig } from "../../config.js";
import { sanitizeTrustedPath } from "../../runner/processSecurity.js";

export interface AgentAvailability {
  name: string;
  configured: true;
  available: boolean;
  command: string;
  reason: string | null;
  checked_at: string;
  adapter: string | null;
  model: string | null;
  capabilities: { model_override: boolean };
  availability_scope: "executable_only";
  provider_status: "not_checked";
  invocation_ready?: boolean;
  model_argument_present?: boolean;
}

export function listAgents(): { agents: AgentAvailability[]; total: number; config_path: string; workspace_root: string } {
  const config = getConfig();
  const checkedAt = new Date().toISOString();
  const configPath = process.env.PATCHWARDEN_CONFIG
    ? resolve(process.env.PATCHWARDEN_CONFIG)
    : resolve(process.cwd(), "patchwarden.config.json");
  const agents = Object.entries(config.agents)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, agent]) => {
      const available = commandExists(agent.command, config.workspaceRoot);
      const modelArgumentPresent = typeof agent.model === "string"
        ? agent.args.some((arg, index) => arg === "--model" && agent.args[index + 1] === agent.model)
        : true;
      return {
        name,
        configured: true as const,
        available,
        command: basename(agent.command),
        reason: available ? null : "Configured executable was not found on disk or PATH.",
        checked_at: checkedAt,
        adapter: typeof agent.adapter === "string" ? agent.adapter : ["codex", "opencode"].includes(name) ? name : null,
        model: typeof agent.model === "string" ? agent.model : null,
        capabilities: { model_override: typeof agent.adapter === "string" || ["codex", "opencode"].includes(name) },
        availability_scope: "executable_only" as const,
        provider_status: "not_checked" as const,
        invocation_ready: available && modelArgumentPresent,
        model_argument_present: modelArgumentPresent,
      };
    });
  return { agents, total: agents.length, config_path: configPath, workspace_root: config.workspaceRoot };
}

function commandExists(command: string, workspaceRoot: string): boolean {
  if (isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    return isFile(command);
  }

  const pathEntries = sanitizeTrustedPath(process.env.PATH || "", workspaceRoot).split(delimiter).filter(Boolean);
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
