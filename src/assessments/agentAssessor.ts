import { writeFileSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { PatchWardenConfig } from "../config.js";
import { buildAgentInvocation, buildAssessmentPrompt } from "../runner/agentInvocation.js";
import { runSimpleProcessSync } from "../runner/simpleProcess.js";
import { captureRepoSnapshot, compareSnapshots, type RepoSnapshot, type ChangedFile } from "../runner/changeCapture.js";
import type { AgentAssessmentOutput, AgentAssessmentSummary } from "./assessmentStore.js";

const ASSESSMENT_MARKER = "===ASSESSMENT_JSON===";

export interface AgentAssessorInput {
  assessmentId: string;
  assessmentDir: string;
  agentName: string;
  repoPath: string;
  workspaceRoot: string;
  goal: string;
  planContent: string;
  timeoutSeconds: number;
  maxOutputBytes: number;
  config: PatchWardenConfig;
}

export function runAgentAssessment(input: AgentAssessorInput): AgentAssessmentSummary {
  const logPaths: AgentAssessmentSummary["log_paths"] = {
    stdout: resolve(input.assessmentDir, "agent-assessment-stdout.log"),
    stderr: resolve(input.assessmentDir, "agent-assessment-stderr.log"),
    assessment: resolve(input.assessmentDir, "agent-assessment.json"),
  };

  const emptySummary: AgentAssessmentSummary = {
    attempted: false,
    status: "not_run",
    output: null,
    merged_risk: "low",
    merged_decision: "allow",
    merged_reason_codes: [],
    timed_out: false,
    exit_code: null,
    read_only_violation: false,
    violation_files: [],
    stdout_truncated: false,
    stderr_truncated: false,
    log_paths: logPaths,
  };

  // ── 1. Build prompt and write to file for {prompt_file} support ──
  const assessmentPrompt = buildAssessmentPrompt(input.goal, input.planContent, input.repoPath);
  const promptFilePath = resolve(input.assessmentDir, "agent-assessment-prompt.md");
  writeFileSync(promptFilePath, assessmentPrompt, "utf-8");
  logPaths.prompt = promptFilePath;

  // ── 2. Before snapshot (repo-scoped) ──
  let repoBefore: RepoSnapshot;
  try {
    repoBefore = captureRepoSnapshot(input.repoPath);
  } catch {
    // If we can't capture before snapshot, conservatively skip agent assessment
    emptySummary.status = "spawn_failed";
    emptySummary.merged_risk = "medium";
    emptySummary.merged_decision = "needs_confirm";
    emptySummary.merged_reason_codes = ["agent_assessment_snapshot_failed"];
    writeSummary(logPaths.assessment, emptySummary);
    return emptySummary;
  }

  // ── 3. Build agent invocation ──
  let invocation;
  try {
    invocation = buildAgentInvocation(input.agentName, input.repoPath, assessmentPrompt, input.config, promptFilePath);
  } catch (error) {
    emptySummary.status = "spawn_failed";
    emptySummary.merged_risk = "medium";
    emptySummary.merged_decision = "needs_confirm";
    emptySummary.merged_reason_codes = ["agent_assessment_invocation_failed"];
    writeSummary(logPaths.assessment, emptySummary);
    return emptySummary;
  }

  emptySummary.attempted = true;

  // ── 4. Run agent ──
  const result = runSimpleProcessSync({
    command: invocation.command,
    args: invocation.args,
    cwd: input.repoPath,
    timeoutMs: input.timeoutSeconds * 1000,
    maxStdoutBytes: input.maxOutputBytes,
    maxStderrBytes: Math.max(16384, Math.floor(input.maxOutputBytes / 4)),
    stdoutPath: logPaths.stdout,
    stderrPath: logPaths.stderr,
  });

  // ── 5. After snapshot + read-only violation check ──
  let readOnlyViolation = false;
  let violationFiles: string[] = [];
  try {
    const repoAfter = captureRepoSnapshot(input.repoPath);
    const changes = compareSnapshots(repoBefore, repoAfter);
    if (changes.length > 0) {
      readOnlyViolation = true;
      violationFiles = changes.map((c) => c.path);
    }
  } catch {
    // 修复 #4: after snapshot 捕获失败 → 保守变为 high / blocked
    readOnlyViolation = true;
    violationFiles = ["(after snapshot capture failed)"];
  }

  if (readOnlyViolation) {
    const summary: AgentAssessmentSummary = {
      attempted: true,
      status: "read_only_violation",
      output: null,
      merged_risk: "high",
      merged_decision: "blocked",
      merged_reason_codes: ["agent_read_only_violation"],
      timed_out: false,
      exit_code: result.exitCode,
      read_only_violation: true,
      violation_files: violationFiles,
      stdout_truncated: result.stdoutTruncated,
      stderr_truncated: result.stderrTruncated,
      log_paths: { ...logPaths, violation: resolve(input.assessmentDir, "agent-assessment-violation.json") },
    };
    writeFileSync(summary.log_paths.violation!, JSON.stringify({
      violation: "read_only_violation",
      files: violationFiles,
      exit_code: result.exitCode,
    }, null, 2), "utf-8");
    writeSummary(logPaths.assessment, summary);
    return summary;
  }

  // ── 6. Handle spawn failure ──
  if (result.spawnError) {
    const summary: AgentAssessmentSummary = {
      ...emptySummary,
      attempted: true,
      status: "spawn_failed",
      merged_risk: "medium",
      merged_decision: "needs_confirm",
      merged_reason_codes: ["agent_assessment_spawn_failed"],
      exit_code: result.exitCode,
      stdout_truncated: result.stdoutTruncated,
      stderr_truncated: result.stderrTruncated,
    };
    writeSummary(logPaths.assessment, summary);
    return summary;
  }

  // ── 7. Handle timeout ──
  if (result.timedOut) {
    const summary: AgentAssessmentSummary = {
      ...emptySummary,
      attempted: true,
      status: "timed_out",
      merged_risk: "medium",
      merged_decision: "needs_confirm",
      merged_reason_codes: ["agent_assessment_timed_out"],
      timed_out: true,
      exit_code: result.exitCode,
      stdout_truncated: result.stdoutTruncated,
      stderr_truncated: result.stderrTruncated,
    };
    writeSummary(logPaths.assessment, summary);
    return summary;
  }

  // ── 8. Handle non-zero exit ──
  if (result.exitCode !== 0) {
    const summary: AgentAssessmentSummary = {
      ...emptySummary,
      attempted: true,
      status: "non_zero_exit",
      merged_risk: "medium",
      merged_decision: "needs_confirm",
      merged_reason_codes: ["agent_assessment_non_zero_exit"],
      exit_code: result.exitCode,
      stdout_truncated: result.stdoutTruncated,
      stderr_truncated: result.stderrTruncated,
    };
    writeSummary(logPaths.assessment, summary);
    return summary;
  }

  // ── 9. Parse JSON from stdout ──
  const parsed = parseAssessmentJson(result.stdout, input.repoPath);

  if (!parsed.output) {
    const summary: AgentAssessmentSummary = {
      ...emptySummary,
      attempted: true,
      status: "parse_failed",
      merged_risk: "medium",
      merged_decision: "needs_confirm",
      merged_reason_codes: ["agent_assessment_parse_failed", ...parsed.sanitized_reasons],
      exit_code: result.exitCode,
      stdout_truncated: result.stdoutTruncated,
      stderr_truncated: result.stderrTruncated,
    };
    writeSummary(logPaths.assessment, summary);
    return summary;
  }

  // ── 10. Merge risk (agent can only raise, not lower) ──
  const agentRisk = parsed.output.risk_level;
  let mergedRisk: "low" | "medium" | "high" = agentRisk === "high" ? "high" : agentRisk === "medium" ? "medium" : "low";
  let mergedDecision: "allow" | "needs_confirm" | "blocked" =
    mergedRisk === "high" ? "blocked" : mergedRisk === "medium" ? "needs_confirm" : "allow";
  const mergedReasonCodes = ["agent_assessment_completed", ...parsed.sanitized_reasons];
  // 修复 #5: agent requires_user_confirm=true 时至少升级为 medium / needs_confirm
  if (parsed.output.requires_user_confirm && mergedRisk === "low") {
    mergedRisk = "medium";
    mergedDecision = "needs_confirm";
    mergedReasonCodes.push("agent_requested_confirm");
  }

  const summary: AgentAssessmentSummary = {
    attempted: true,
    status: "completed",
    output: { ...parsed.output, assessed_at: new Date().toISOString() },
    merged_risk: mergedRisk,
    merged_decision: mergedDecision,
    merged_reason_codes: mergedReasonCodes,
    timed_out: false,
    exit_code: result.exitCode,
    read_only_violation: false,
    violation_files: [],
    stdout_truncated: result.stdoutTruncated,
    stderr_truncated: result.stderrTruncated,
    log_paths: logPaths,
  };
  writeSummary(logPaths.assessment, summary);
  return summary;
}

interface ParsedAssessment {
  output: AgentAssessmentOutput | null;
  sanitized_reasons: string[];
}

function parseAssessmentJson(stdout: string, repoPath: string): ParsedAssessment {
  const sanitized_reasons: string[] = [];

  // Use the LAST marker only
  const lastMarkerIndex = stdout.lastIndexOf(ASSESSMENT_MARKER);
  if (lastMarkerIndex < 0) return { output: null, sanitized_reasons };

  const jsonText = stdout.slice(lastMarkerIndex + ASSESSMENT_MARKER.length).trim();
  // Find the JSON object (from first { to last })
  const jsonStart = jsonText.indexOf("{");
  const jsonEnd = jsonText.lastIndexOf("}");
  if (jsonStart < 0 || jsonEnd < 0 || jsonEnd <= jsonStart) return { output: null, sanitized_reasons };

  let parsed: any;
  try {
    parsed = JSON.parse(jsonText.slice(jsonStart, jsonEnd + 1));
  } catch {
    return { output: null, sanitized_reasons };
  }

  // ── Strict validation ──
  if (parsed.risk_level !== "low" && parsed.risk_level !== "medium" && parsed.risk_level !== "high") {
    return { output: null, sanitized_reasons };
  }

  const confidence = Number(parsed.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return { output: null, sanitized_reasons };
  }

  if (!Array.isArray(parsed.reason_codes)) return { output: null, sanitized_reasons };
  if (parsed.reason_codes.length > 50) return { output: null, sanitized_reasons };
  const reasonCodes = parsed.reason_codes.filter((r: any) => typeof r === "string" && r.length <= 100);
  if (reasonCodes.length !== parsed.reason_codes.length) {
    sanitized_reasons.push("reason_codes_filtered");
  }

  if (!Array.isArray(parsed.affected_paths)) return { output: null, sanitized_reasons };
  if (parsed.affected_paths.length > 100) return { output: null, sanitized_reasons };
  const affectedPaths: string[] = [];
  let pathsSanitized = false;
  for (const p of parsed.affected_paths) {
    if (typeof p !== "string") { pathsSanitized = true; continue; }
    // Must be relative, not absolute, and within repo
    if (isAbsolute(p)) { pathsSanitized = true; continue; }
    const resolved = resolve(repoPath, p);
    const rel = relative(repoPath, resolved);
    if (rel.startsWith("..")) { pathsSanitized = true; continue; }
    affectedPaths.push(p);
  }
  if (pathsSanitized) {
    sanitized_reasons.push("paths_sanitized");
  }

  if (!Array.isArray(parsed.destructive_actions)) return { output: null, sanitized_reasons };
  if (parsed.destructive_actions.length > 20) return { output: null, sanitized_reasons };
  const destructiveActions = parsed.destructive_actions.filter(
    (d: any) => typeof d === "string" && d.length <= 200
  );

  if (typeof parsed.requires_user_confirm !== "boolean") return { output: null, sanitized_reasons };

  const notes = typeof parsed.notes === "string" ? parsed.notes.slice(0, 2000) : "";

  return {
    output: {
      risk_level: parsed.risk_level,
      reason_codes: reasonCodes,
      affected_paths: affectedPaths,
      destructive_actions: destructiveActions,
      requires_user_confirm: parsed.requires_user_confirm,
      confidence,
      notes,
      assessed_at: new Date().toISOString(),
    },
    sanitized_reasons,
  };
}

function writeSummary(path: string, summary: AgentAssessmentSummary): void {
  writeFileSync(path, JSON.stringify(summary, null, 2), "utf-8");
}
