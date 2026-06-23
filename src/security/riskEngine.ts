import {
  existsSync,
  statSync,
} from "node:fs";
import { resolve } from "node:path";
import {
  PatchWardenConfig,
  getRepoAllowedTestCommands,
} from "../config.js";
import { guardWorkspacePath } from "./pathGuard.js";
import { guardPlanContent } from "./planGuard.js";
import { guardTestCommand } from "./commandGuard.js";
import { isSensitivePath } from "./sensitiveGuard.js";
import { guardRuntimeSelfModification } from "./runtimeGuard.js";
import { PatchWardenError } from "../errors.js";
import type { TaskTemplateName, ChangePolicy } from "../tools/taskTemplates.js";

export type RiskLevel = "low" | "medium" | "high";
export type RiskDecision = "allow" | "needs_confirm" | "blocked";

export interface RiskAssessmentInput {
  repoPath: string;
  resolvedRepoPath: string;
  planContent: string;
  planTitle: string;
  testCommand: string;
  verifyCommands: string[];
  template?: TaskTemplateName;
  goal?: string;
  agent: string;
  config: PatchWardenConfig;
  snapshotTruncated: boolean;
}

export interface RiskAssessmentResult {
  risk_level: RiskLevel;
  decision: RiskDecision;
  reason_codes: string[];
  risk_hints: string[];
  hard_rule_hits: string[];
}

const DIST_COMMANDS = new Set(["npm run dist", "npm run pack"]);

export function assessRisk(input: RiskAssessmentInput): RiskAssessmentResult {
  const hardRuleHits: string[] = [];
  const reasonCodes: string[] = [];

  // ── Hard rules (guard functions). A hit means high → blocked. ──
  let resolvedRepoPath = input.resolvedRepoPath;
  try {
    resolvedRepoPath = guardWorkspacePath(input.repoPath, input.config.workspaceRoot);
  } catch (e) {
    hardRuleHits.push(extractReason(e));
    return finalize("high", "blocked", reasonCodes, hardRuleHits, input);
  }

  if (!existsSync(resolvedRepoPath)) {
    hardRuleHits.push("repo_path_not_found");
    return finalize("high", "blocked", reasonCodes, hardRuleHits, input);
  }
  if (!statSync(resolvedRepoPath).isDirectory()) {
    hardRuleHits.push("repo_path_not_directory");
    return finalize("high", "blocked", reasonCodes, hardRuleHits, input);
  }

  try {
    guardRuntimeSelfModification(resolvedRepoPath);
  } catch (e) {
    hardRuleHits.push(extractReason(e));
    return finalize("high", "blocked", reasonCodes, hardRuleHits, input);
  }

  if (!input.config.agents[input.agent]) {
    hardRuleHits.push("agent_not_configured");
    return finalize("high", "blocked", reasonCodes, hardRuleHits, input);
  }

  try {
    guardPlanContent(input.planTitle, input.planContent);
  } catch (e) {
    hardRuleHits.push(extractReason(e));
    return finalize("high", "blocked", reasonCodes, hardRuleHits, input);
  }

  for (const cmd of [input.testCommand, ...input.verifyCommands]) {
    if (!cmd || cmd.trim() === "") continue;
    try {
      guardTestCommand(cmd, input.config, resolvedRepoPath);
    } catch (e) {
      hardRuleHits.push(extractReason(e));
      return finalize("high", "blocked", reasonCodes, hardRuleHits, input);
    }
  }

  if (input.goal) {
    const goalPath = resolve(resolvedRepoPath, input.goal);
    if (isSensitivePath(input.goal) || isSensitivePath(goalPath)) {
      hardRuleHits.push("sensitive_path_in_goal");
      return finalize("high", "blocked", reasonCodes, hardRuleHits, input);
    }
  }

  // ── Hard rules passed. Reason codes for passing. ──
  reasonCodes.push("repo_scoped", "no_sensitive_paths", "allowlisted_commands");

  // ── Snapshot truncation (微调 #2): force needs_confirm. ──
  if (input.snapshotTruncated) {
    reasonCodes.push("snapshot_truncated");
    return finalize("medium", "needs_confirm", reasonCodes, hardRuleHits, input);
  }

  // ── Medium-risk policy decisions. ──
  if (input.template === "release_check") {
    reasonCodes.push("release_template_needs_confirm");
    return finalize("medium", "needs_confirm", reasonCodes, hardRuleHits, input);
  }
  if (input.verifyCommands.some((c) => DIST_COMMANDS.has(c.trim()))) {
    reasonCodes.push("dist_command_needs_confirm");
    return finalize("medium", "needs_confirm", reasonCodes, hardRuleHits, input);
  }

  // ── Low risk. ──
  if (input.template === "inspect_only") reasonCodes.push("inspect_only_no_changes");
  else if (input.template === "feature_small") reasonCodes.push("feature_small_scoped");
  else if (input.template === "fix_tests") reasonCodes.push("fix_tests_scoped");
  return finalize("low", "allow", reasonCodes, hardRuleHits, input);
}

/** Risk hints — keyword detection only, never affects risk_level (收缩 #4). */
export function collectRiskHints(input: RiskAssessmentInput): string[] {
  const hints: string[] = [];
  const text = `${input.goal || ""} ${input.planContent || ""}`.toLowerCase();
  if (/\bpackage-lock\b/.test(text)) hints.push("mentions_package_lock");
  if (/\brelease\b|\bdist\b/.test(text)) hints.push("mentions_artifact_dir");
  if (/\bsync\b|\bbackup\b|\bpayload\b|\bpersistence\b/.test(text)) hints.push("mentions_dev_vocab");
  return hints;
}

function finalize(
  risk_level: RiskLevel,
  decision: RiskDecision,
  reason_codes: string[],
  hard_rule_hits: string[],
  input: RiskAssessmentInput
): RiskAssessmentResult {
  return {
    risk_level,
    decision,
    reason_codes,
    risk_hints: collectRiskHints(input),
    hard_rule_hits,
  };
}

function extractReason(error: unknown): string {
  if (error instanceof PatchWardenError) return error.reason;
  if (error instanceof Error) return error.message.slice(0, 80);
  return String(error).slice(0, 80);
}
