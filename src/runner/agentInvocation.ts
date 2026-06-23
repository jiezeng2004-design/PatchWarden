import { basename } from "node:path";
import { PatchWardenConfig } from "../config.js";
import { guardAgentCommand, sanitizePromptArg, type AllowedCommand } from "../security/commandGuard.js";

export interface AgentInvocation {
  command: string;
  args: string[];
  cwd: string;
  commandLabel: string;
  promptMode: "inline" | "file";
  promptFilePath?: string;
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
    command: agentCmd.command,
    args: resolvedArgs,
    cwd: repoPath,
    commandLabel: `${basename(agentCmd.command)} (configured agent command)`,
    promptMode,
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
