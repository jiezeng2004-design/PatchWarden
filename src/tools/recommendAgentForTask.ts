import { getConfig } from "../config.js";
import { guardWorkspacePath } from "../security/pathGuard.js";
import { routeAgent } from "../agents/agentRouter.js";

export interface RecommendAgentForTaskInput {
  repo_path: string;
  goal: string;
  scope_files?: string[];
  template?: string;
  risk_hint?: string;
}

export interface RecommendAgentForTaskOutput {
  repo_path: string;
  resolved_repo_path: string;
  recommended_agent: string;
  fallback_agent: string | null;
  fallback: boolean;
  reason: string;
  risk_notes: string[];
  suggested_verify_commands: string[];
  bounded: true;
}

export function recommendAgentForTask(input: RecommendAgentForTaskInput): RecommendAgentForTaskOutput {
  const config = getConfig();
  const repoPath = String(input.repo_path || "").trim();
  const goal = String(input.goal || "").trim();
  if (!repoPath) throw new Error("repo_path is required.");
  if (!goal) throw new Error("goal is required.");

  const resolvedRepoPath = guardWorkspacePath(repoPath, config.workspaceRoot);
  const configuredAgents = Object.keys(config.agents);
  const route = routeAgent({
    goal,
    scope: normalizeScope(input.scope_files),
    inline_plan: input.risk_hint,
    template: input.template,
    configuredAgents,
  });

  return {
    repo_path: repoPath,
    resolved_repo_path: resolvedRepoPath,
    recommended_agent: route.recommended_agent,
    fallback_agent: route.fallback ? route.recommended_agent : configuredAgents.find((name) => name !== route.recommended_agent) || null,
    fallback: route.fallback,
    reason: route.reason,
    risk_notes: buildRiskNotes(goal, input.risk_hint),
    suggested_verify_commands: suggestVerifyCommands(config.allowedTestCommands),
    bounded: true,
  };
}

function normalizeScope(value: string[] | undefined): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((entry) => String(entry).trim()).filter(Boolean).slice(0, 50);
}

function buildRiskNotes(goal: string, riskHint: string | undefined): string[] {
  const text = `${goal} ${riskHint || ""}`.toLowerCase();
  const notes: string[] = [];
  if (/release|publish|push|tag|npm/.test(text)) {
    notes.push("release_or_remote_write_language_detected");
  }
  if (/secret|token|cookie|\.env|ssh/.test(text)) {
    notes.push("sensitive_file_language_detected");
  }
  if (/refactor|rewrite|redesign|migration/.test(text)) {
    notes.push("broad_change_language_detected");
  }
  return notes.slice(0, 8);
}

function suggestVerifyCommands(commands: string[]): string[] {
  const preferred = ["npm test", "npm run test", "npm run build", "npm run lint"];
  const configured = new Set(commands);
  return preferred.filter((command) => configured.has(command)).slice(0, 4);
}
