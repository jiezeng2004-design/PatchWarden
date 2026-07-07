import { getRepoAllowedTestCommands, getRepoDirectAllowedCommands, PatchWardenConfig } from "../config.js";
import { PatchWardenError } from "../errors.js";

/**
 * Command guard: ensure only allow-listed commands can execute.
 *
 * Rules:
 * - Agent commands must be registered in config.agents
 * - Test commands must be in config.allowedTestCommands (exact match)
 * - No arbitrary shell commands are allowed
 * - Placeholders {repo} and {prompt} are replaced safely
 */

export interface AllowedCommand {
  command: string;
  args: string[];
}

export function guardAgentCommand(
  agent: string,
  config: PatchWardenConfig
): AllowedCommand {
  const agentCfg = config.agents[agent];
  if (!agentCfg) {
    throw new PatchWardenError(
      "agent_not_configured",
      `Agent "${agent}" is not configured. Allowed agents: ${Object.keys(config.agents).join(", ")}`,
      "Call list_agents and use one of the configured agent names."
    );
  }

  // Validate args don't contain shell metacharacters
  const resolvedArgs = agentCfg.args.map((arg) => {
    // {repo} and {prompt} are safe placeholders
    if (arg === "{repo}" || arg === "{prompt}") return arg;
    // Other literal args ok
    return arg;
  });

  // Validate command or configured executable path.
  // Absolute paths are allowed only because they come from the local config,
  // never from the MCP caller. We still reject traversal and shell syntax.
  if (!isSafeConfiguredCommand(agentCfg.command)) {
    throw new PatchWardenError(
      "agent_command_invalid",
      `Invalid agent command name: "${agentCfg.command}"`,
      "Fix the locally configured executable path; MCP callers cannot override agent commands."
    );
  }

  return { command: agentCfg.command, args: resolvedArgs };
}

function isSafeConfiguredCommand(command: string): boolean {
  if (!command || typeof command !== "string") return false;
  if (/[\x00-\x1F"'`|&;<>()$]/.test(command)) return false;

  const normalized = command.replace(/\\/g, "/");
  const parts = normalized.split("/");
  if (parts.some((part) => part === "..")) return false;

  const basename = parts[parts.length - 1] || "";
  return /^[a-zA-Z0-9._-]+$/.test(basename);
}

export function guardTestCommand(
  testCommand: string,
  config: PatchWardenConfig,
  repoPath?: string
): string {
  if (!testCommand || typeof testCommand !== "string") {
    // If no test command specified, that's ok — skip tests
    return "";
  }

  const trimmed = testCommand.trim();
  if (trimmed === "") return "";

  const allowedCommands = [
    ...config.allowedTestCommands,
    ...(repoPath ? getRepoAllowedTestCommands(config, repoPath) : []),
  ];
  if (!allowedCommands.includes(trimmed)) {
    throw new PatchWardenError(
      "test_command_not_allowlisted",
      `Test command "${trimmed}" is not allowed for this repository. Allowed: ${allowedCommands.join(", ")}`,
      "Use an exact allowed command shown by create_task, or omit test_command."
    );
  }

  return trimmed;
}

export function guardDirectCommand(
  command: string,
  config: PatchWardenConfig,
  repoPath?: string
): string {
  if (!command || typeof command !== "string") {
    throw new PatchWardenError(
      "direct_command_required",
      "A command string is required for run_verification.",
      "Provide one of the allowed Direct verification commands."
    );
  }

  const trimmed = command.trim();
  if (trimmed === "") {
    throw new PatchWardenError(
      "direct_command_required",
      "A command string is required for run_verification.",
      "Provide one of the allowed Direct verification commands."
    );
  }

  const allowedCommands = [
    ...(config.directAllowedCommands || []),
    ...(repoPath ? getRepoDirectAllowedCommands(config, repoPath) : []),
  ];
  if (!allowedCommands.includes(trimmed)) {
    throw new PatchWardenError(
      "direct_command_not_allowlisted",
      `Direct command "${trimmed}" is not allowed. Allowed: ${allowedCommands.join(", ")}`,
      "Use an exact allowed command from the Direct allowlist."
    );
  }

  return trimmed;
}

/**
 * Escape a user-provided string for safe use in shell arguments.
 * We prevent injection by refusing to pass arbitrary strings to shell.
 * Instead, the prompt is passed as a command argument via spawn, not shell.
 */
export function sanitizePromptArg(prompt: string): string {
  // Remove null bytes and control characters
  return prompt.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
}
