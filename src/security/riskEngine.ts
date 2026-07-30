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
import { redactSensitiveContent } from "./contentRedaction.js";
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
  snapshotIntegrityFailureCodes?: string[];
}

export interface RiskAssessmentResult {
  risk_level: RiskLevel;
  decision: RiskDecision;
  reason_codes: string[];
  risk_hints: string[];
  hard_rule_hits: string[];
  rules: RiskRuleEvidence[];
}

export interface RiskRuleEvidence {
  rule_id: string;
  risk_level: RiskLevel;
  trigger_text: string;
  blocked_capability: string;
  confirmation_supported: boolean;
  safe_alternative: string;
}

const DIST_COMMANDS = new Set(["npm run dist", "npm run pack"]);

export function assessRisk(input: RiskAssessmentInput): RiskAssessmentResult {
  const hardRuleHits: string[] = [];
  const reasonCodes: string[] = [];
  const triggerTextByRuleId: Record<string, string> = {};

  // ── Hard rules (guard functions). A hit means high → blocked. ──
  let resolvedRepoPath = input.resolvedRepoPath;
  try {
    resolvedRepoPath = guardWorkspacePath(input.repoPath, input.config.workspaceRoot);
  } catch (e) {
    recordHardRule(e, input.repoPath, hardRuleHits, triggerTextByRuleId);
    return finalize("high", "blocked", reasonCodes, hardRuleHits, input, triggerTextByRuleId);
  }

  if (!existsSync(resolvedRepoPath)) {
    hardRuleHits.push("repo_path_not_found");
    triggerTextByRuleId.repo_path_not_found = input.repoPath;
    return finalize("high", "blocked", reasonCodes, hardRuleHits, input, triggerTextByRuleId);
  }
  if (!statSync(resolvedRepoPath).isDirectory()) {
    hardRuleHits.push("repo_path_not_directory");
    triggerTextByRuleId.repo_path_not_directory = input.repoPath;
    return finalize("high", "blocked", reasonCodes, hardRuleHits, input, triggerTextByRuleId);
  }

  try {
    guardRuntimeSelfModification(resolvedRepoPath);
  } catch (e) {
    recordHardRule(e, resolvedRepoPath, hardRuleHits, triggerTextByRuleId);
    return finalize("high", "blocked", reasonCodes, hardRuleHits, input, triggerTextByRuleId);
  }

  if (!input.config.agents[input.agent]) {
    hardRuleHits.push("agent_not_configured");
    triggerTextByRuleId.agent_not_configured = input.agent;
    return finalize("high", "blocked", reasonCodes, hardRuleHits, input, triggerTextByRuleId);
  }

  try {
    guardPlanContent(input.planTitle, input.planContent);
  } catch (e) {
    recordHardRule(e, `${input.planTitle}\n${input.planContent}`, hardRuleHits, triggerTextByRuleId);
    return finalize("high", "blocked", reasonCodes, hardRuleHits, input, triggerTextByRuleId);
  }

  for (const cmd of [input.testCommand, ...input.verifyCommands]) {
    if (!cmd || cmd.trim() === "") continue;
    try {
      guardTestCommand(cmd, input.config, resolvedRepoPath);
    } catch (e) {
      recordHardRule(e, cmd, hardRuleHits, triggerTextByRuleId);
      return finalize("high", "blocked", reasonCodes, hardRuleHits, input, triggerTextByRuleId);
    }
  }

  if (input.goal) {
    const goalPath = resolve(resolvedRepoPath, input.goal);
    if (isSensitivePath(input.goal) || isSensitivePath(goalPath)) {
      hardRuleHits.push("sensitive_path_in_goal");
      triggerTextByRuleId.sensitive_path_in_goal = input.goal;
      return finalize("high", "blocked", reasonCodes, hardRuleHits, input, triggerTextByRuleId);
    }
  }

  // ── Hard rules passed. Reason codes for passing. ──
  reasonCodes.push("repo_scoped", "no_sensitive_paths", "allowlisted_commands");

  // An incomplete snapshot cannot support either automated execution or a
  // trustworthy later acceptance. Local confirmation must never convert
  // missing evidence into an allow decision.
  if ((input.snapshotIntegrityFailureCodes?.length ?? 0) > 0) {
    hardRuleHits.push("snapshot_incomplete");
    reasonCodes.push(...input.snapshotIntegrityFailureCodes!.map((code) => `snapshot:${code}`));
    return finalize("high", "blocked", reasonCodes, hardRuleHits, input);
  }

  // ── Snapshot truncation (微调 #2): force needs_confirm. ──
  if (input.snapshotTruncated) {
    reasonCodes.push("snapshot_truncated");
    triggerTextByRuleId.snapshot_truncated = `repo_path=${input.repoPath}; snapshot_truncated=true`;
    return finalize("medium", "needs_confirm", reasonCodes, hardRuleHits, input, triggerTextByRuleId);
  }

  // ── Medium-risk policy decisions. ──
  if (input.template === "release_check") {
    reasonCodes.push("release_template_needs_confirm");
    triggerTextByRuleId.release_template_needs_confirm = "template=release_check";
    return finalize("medium", "needs_confirm", reasonCodes, hardRuleHits, input, triggerTextByRuleId);
  }
  if (input.verifyCommands.some((c) => DIST_COMMANDS.has(c.trim()))) {
    reasonCodes.push("dist_command_needs_confirm");
    triggerTextByRuleId.dist_command_needs_confirm = input.verifyCommands.find((command) => DIST_COMMANDS.has(command.trim())) || "distribution command";
    return finalize("medium", "needs_confirm", reasonCodes, hardRuleHits, input, triggerTextByRuleId);
  }

  // ── Low risk. ──
  if (input.template === "inspect_only") reasonCodes.push("inspect_only_no_changes");
  else if (input.template === "feature_small") reasonCodes.push("feature_small_scoped");
  else if (input.template === "fix_tests") reasonCodes.push("fix_tests_scoped");
  return finalize("low", "allow", reasonCodes, hardRuleHits, input, triggerTextByRuleId);
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
  input: RiskAssessmentInput,
  triggerTextByRuleId: Record<string, string> = {},
): RiskAssessmentResult {
  return {
    risk_level,
    decision,
    reason_codes,
    risk_hints: collectRiskHints(input),
    hard_rule_hits,
    rules: buildRiskRuleEvidence(risk_level, decision, reason_codes, hard_rule_hits, triggerTextByRuleId),
  };
}

export function buildRiskRuleEvidence(
  riskLevel: RiskLevel,
  decision: RiskDecision,
  reasonCodes: string[],
  hardRuleHits: string[],
  triggerTextByRuleId: Record<string, string> = {},
): RiskRuleEvidence[] {
  const ids = decision === "blocked"
    ? hardRuleHits
    : decision === "needs_confirm"
      ? reasonCodes.filter((code) => ["snapshot_truncated", "release_template_needs_confirm", "dist_command_needs_confirm"].includes(code))
      : [];
  return [...new Set(ids)].map((ruleId) => {
    const catalog = riskRuleCatalog(ruleId);
    return {
      rule_id: ruleId,
      risk_level: riskLevel,
      trigger_text: sanitizeTriggerText(triggerTextByRuleId[ruleId]) || catalog.trigger_text,
      blocked_capability: catalog.blocked_capability,
      confirmation_supported: decision === "needs_confirm",
      safe_alternative: catalog.safe_alternative,
    };
  });
}

function recordHardRule(
  error: unknown,
  fallbackTrigger: string,
  hardRuleHits: string[],
  triggerTextByRuleId: Record<string, string>,
): void {
  const ruleId = extractReason(error);
  hardRuleHits.push(ruleId);
  const matchedText = error instanceof PatchWardenError && typeof error.details.matched_text === "string"
    ? error.details.matched_text
    : fallbackTrigger;
  triggerTextByRuleId[ruleId] = matchedText;
}

function sanitizeTriggerText(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return redactSensitiveContent(normalized).content.slice(0, 160);
}

function riskRuleCatalog(ruleId: string): Omit<RiskRuleEvidence, "rule_id" | "risk_level" | "confirmation_supported"> {
  if (/test_command_not_allowlisted|verification/i.test(ruleId)) return {
    trigger_text: "A requested verification command is not in the exact repository allow-list.",
    blocked_capability: "unapproved command execution",
    safe_alternative: "Select an exact command returned by create_task or add it to trusted local configuration before reassessment.",
  };
  if (/sensitive|credential|secret/i.test(ruleId)) return {
    trigger_text: "The task goal or plan requests access to a sensitive path or credential-like content.",
    blocked_capability: "sensitive data access",
    safe_alternative: "Rewrite the task to use non-sensitive files and omit credentials or credential locations.",
  };
  if (/runtime_self|self_modification|patchwarden_runtime/i.test(ruleId)) return {
    trigger_text: "The requested repository overlaps the active PatchWarden runtime.",
    blocked_capability: "runtime self-modification",
    safe_alternative: "Use a separate checkout and restart PatchWarden before validating that checkout.",
  };
  if (/repo_path|workspace|path_escape/i.test(ruleId)) return {
    trigger_text: "The requested repository is missing, invalid, or outside the configured workspace boundary.",
    blocked_capability: "out-of-workspace repository access",
    safe_alternative: "Choose an existing repository directory inside workspaceRoot.",
  };
  if (ruleId === "agent_not_configured") return {
    trigger_text: "The requested Agent is not registered in local PatchWarden configuration.",
    blocked_capability: "unregistered Agent execution",
    safe_alternative: "Call list_agents and select a configured Agent.",
  };
  if (ruleId === "snapshot_truncated") return {
    trigger_text: "The pre-task repository snapshot exceeded the bounded evidence limit.",
    blocked_capability: "write execution without complete baseline evidence",
    safe_alternative: "Review the bounded snapshot and confirm locally, or narrow repo_path before retrying.",
  };
  if (ruleId === "release_template_needs_confirm" || ruleId === "dist_command_needs_confirm") return {
    trigger_text: ruleId === "release_template_needs_confirm" ? "A release-check task was requested." : "A distribution or packaging command was requested.",
    blocked_capability: "release or distribution preparation",
    safe_alternative: "Review the assessment and confirm locally; publishing remains a separate manual action.",
  };
  return {
    trigger_text: `Safety rule ${ruleId} matched the requested task.`,
    blocked_capability: "policy-restricted task execution",
    safe_alternative: "Review the rule identifier, narrow the task, and reassess without weakening the safety policy.",
  };
}

function extractReason(error: unknown): string {
  if (error instanceof PatchWardenError) return error.reason;
  if (error instanceof Error) return error.message.slice(0, 80);
  return String(error).slice(0, 80);
}
