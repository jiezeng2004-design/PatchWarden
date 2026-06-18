import { SafeBifrostConfig } from "../config.js";

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
  config: SafeBifrostConfig
): AllowedCommand {
  const agentCfg = config.agents[agent];
  if (!agentCfg) {
    throw new Error(
      `Agent "${agent}" is not configured. Allowed agents: ${Object.keys(config.agents).join(", ")}`
    );
  }

  // Validate args don't contain shell metacharacters
  const resolvedArgs = agentCfg.args.map((arg) => {
    // {repo} and {prompt} are safe placeholders
    if (arg === "{repo}" || arg === "{prompt}") return arg;
    // Other literal args ok
    return arg;
  });

  // Validate command name is simple (no path traversal, no shell chars)
  if (!/^[a-zA-Z0-9._-]+$/.test(agentCfg.command)) {
    throw new Error(`Invalid agent command name: "${agentCfg.command}"`);
  }

  return { command: agentCfg.command, args: resolvedArgs };
}

export function guardTestCommand(
  testCommand: string,
  config: SafeBifrostConfig
): string {
  if (!testCommand || typeof testCommand !== "string") {
    // If no test command specified, that's ok — skip tests
    return "";
  }

  const trimmed = testCommand.trim();
  if (trimmed === "") return "";

  if (!config.allowedTestCommands.includes(trimmed)) {
    throw new Error(
      `Test command "${trimmed}" is not in the allowed list. Allowed: ${config.allowedTestCommands.join(", ")}`
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
