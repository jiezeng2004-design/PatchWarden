import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { getConfig, getTasksDir, sanitizeAgentRuntimeMetadata } from "../../config.js";
import { guardReadPath } from "../../security/pathGuard.js";
import { getTaskStatus } from "./getTaskStatus.js";
import { redactSensitiveValue } from "../../security/contentRedaction.js";
import {
  readTextFilePrefixSync,
  readTextFileTailLinesSync,
} from "../../utils/boundedFile.js";
import { isTerminalTaskStatus } from "./taskStates.js";
import { deriveCompletionState, type CompletionState } from "../../runner/completionState.js";

export interface TaskSummaryOutput {
  task_id: string;
  status: string;
  terminal: boolean;
  history_state: "active" | "archived";
  acceptance_status: "pending" | "ready_for_review" | "needs_review" | "failed";
  acceptance_reviewed_at: string | null;
  acceptance_reviewer: string | null;
  phase: string;
  agent: string;
  agent_runtime: Record<string, unknown> | null;
  model_selection: Record<string, unknown> | null;
  failure_category: string | null;
  agent_failure_category: string | null;
  failure_source: string | null;
  counts_against_agent: boolean;
  fallback_eligible: boolean;
  retryable: boolean;
  completion_state: CompletionState;
  provider_error_reference: string | null;
  workspace_root: string;
  repo_path: string;
  resolved_repo_path: string;
  changed_files: unknown[];
  out_of_scope_changes: unknown[];
  change_attribution: Record<string, unknown>;
  manual_scope_review_required: boolean;
  runtime_validation: Record<string, unknown> | null;
  project_fact_validation: Record<string, unknown> | null;
  framework_validation: Record<string, unknown> | null;
  svg_xml_validation: Record<string, unknown> | null;
  acceptance_report: Record<string, unknown> | null;
  workspace_dirty_before: boolean;
  workspace_dirty_after: boolean;
  verify_status: string;
  verify_commands: unknown[];
  executed_verify_commands: unknown[];
  last_heartbeat_at: string;
  current_command: string | null;
  elapsed_ms: number;
  summary: string;
  test_summary: string;
  diff_available: boolean;
  diff_truncated: boolean;
  result_available: boolean;
  result_json_available: boolean;
  verify_available: boolean;
  test_log_available: boolean;
  warnings: string[];
  information: string[];
  errors: string[];
  artifacts: Record<string, boolean>;
  plan_source: string;
  template: string | null;
  change_policy: string;
  failure_reason: string | null;
  failed_command: string | null;
  suggested_next_action: string;
  safe_followup_prompt: string | null;
  verification_summary: {
    status: string;
    command_count: number;
    configured_command_count: number;
    passed_commands: number;
    failed_commands: number;
    skipped_commands: number;
    headline: string;
    reason: string | null;
  };
  failed_command_detail: {
    command: string;
    exit_code: number | null;
    stderr_tail: string;
    duration_ms: number;
  } | null;
  log_tails: {
    stdout: string;
    stderr: string;
    test: string;
    verify: string;
  };
  redacted: boolean;
  redaction_categories: string[];
  watcher: unknown;
  pending_reason: string | null;
  execution_blocked: boolean;
  artifact_hygiene: Record<string, unknown>;
}

export interface CompactTaskSummaryOutput {
  view: "compact";
  task_id: string;
  status: string;
  terminal: boolean;
  history_state: "active" | "archived";
  acceptance_status: TaskSummaryOutput["acceptance_status"];
  phase: string;
  repo_path: string;
  agent_runtime: Record<string, unknown> | null;
  model_selection: Record<string, unknown> | null;
  failure_category: string | null;
  agent_failure_category: string | null;
  failure_source: string | null;
  counts_against_agent: boolean;
  fallback_eligible: boolean;
  retryable: boolean;
  completion_state: CompletionState;
  provider_error_reference: string | null;
  changed_files_total: number;
  out_of_scope_changes_total: number;
  manual_scope_review_required: boolean;
  runtime_validation: Record<string, unknown> | null;
  project_fact_validation: Record<string, unknown> | null;
  framework_validation: Record<string, unknown> | null;
  svg_xml_validation: Record<string, unknown> | null;
  acceptance_report: Record<string, unknown> | null;
  artifact_hygiene: {
    counts: Record<string, number>;
    source_changes: unknown[];
    dependency_changes: unknown[];
    generated_changes: unknown[];
    runtime_changes: unknown[];
    unexpected_changes: unknown[];
    tracked_build_artifacts: unknown[];
    ignored_untracked_artifacts: unknown[];
    runtime_generated_files: unknown[];
    suspicious_changes: unknown[];
    max_items: number;
    truncated: boolean;
  };
  release_artifacts_count: number;
  release_artifact_paths: string[];
  artifact_status: string | null;
  verification_summary: TaskSummaryOutput["verification_summary"];
  summary: string;
  warnings: string[];
  information: string[];
  errors: string[];
  failure_reason: string | null;
  failed_command: string | null;
  suggested_next_action: string;
  execution_blocked: boolean;
  pending_reason: string | null;
  redacted: boolean;
  redaction_categories: string[];
}

export interface GetTaskSummaryOptions {
  view?: "compact" | "standard";
  max_items?: number;
}

export type TaskSummaryResult = TaskSummaryOutput | CompactTaskSummaryOutput;

export function getTaskSummary(taskId: string): TaskSummaryOutput;
export function getTaskSummary(taskId: string, options: { view: "compact"; max_items?: number }): CompactTaskSummaryOutput;
export function getTaskSummary(taskId: string, options: { view?: "standard"; max_items?: number }): TaskSummaryOutput;
export function getTaskSummary(taskId: string, options: GetTaskSummaryOptions): TaskSummaryResult;
export function getTaskSummary(taskId: string, options: GetTaskSummaryOptions = {}): TaskSummaryResult {
  const config = getConfig();
  const taskDir = resolve(getTasksDir(config), taskId);
  const statusFile = join(taskDir, "status.json");
  guardReadPath(statusFile, config.workspaceRoot, config.tasksDir);
  const status = getTaskStatus(taskId);
  const resultRead = tryReadJson(join(taskDir, "result.json"));
  const verifyRead = tryReadJson(join(taskDir, "verify.json"));
  const acceptanceReportRead = tryReadJson(join(taskDir, "acceptance-report.json"));
  const result = resultRead.data;
  const verify = verifyRead.data;
  const terminal = isTerminalTaskStatus(String(status.status));
  // Snapshot differences alone cannot prove process ownership. Prefer the
  // attribution artifact, retaining legacy snapshot behavior only if absent.
  const outOfScope = asArray(
    result.new_out_of_scope_changes
    ?? status.new_out_of_scope_changes
    ?? result.out_of_scope_changes
    ?? status.out_of_scope_changes
  );
  const changeAttribution = readChangeAttribution(result.change_attribution ?? asRecord(status).change_attribution);
  const confirmedTaskOwnedChanges = changeAttribution ? changeAttribution.task_owned_change : outOfScope.length;
  const manualScopeReviewRequired = changeAttribution?.manual_scope_review_required === true
    || (changeAttribution?.concurrent_external_change ?? 0) > 0
    || (changeAttribution?.unattributed_change ?? 0) > 0;
  const resultVerify = asRecord(result.verify);
  const verifyStatus = String(verify.status ?? result.verify_status ?? resultVerify.status ?? status.verify_status ?? "not_available");
  const errors = [status.error, ...asArray(result.errors), ...asArray(result.known_issues)]
    .filter((value): value is string => typeof value === "string" && value.trim() !== "");
  const resultWarnings = asArray(result.warnings).filter((value): value is string => typeof value === "string");
  const information = resultWarnings.filter(isInformationalEvidence);
  const warnings = resultWarnings.filter((warning) => !isInformationalEvidence(warning));
  const artifacts = Object.fromEntries([
    "result.md",
    "result.json",
    "diff.patch",
    "git.diff",
    "test.log",
    "verify.log",
    "verify.json",
    "changed-files.json",
    "file-stats.json",
    "runtime-validation.json",
    "rollback_scope_violation_plan.md",
  ].map((name) => [name, existsSync(join(taskDir, name))]));

  for (const required of ["result.md", "result.json", "diff.patch", "file-stats.json", "test.log", "verify.json"]) {
    if (!artifacts[required]) warnings.push(`${required} is missing.`);
  }
  if (resultRead.error) warnings.push(`result.json could not be parsed; using status.json/result.md fallback: ${resultRead.error}`);
  if (verifyRead.error) warnings.push(`verify.json could not be parsed; using status.json fallback: ${verifyRead.error}`);

  let acceptanceStatus: TaskSummaryOutput["acceptance_status"] = "pending";
  let acceptanceReviewedAt: string | null = null;
  let acceptanceReviewer: string | null = null;

  // Check for explicit human acceptance (takes precedence over computed status)
  const acceptanceFile = join(taskDir, "acceptance.json");
  if (existsSync(acceptanceFile)) {
    try {
      const acceptance = asRecord(JSON.parse(readTextFilePrefixSync(acceptanceFile, 1024 * 1024).content));
      if (acceptance.status === "accepted") {
        acceptanceStatus = "ready_for_review";
        acceptanceReviewedAt = typeof acceptance.reviewed_at === "string" ? acceptance.reviewed_at : null;
        acceptanceReviewer = typeof acceptance.reviewer === "string" ? acceptance.reviewer : null;
      } else if (acceptance.status === "rejected") {
        acceptanceStatus = "failed";
        acceptanceReviewedAt = typeof acceptance.reviewed_at === "string" ? acceptance.reviewed_at : null;
        acceptanceReviewer = typeof acceptance.reviewer === "string" ? acceptance.reviewer : null;
        if (acceptance.notes) {
          warnings.push(`Task was rejected by ${acceptance.reviewer || "human"} at ${acceptance.reviewed_at || "unknown time"}: ${acceptance.notes}`);
        }
      }
    } catch {
      warnings.push("acceptance.json exists but could not be parsed.");
    }
  } else if (terminal) {
    if ((status.status !== "done" && status.status !== "done_by_agent") || confirmedTaskOwnedChanges > 0 || verifyStatus === "failed") {
      acceptanceStatus = "failed";
    } else if (manualScopeReviewRequired) {
      acceptanceStatus = "needs_review";
      warnings.push("External changes require manual scope review; inspect change-attribution.json before acceptance.");
    } else if (verifyStatus === "passed") {
      acceptanceStatus = "ready_for_review";
    } else {
      acceptanceStatus = "needs_review";
      warnings.push("No passing verify_commands evidence is available; manual review is required.");
    }
  }

  const startedAt = Date.parse(String(status.started_at || status.created_at || ""));
  const finishedAt = Date.parse(String(status.finished_at || ""));
  const elapsedMs = Number.isFinite(startedAt)
    ? Math.max(0, (Number.isFinite(finishedAt) ? finishedAt : Date.now()) - startedAt)
    : 0;
  const changedFiles = asArray(result.changed_files ?? status.changed_files);
  const changedFilesRead = tryReadJson(join(taskDir, "changed-files.json"));
  const artifactHygiene = asRecord(result.artifact_hygiene ?? changedFilesRead.data.artifact_hygiene ?? {
    counts: status.artifact_hygiene_counts || {},
  });
  const verifyCommands = asArray(
    verify.configured_commands
    ?? verify.requested_commands
    ?? result.configured_verify_commands
    ?? result.verify_commands
    ?? status.verify_commands,
  );
  const executedVerifyRecords = asArray(verify.commands ?? resultVerify.commands);
  const executedVerifyCommands = executedVerifyRecords.map((entry) => {
    const record = asRecord(entry);
    return Object.keys(record).length > 0 ? String(record.command || "") : String(entry || "");
  }).filter(Boolean);
  const testLogSummary = summarizeTestLog(join(taskDir, "test.log"));
  const verificationSummary = buildVerificationSummary(
    verifyStatus,
    verifyCommands,
    executedVerifyRecords,
    testLogSummary,
    typeof verify.reason === "string" ? verify.reason : null,
  );

  // Extract failed command detail from verify records
  const failedVerify = executedVerifyRecords
    .map(asRecord)
    .find((command) => ["failed", "timed_out", "canceled"].includes(String(command.status || "")));
  const failedCommandDetail = failedVerify ? {
    command: String(failedVerify.command || ""),
    exit_code: failedVerify.exit_code ?? null,
    stderr_tail: String(failedVerify.stderr_tail || "").slice(0, 500),
    duration_ms: Number(failedVerify.duration_ms || 0),
  } : null;

  // Collect log tails (last 5 lines of each log)
  const logTails = {
    stdout: readLogTail(join(taskDir, "stdout.log"), 5),
    stderr: readLogTail(join(taskDir, "stderr.log"), 5),
    test: readLogTail(join(taskDir, "test.log"), 5),
    verify: readLogTail(join(taskDir, "verify.log"), 5),
  };

  const output = {
    task_id: taskId,
    status: String(status.status || "unknown"),
    terminal,
    history_state: status.history_state,
    acceptance_status: acceptanceStatus,
    acceptance_reviewed_at: acceptanceReviewedAt,
    acceptance_reviewer: acceptanceReviewer,
    phase: String(status.phase || "unknown"),
    agent: String(status.agent || result.agent || ""),
    agent_runtime: sanitizeAgentRuntimeMetadata(status.agent_runtime ?? result.agent_runtime ?? status.model_selection ?? result.model_selection),
    model_selection: sanitizeAgentRuntimeMetadata(status.model_selection ?? result.model_selection ?? status.agent_runtime ?? result.agent_runtime),
    failure_category: String(status.failure_category || result.failure_category || status.agent_failure_category || result.agent_failure_category || "") || null,
    agent_failure_category: String(status.agent_failure_category || result.agent_failure_category || "") || null,
    failure_source: String(asRecord(status).failure_source || result.failure_source || "") || null,
    counts_against_agent: Boolean(asRecord(status).counts_against_agent ?? result.counts_against_agent),
    fallback_eligible: Boolean(asRecord(status).fallback_eligible ?? result.fallback_eligible),
    retryable: Boolean(asRecord(status).retryable ?? result.retryable),
    completion_state: deriveCompletionState({
      status: String(status.status || result.status || "unknown"),
      verify_status: verifyStatus,
      runtime_validation: result.runtime_validation ?? asRecord(status).runtime_validation,
      manual_scope_review_required: manualScopeReviewRequired,
      acceptance_status: String(asRecord(status).acceptance_status || result.acceptance_status || "") || null,
    }),
    provider_error_reference: safeProviderErrorReference(status.provider_error_reference ?? result.provider_error_reference),
    workspace_root: String(status.workspace_root || result.workspace_root || config.workspaceRoot),
    repo_path: String(status.repo_path || result.repo_path || ""),
    resolved_repo_path: String(status.resolved_repo_path || result.resolved_repo_path || ""),
    changed_files: changedFiles,
    out_of_scope_changes: outOfScope,
    change_attribution: changeAttribution ?? {},
    manual_scope_review_required: manualScopeReviewRequired,
    runtime_validation: Object.keys(asRecord(result.runtime_validation ?? asRecord(status).runtime_validation)).length > 0
      ? asRecord(result.runtime_validation ?? asRecord(status).runtime_validation)
      : null,
    project_fact_validation: Object.keys(asRecord(result.project_fact_validation ?? asRecord(status).project_fact_validation)).length > 0
      ? asRecord(result.project_fact_validation ?? asRecord(status).project_fact_validation)
      : null,
    framework_validation: Object.keys(asRecord(result.framework_validation ?? asRecord(status).framework_validation)).length > 0
      ? asRecord(result.framework_validation ?? asRecord(status).framework_validation)
      : null,
    svg_xml_validation: Object.keys(asRecord(result.svg_xml_validation ?? asRecord(status).svg_xml_validation)).length > 0
      ? asRecord(result.svg_xml_validation ?? asRecord(status).svg_xml_validation)
      : null,
    acceptance_report: Object.keys(acceptanceReportRead.data).length > 0
      ? acceptanceReportRead.data
      : (Object.keys(asRecord(result.acceptance_report ?? asRecord(status).acceptance_report)).length > 0
          ? asRecord(result.acceptance_report ?? asRecord(status).acceptance_report)
          : null),
    workspace_dirty_before: Boolean(status.workspace_dirty_before ?? result.workspace_dirty_before),
    workspace_dirty_after: Boolean(status.workspace_dirty_after ?? status.workspace_dirty ?? result.workspace_dirty_after),
    verify_status: verifyStatus,
    verify_commands: verifyCommands,
    executed_verify_commands: executedVerifyCommands,
    last_heartbeat_at: String(status.last_heartbeat_at || status.updated_at || ""),
    current_command: status.current_command ?? null,
    elapsed_ms: elapsedMs,
    summary: String(result.summary || readResultFallback(join(taskDir, "result.md")) || status.error || `Task is ${status.status || "unknown"}.`),
    test_summary: verificationSummary.headline,
    diff_available: Boolean(
      (status.diff_available ?? (changedFiles.length > 0)) &&
      (artifacts["diff.patch"] || artifacts["git.diff"])
    ),
    diff_truncated: Boolean(status.diff_truncated || asArray(result.warnings).some(
      (warning) => typeof warning === "string" && warning.includes("diff.patch was truncated"),
    )),
    result_available: artifacts["result.md"],
    result_json_available: artifacts["result.json"],
    verify_available: artifacts["verify.json"],
    test_log_available: artifacts["test.log"],
    warnings: [...new Set(warnings)],
    information: [...new Set(information)],
    errors: [...new Set(errors)],
    artifacts,
    plan_source: String(status.plan_source || result.plan_source || "saved"),
    template: status.template || result.template || null,
    change_policy: String(status.change_policy || result.change_policy || "repo_scoped_changes"),
    failure_reason: result.failure_reason || status.error || null,
    failed_command: result.failed_command || null,
    suggested_next_action: String(result.suggested_next_action || (terminal ? "audit_task" : status.execution_blocked ? "health_check" : "wait_for_task")),
    safe_followup_prompt: result.safe_followup_prompt || null,
    verification_summary: verificationSummary,
    failed_command_detail: failedCommandDetail,
    log_tails: logTails,
    watcher: status.watcher,
    pending_reason: status.pending_reason || null,
    execution_blocked: Boolean(status.execution_blocked),
    artifact_hygiene: artifactHygiene,
  };
  if ((options.view || "standard") === "compact") {
    return buildCompactSummary(output, normalizeMaxItems(options.max_items));
  }
  const safe = redactSensitiveValue(output);
  return {
    ...safe.value,
    redacted: safe.redacted,
    redaction_categories: safe.redaction_categories,
  } as TaskSummaryOutput;
}

function buildCompactSummary(output: Record<string, unknown>, maxItems: number): CompactTaskSummaryOutput {
  const hygiene = asRecord(output.artifact_hygiene);
  const groupNames = [
    "source_changes",
    "dependency_changes",
    "generated_changes",
    "runtime_changes",
    "unexpected_changes",
    "tracked_build_artifacts",
    "ignored_untracked_artifacts",
    "runtime_generated_files",
    "suspicious_changes",
  ] as const;
  const groups = Object.fromEntries(groupNames.map((name) => [name, asArray(hygiene[name]).slice(0, maxItems)]));
  const truncated = groupNames.some((name) => asArray(hygiene[name]).length > maxItems);

  // Phase 6: Read artifact_manifest.json for release artifact info
  const taskDir = resolve(getTasksDir(getConfig()), String(output.task_id));
  const manifestRead = tryReadJson(join(taskDir, "artifact_manifest.json"));
  const manifest = asRecord(manifestRead.data);
  const releaseArtifacts = asArray(manifest.artifacts);
  const releaseArtifactPaths = releaseArtifacts
    .map((artifact) => String(asRecord(artifact).path || ""))
    .slice(0, maxItems);

  const compact = {
    view: "compact" as const,
    task_id: String(output.task_id),
    status: String(output.status),
    terminal: Boolean(output.terminal),
    history_state: output.history_state === "archived" ? "archived" as const : "active" as const,
    acceptance_status: output.acceptance_status,
    phase: String(output.phase),
    repo_path: String(output.repo_path),
    agent_runtime: Object.keys(asRecord(output.agent_runtime)).length > 0 ? asRecord(output.agent_runtime) : null,
    model_selection: Object.keys(asRecord(output.model_selection)).length > 0 ? asRecord(output.model_selection) : null,
    failure_category: output.failure_category ? String(output.failure_category) : null,
    agent_failure_category: output.agent_failure_category ? String(output.agent_failure_category) : null,
    failure_source: output.failure_source ? String(output.failure_source) : null,
    counts_against_agent: Boolean(output.counts_against_agent),
    fallback_eligible: Boolean(output.fallback_eligible),
    retryable: Boolean(output.retryable),
    completion_state: deriveCompletionState({
      status: String(output.status || "unknown"),
      verify_status: String(output.verify_status || "not_available"),
      runtime_validation: output.runtime_validation,
      manual_scope_review_required: Boolean(output.manual_scope_review_required),
      acceptance_status: String(output.acceptance_status || "") || null,
    }),
    provider_error_reference: output.provider_error_reference ? String(output.provider_error_reference) : null,
    changed_files_total: asArray(output.changed_files).length,
    out_of_scope_changes_total: asArray(output.out_of_scope_changes).length,
    manual_scope_review_required: Boolean(output.manual_scope_review_required),
    runtime_validation: Object.keys(asRecord(output.runtime_validation)).length > 0 ? asRecord(output.runtime_validation) : null,
    project_fact_validation: Object.keys(asRecord(output.project_fact_validation)).length > 0 ? asRecord(output.project_fact_validation) : null,
    framework_validation: Object.keys(asRecord(output.framework_validation)).length > 0 ? asRecord(output.framework_validation) : null,
    svg_xml_validation: Object.keys(asRecord(output.svg_xml_validation)).length > 0 ? asRecord(output.svg_xml_validation) : null,
    acceptance_report: Object.keys(asRecord(output.acceptance_report)).length > 0 ? asRecord(output.acceptance_report) : null,
    artifact_hygiene: {
      counts: asRecord(hygiene.counts) as Record<string, number>,
      ...groups,
      max_items: maxItems,
      truncated,
    },
    release_artifacts_count: releaseArtifacts.length,
    release_artifact_paths: releaseArtifactPaths,
    artifact_status: String(output.artifact_status || manifest.status || "collected"),
    verification_summary: output.verification_summary,
    summary: String(output.summary).slice(0, 1000),
    warnings: asArray(output.warnings).slice(0, maxItems),
    information: asArray(output.information).slice(0, maxItems),
    errors: asArray(output.errors).slice(0, maxItems),
    failure_reason: output.failure_reason || null,
    failed_command: output.failed_command || null,
    suggested_next_action: String(output.suggested_next_action),
    execution_blocked: Boolean(output.execution_blocked),
    pending_reason: output.pending_reason || null,
  };
  const safe = redactSensitiveValue(compact);
  return {
    ...safe.value,
    redacted: safe.redacted,
    redaction_categories: safe.redaction_categories,
  } as CompactTaskSummaryOutput;
}

function normalizeMaxItems(value: number | undefined): number {
  if (value === undefined) return 8;
  if (!Number.isInteger(value) || value < 1 || value > 50) {
    throw new Error("max_items must be an integer from 1 to 50.");
  }
  return value;
}

function isInformationalEvidence(warning: string): boolean {
  return warning.startsWith("repository is not a Git worktree")
    || warning.startsWith("Repository is not a Git worktree")
    || warning.startsWith("Pre-existing external dirty files (not caused by this task)");
}

function readChangeAttribution(value: unknown): Record<"task_owned_change" | "concurrent_external_change" | "preexisting_change" | "unattributed_change", number> & { manual_scope_review_required: boolean } | null {
  const raw = asRecord(value);
  const rawCounts = asRecord(raw.counts);
  if (Object.keys(rawCounts).length === 0) return null;
  const count = (kind: "task_owned_change" | "concurrent_external_change" | "preexisting_change" | "unattributed_change") => {
    const candidate = Number(rawCounts[kind] ?? 0);
    return Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : 0;
  };
  return {
    task_owned_change: count("task_owned_change"),
    concurrent_external_change: count("concurrent_external_change"),
    preexisting_change: count("preexisting_change"),
    unattributed_change: count("unattributed_change"),
    manual_scope_review_required: raw.manual_scope_review_required === true,
  };
}

function tryReadJson(path: string): { data: Record<string, unknown>; error?: string } {
  if (!existsSync(path)) return { data: {} };
  try {
    return { data: asRecord(JSON.parse(readTextFilePrefixSync(path, 2 * 1024 * 1024).content)) };
  } catch (error) {
    return { data: {}, error: error instanceof Error ? error.message : String(error) };
  }
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function summarizeTestLog(path: string): string {
  if (!existsSync(path)) return "test.log missing";
  const text = readTextFileTailLinesSync(path, 200, 512 * 1024);
  const exit = text.match(/Exit\s*code:\s*([^\r\n]+)/i)?.[1]?.trim();
  return exit ? `Exit code: ${exit}` : text.trim().slice(0, 500) || "test.log empty";
}

function readResultFallback(path: string): string {
  if (!existsSync(path)) return "";
  const text = readTextFilePrefixSync(path, 1024 * 1024).content;
  return text.match(/## Summary\s+([\s\S]*?)(?:\n## |\n---|$)/i)?.[1]?.trim().slice(0, 1000) || "";
}

function buildVerificationSummary(
  status: string,
  configuredCommands: unknown[],
  executedCommands: unknown[],
  testLogSummary: string,
  reason: string | null,
) {
  const commandRecords = executedCommands.map(asRecord);
  const passed = commandRecords.filter((command) => command.status === "passed").length;
  const failed = commandRecords.filter((command) => ["failed", "timed_out", "canceled"].includes(String(command.status || ""))).length;
  const skipped = commandRecords.filter((command) => command.status === "skipped").length;
  const evidenceText = [
    ...commandRecords.flatMap((command) => [command.stdout_tail, command.stderr_tail]),
    testLogSummary,
  ].filter((value): value is string => typeof value === "string").join("\n");
  const headline = status === "not_run" && reason === "agent_failed_before_verification"
    ? "Verification not run because the agent failed before verification"
    : extractTestHeadline(evidenceText)
      || (executedCommands.length > 0
        ? `${passed}/${executedCommands.length} verification commands passed`
        : configuredCommands.length > 0 ? "Verification configured but not executed" : testLogSummary);
  return {
    status,
    command_count: executedCommands.length,
    configured_command_count: configuredCommands.length,
    passed_commands: passed,
    failed_commands: failed,
    skipped_commands: skipped,
    headline,
    reason,
  };
}

function extractTestHeadline(text: string): string {
  const patterns = [
    /\b\d+\s+passed(?:,\s*\d+\s+failed)?\b/i,
    /\b\d+\s+tests?\s+passed\b/i,
    /\btests?:\s*\d+\s+passed(?:,\s*\d+\s+failed)?\b/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[0];
  }
  return "";
}

function readLogTail(path: string, lines: number): string {
  if (!existsSync(path)) return "(file not found)";
  try {
    const tail = readTextFileTailLinesSync(path, lines);
    return tail || "(empty)";
  } catch {
    return "(unreadable)";
  }
}

function safeProviderErrorReference(value: unknown): string | null {
  return typeof value === "string" && /^err_[A-Za-z0-9_-]{4,120}$/.test(value) ? value : null;
}
