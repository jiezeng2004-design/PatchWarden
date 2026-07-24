import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAssessmentsDir, getConfig } from "../config.js";
import { guardPath } from "../security/pathGuard.js";
import { atomicWriteJsonFileSync } from "../utils/atomicFile.js";
import { readJsonObjectFileSync } from "../utils/lockedJsonFile.js";
import type { AssessmentValidationResult } from "./assessmentStore.js";
import { ASSESSMENT_SECURITY_SNAPSHOT_VERSION } from "./securitySnapshot.js";
import { PATCHWARDEN_VERSION, TOOL_SCHEMA_EPOCH } from "../version.js";

const DIAGNOSTIC_VERSION = "assessment-validation-diagnostic-v2";
const DIAGNOSTIC_FILE = "last-validation-failure.json";
const VALIDATOR_MODULE_PATH = "dist/assessments/assessmentStore.js";
const VALIDATOR_BUILD_ID = `patchwarden-${PATCHWARDEN_VERSION}:${TOOL_SCHEMA_EPOCH}:${ASSESSMENT_SECURITY_SNAPSHOT_VERSION}`;

export interface AssessmentValidationFailureDiagnostic {
  diagnostic_version: string;
  error_code: string;
  reason_code: string;
  assessment_id: string | null;
  assessment_config_sha256: string | null;
  current_config_sha256: string | null;
  assessment_config_hash: string | null;
  current_config_hash: string | null;
  snapshot_version: string | null;
  assessment_fingerprint_version: string | null;
  current_fingerprint_version: string;
  assessment_schema_epoch: string | null;
  current_schema_epoch: string;
  assessment_created_at: string | null;
  assessment_expires_at: string | null;
  config_changed: boolean;
  changed_field_names: string[];
  changed_config_sections: string[];
  validator_module_path: string;
  validator_build_id: string;
  watcher_instance_id: string | null;
  observed_at: string;
}

export function buildAssessmentValidationFailureDiagnostic(
  result: AssessmentValidationResult,
): AssessmentValidationFailureDiagnostic | null {
  if (result.valid || !result.failure_reason) return null;
  const reasonCode = safeCode(result.failure_reason);
  const assessmentHash = safeHash(result.expected_hash);
  const currentHash = safeHash(result.actual_hash);
  const changedSections = [...new Set((result.config_change_categories || [])
    .map((name) => safeCode(name))
    .filter(Boolean))]
    .sort()
    .slice(0, 32);
  const assessmentVersion = safeText(result.assessment?.assessment_security_snapshot_version, 80);
  return {
    diagnostic_version: DIAGNOSTIC_VERSION,
    error_code: reasonCode,
    reason_code: reasonCode,
    assessment_id: safeAssessmentId(result.assessment?.assessment_id),
    assessment_config_sha256: assessmentHash,
    current_config_sha256: currentHash,
    assessment_config_hash: assessmentHash,
    current_config_hash: currentHash,
    snapshot_version: assessmentVersion,
    assessment_fingerprint_version: assessmentVersion,
    current_fingerprint_version: ASSESSMENT_SECURITY_SNAPSHOT_VERSION,
    assessment_schema_epoch: safeText(result.assessment?.assessment_schema_epoch, 80),
    current_schema_epoch: TOOL_SCHEMA_EPOCH,
    assessment_created_at: safeTimestamp(result.assessment?.created_at),
    assessment_expires_at: safeTimestamp(result.assessment?.expires_at),
    config_changed: result.failure_reason === "assessment_stale_config",
    changed_field_names: changedSections,
    changed_config_sections: changedSections,
    validator_module_path: VALIDATOR_MODULE_PATH,
    validator_build_id: VALIDATOR_BUILD_ID,
    watcher_instance_id: safeInstanceId(process.env.PATCHWARDEN_WATCHER_INSTANCE_ID),
    observed_at: new Date().toISOString(),
  };
}

/** Persist a bounded value-free failure summary without changing validation behavior. */
export function recordAssessmentValidationFailure(result: AssessmentValidationResult): boolean {
  const diagnostic = buildAssessmentValidationFailureDiagnostic(result);
  if (!diagnostic) return false;
  try {
    const config = getConfig();
    const assessmentsDir = getAssessmentsDir(config);
    const file = guardPath(
      join(assessmentsDir, DIAGNOSTIC_FILE),
      config.workspaceRoot,
      config.assessmentsDir,
    );
    mkdirSync(dirname(file), { recursive: true });
    atomicWriteJsonFileSync(file, diagnostic);
    return true;
  } catch {
    // Diagnostics must never replace the original fail-closed validation error.
    return false;
  }
}

export function readLastAssessmentValidationFailure(): AssessmentValidationFailureDiagnostic | null {
  try {
    const config = getConfig();
    const file = guardPath(
      join(getAssessmentsDir(config), DIAGNOSTIC_FILE),
      config.workspaceRoot,
      config.assessmentsDir,
    );
    if (!existsSync(file)) return null;
    const raw = readJsonObjectFileSync<Record<string, unknown>>(file);
    if (raw.diagnostic_version !== DIAGNOSTIC_VERSION) return null;
    const changedSections = Array.isArray(raw.changed_config_sections)
      ? [...new Set(raw.changed_config_sections.map(safeCode).filter(Boolean))].sort().slice(0, 32)
      : [];
    return {
      diagnostic_version: DIAGNOSTIC_VERSION,
      error_code: safeCode(raw.error_code),
      reason_code: safeCode(raw.reason_code),
      assessment_id: safeAssessmentId(raw.assessment_id),
      assessment_config_sha256: safeHash(raw.assessment_config_sha256),
      current_config_sha256: safeHash(raw.current_config_sha256),
      assessment_config_hash: safeHash(raw.assessment_config_hash),
      current_config_hash: safeHash(raw.current_config_hash),
      snapshot_version: safeText(raw.snapshot_version, 80),
      assessment_fingerprint_version: safeText(raw.assessment_fingerprint_version, 80),
      current_fingerprint_version: safeText(raw.current_fingerprint_version, 80) || ASSESSMENT_SECURITY_SNAPSHOT_VERSION,
      assessment_schema_epoch: safeText(raw.assessment_schema_epoch, 80),
      current_schema_epoch: safeText(raw.current_schema_epoch, 80) || TOOL_SCHEMA_EPOCH,
      assessment_created_at: safeTimestamp(raw.assessment_created_at),
      assessment_expires_at: safeTimestamp(raw.assessment_expires_at),
      config_changed: raw.config_changed === true,
      changed_field_names: Array.isArray(raw.changed_field_names)
        ? [...new Set(raw.changed_field_names.map(safeCode).filter(Boolean))].sort().slice(0, 32)
        : [],
      changed_config_sections: changedSections,
      validator_module_path: safeText(raw.validator_module_path, 120) || VALIDATOR_MODULE_PATH,
      validator_build_id: safeText(raw.validator_build_id, 160) || VALIDATOR_BUILD_ID,
      watcher_instance_id: safeInstanceId(raw.watcher_instance_id),
      observed_at: safeTimestamp(raw.observed_at) || new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

function safeAssessmentId(value: unknown): string | null {
  return typeof value === "string" && /^assessment_\d{8}_\d{6}_[0-9a-f]{32}$/.test(value) ? value : null;
}

function safeInstanceId(value: unknown): string | null {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value) ? value : null;
}

function safeCode(value: unknown): string {
  return typeof value === "string" && /^[a-z0-9_]{1,80}$/.test(value) ? value : "";
}

function safeHash(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value) ? value : null;
}

function safeText(value: unknown, maxLength: number): string | null {
  return typeof value === "string" && value.length > 0
    ? value.replace(/[\r\n]+/g, " ").slice(0, maxLength)
    : null;
}

function safeTimestamp(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : null;
}
