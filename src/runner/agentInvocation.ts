import { existsSync, readFileSync } from "node:fs";
import { basename, win32 } from "node:path";
import { PatchWardenConfig } from "../config.js";
import { guardAgentCommand, sanitizePromptArg, type AllowedCommand } from "../security/commandGuard.js";
import { resolveTrustedExecutable, sanitizeTrustedPath } from "./processSecurity.js";

export interface AgentInvocation {
  command: string;
  args: string[];
  cwd: string;
  commandLabel: string;
  promptMode: "inline" | "file";
  promptFilePath?: string;
  environmentVariableNames: string[];
  blockedEnvironmentVariableNames: string[];
}

export interface ResolvedAgentLaunch {
  command: string;
  argsPrefix: string[];
}

const KNOWN_AGENT_NPM_PACKAGES: Readonly<Record<string, string>> = Object.freeze({
  codex: "@openai/codex",
  claude: "@anthropic-ai/claude-code",
  gemini: "@google/gemini-cli",
  copilot: "@github/copilot",
  qwen: "@qwen-code/qwen-code",
  opencode: "opencode-ai",
});

/**
 * Resolve the Windows npm shim used by OpenCode to its native executable.
 * Node cannot spawn .cmd/.ps1 shims directly with shell disabled (EINVAL), and
 * enabling a shell would make the task prompt part of shell parsing.
 */
export function resolveAgentExecutable(
  agentName: string,
  command: string,
  platform = process.platform,
  pathValue = process.env.PATH || "",
  fileExists: (path: string) => boolean = existsSync,
  cwd = process.cwd(),
): string {
  return resolveAgentLaunch(agentName, command, platform, pathValue, fileExists, cwd).command;
}

/** Resolve a configured Agent to a native executable or verified npm CLI. */
export function resolveAgentLaunch(
  agentName: string,
  command: string,
  platform = process.platform,
  pathValue = process.env.PATH || "",
  fileExists: (path: string) => boolean = existsSync,
  cwd = process.cwd(),
  adapterName = agentName,
  readText: (path: string) => string = (path) => readFileSync(path, "utf-8"),
): ResolvedAgentLaunch {
  if (platform !== "win32") return { command, argsPrefix: [] };

  const commandName = win32.basename(command).toLowerCase();
  if (adapterName === "opencode" && new Set(["opencode", "opencode.cmd", "opencode.ps1", "opencode.bat"]).has(commandName)) {
    const roots = win32.isAbsolute(command)
      ? [win32.dirname(command)]
      : sanitizeTrustedPath(pathValue, cwd, "win32").split(win32.delimiter).filter(Boolean);
    for (const root of roots) {
      const nativeExecutable = win32.join(root, "node_modules", "opencode-ai", "bin", "opencode.exe");
      if (fileExists(nativeExecutable)) return { command: nativeExecutable, argsPrefix: [] };
    }
  }
  const resolved = resolveTrustedExecutable(command, cwd, {
    platform,
    pathValue,
    fileExists,
  });
  if (!/\.(?:cmd|bat|ps1)$/i.test(resolved)) return { command: resolved, argsPrefix: [] };

  const packageName = KNOWN_AGENT_NPM_PACKAGES[adapterName] || KNOWN_AGENT_NPM_PACKAGES[agentName];
  if (!packageName) {
    throw new Error(`Windows shell shim is not allowed for Agent "${agentName}": ${resolved}`);
  }
  const packageRoot = win32.resolve(win32.dirname(resolved), "node_modules", ...packageName.split("/"));
  const manifestPath = win32.join(packageRoot, "package.json");
  if (!fileExists(manifestPath)) {
    throw new Error(`Verified npm package manifest not found for Agent "${agentName}": ${manifestPath}`);
  }

  let manifest: { name?: unknown; bin?: unknown };
  try {
    manifest = JSON.parse(readText(manifestPath)) as { name?: unknown; bin?: unknown };
  } catch {
    throw new Error(`Invalid npm package manifest for Agent "${agentName}": ${manifestPath}`);
  }
  if (manifest.name !== packageName) {
    throw new Error(`Unexpected npm package identity for Agent "${agentName}"`);
  }
  const shimName = win32.basename(resolved).replace(/\.(?:cmd|bat|ps1)$/i, "");
  const binPath = resolvePackageBin(manifest.bin, [agentName, adapterName, shimName]);
  if (!binPath) throw new Error(`npm package does not declare a CLI for Agent "${agentName}"`);
  const cliPath = win32.resolve(packageRoot, binPath);
  const relativeCli = win32.relative(packageRoot, cliPath);
  if (!relativeCli || relativeCli === ".." || relativeCli.startsWith(`..${win32.sep}`) || win32.isAbsolute(relativeCli) || !fileExists(cliPath)) {
    throw new Error(`npm CLI entry escapes or is missing for Agent "${agentName}"`);
  }
  const node = resolveTrustedExecutable("node", cwd, { platform, pathValue, fileExists });
  return { command: node, argsPrefix: [cliPath] };
}

function resolvePackageBin(bin: unknown, names: readonly string[]): string | null {
  if (typeof bin === "string") return bin;
  if (!bin || typeof bin !== "object" || Array.isArray(bin)) return null;
  const entries = bin as Record<string, unknown>;
  for (const name of names) {
    if (typeof entries[name] === "string") return entries[name] as string;
  }
  const values = Object.values(entries).filter((value): value is string => typeof value === "string");
  return values.length === 1 ? values[0] : null;
}

/**
 * Build agent invocation parameters from config.
 * Replaces {repo}, {prompt}, and {prompt_file} placeholders.
 * runTask and agentAssessor share this function to ensure consistent agent startup.
 */
export function buildAgentInvocation(
  agentName: string,
  repoPath: string,
  prompt: string,
  config: PatchWardenConfig,
  promptFilePath?: string
): AgentInvocation {
  const agentCmd = guardAgentCommand(agentName, config);
  const launch = resolveAgentLaunch(
    agentName,
    agentCmd.command,
    process.platform,
    process.env.PATH || "",
    existsSync,
    repoPath,
    config.agents[agentName]?.adapter || agentName,
  );
  const environmentVariableNames = [...(config.agents[agentName]?.envAllowlist ?? [])];
  const blockedEnvironmentVariableNames = [
    "CONTROL_PLANE_API_KEY",
    config.http?.ownerTokenEnv || "PATCHWARDEN_OWNER_TOKEN",
  ];
  const sanitizedPrompt = sanitizePromptArg(prompt);

  const hasPromptFilePlaceholder = agentCmd.args.includes("{prompt_file}");
  const promptMode: "inline" | "file" = hasPromptFilePlaceholder && promptFilePath ? "file" : "inline";

  const resolvedArgs = agentCmd.args.map((arg) => {
    if (arg === "{repo}") return repoPath;
    if (arg === "{prompt}") return sanitizedPrompt;
    if (arg === "{prompt_file}" && promptMode === "file" && promptFilePath) return promptFilePath;
    return arg;
  });

  return {
    command: launch.command,
    args: [...launch.argsPrefix, ...resolvedArgs],
    cwd: repoPath,
    commandLabel: `${basename(launch.command)} (configured agent command)`,
    promptMode,
    environmentVariableNames,
    blockedEnvironmentVariableNames,
    ...(promptMode === "file" && promptFilePath ? { promptFilePath } : {}),
  };
}

/**
 * Build task execution prompt. Mechanically extracted from runTask.ts.
 */
export function buildExecutionPrompt(plan: string, repoPath: string, testCommand: string): string {
  let prompt = `You are executing a pre-written plan in a local repository.

## Repository
${repoPath}

## Plan
${plan}

## Instructions
1. Read the plan carefully.
2. Implement the changes in this repository only.
3. Do NOT modify files outside this repository.
4. Leave repository changes uncommitted for review; remote operations are outside this task.
5. After implementing, describe what you changed.
6. Output a summary with what was done, files modified, and issues encountered.
`;
  if (testCommand) {
    prompt += `\n7. You may run ${testCommand}; PatchWarden will independently run it again for verification.`;
  }
  return prompt;
}

/**
 * Build agentAssessor inspect-only prompt.
 */
export function buildAssessmentPrompt(goal: string, planContent: string, repoPath: string): string {
  return `You are performing a READ-ONLY risk assessment of a planned task. Do NOT modify any files.

## Repository
${repoPath}

## Goal
${goal}

## Plan
${planContent}

## Instructions
1. Read the plan and goal carefully.
2. Inspect the repository to understand the scope of changes.
3. Do NOT create, edit, delete, rename, or generate any files.
4. Assess the risk level of executing this plan.
5. Identify affected file paths within the repository.
6. Check for destructive actions, sensitive file access, or out-of-scope changes.
7. Output your assessment as JSON after the marker ===ASSESSMENT_JSON=== on a new line.

## Required JSON output format
After your analysis, output exactly this format:

===ASSESSMENT_JSON===
{
  "risk_level": "low" | "medium" | "high",
  "reason_codes": ["short", "descriptive", "codes"],
  "affected_paths": ["relative/path/to/file"],
  "destructive_actions": ["description of any destructive actions"],
  "requires_user_confirm": false,
  "confidence": 0.0,
  "notes": "Brief summary of findings"
}

## Risk level guidelines
- low: Small source change, no sensitive files, no destructive actions
- medium: Multiple files, build artifacts, dependency changes, or uncertain scope
- high: Destructive actions, sensitive file access, out-of-scope changes, or large-scale deletion

## Constraints
- affected_paths must be relative paths within the repository (no absolute paths)
- reason_codes: max 50 entries, each max 100 chars
- destructive_actions: max 20 entries, each max 200 chars
- notes: max 2000 chars
- confidence: number from 0.0 to 1.0
`;
}
