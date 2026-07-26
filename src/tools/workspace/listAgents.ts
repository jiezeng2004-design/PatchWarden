import { existsSync, statSync } from "node:fs";
import { basename, delimiter, extname, isAbsolute, join, resolve } from "node:path";
import { getAgentRuntimeMetadata, refreshAgentConfig } from "../../config.js";
import { sanitizeTrustedPath } from "../../runner/processSecurity.js";
import {
  assertConfiguredNodeLaunch,
  resolveAgentLaunch,
  resolveConfiguredNativeAgentLaunch,
} from "../../runner/agentInvocation.js";

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
  agent_config_revision: string;
}

export function listAgents(): { agents: AgentAvailability[]; total: number; config_path: string; workspace_root: string } {
  const config = refreshAgentConfig();
  const checkedAt = new Date().toISOString();
  const configPath = process.env.PATCHWARDEN_CONFIG
    ? resolve(process.env.PATCHWARDEN_CONFIG)
    : resolve(process.cwd(), "patchwarden.config.json");
  const agents = Object.entries(config.agents)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, agent]) => {
      const available = commandExists(agent.command, config.workspaceRoot);
      const runtime = getAgentRuntimeMetadata(name, config);
      const modelArgumentPresent = runtime.model_argument_present;
      const launch = validateInvocationLaunch(name, agent.command, agent.args, agent.adapter || name, config.workspaceRoot);
      const modelReady = runtime.effective_model === null || modelArgumentPresent;
      const invocationReady = available && modelReady && launch.ready;
      return {
        name,
        configured: true as const,
        available,
        command: basename(agent.command),
        reason: !available
          ? "Configured executable was not found on disk or PATH."
          : launch.reason,
        checked_at: checkedAt,
        adapter: runtime.adapter,
        model: runtime.effective_model,
        capabilities: { model_override: runtime.adapter !== null },
        availability_scope: "executable_only" as const,
        provider_status: "not_checked" as const,
        invocation_ready: invocationReady,
        model_argument_present: modelArgumentPresent,
        agent_config_revision: runtime.agent_config_revision,
      };
    });
  return { agents, total: agents.length, config_path: configPath, workspace_root: config.workspaceRoot };
}

function validateInvocationLaunch(
  name: string,
  command: string,
  args: readonly string[],
  adapter: string,
  workspaceRoot: string,
): { ready: boolean; reason: string | null } {
  try {
    const configuredNative = resolveConfiguredNativeAgentLaunch(name, adapter, command, args);
    assertConfiguredNodeLaunch(name, command, args, configuredNative);
    if (!configuredNative) {
      resolveAgentLaunch(name, command, process.platform, process.env.PATH || "", existsSync, workspaceRoot, adapter);
    }
    return { ready: true, reason: null };
  } catch (error) {
    return {
      ready: false,
      reason: error instanceof Error ? error.message.slice(0, 240) : "Configured Agent launch is invalid.",
    };
  }
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
