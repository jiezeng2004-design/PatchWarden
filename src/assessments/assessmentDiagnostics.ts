import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAssessmentsDir, getConfig } from "../config.js";
import { guardPath } from "../security/pathGuard.js";
import { atomicWriteJsonFileSync } from "../utils/atomicFile.js";
import { readJsonObjectFileSync } from "../utils/lockedJsonFile.js";
import type { AssessmentValidationResult } from "./assessmentStore.js";

const DIAGNOSTIC_VERSION = "assessment-validation-diagnostic-v1";
const DIAGNOSTIC_FILE = "last-validation-failure.json";

export interface AssessmentValidationFailureDiagnostic {
  diagnostic_version: string;
  reason_code: string;
  assessment_config_sha256: string | null;
  current_config_sha256: string | null;
  snapshot_version: string | null;
  assessment_created_at: string | null;
  assessment_expires_at: string | null;
  config_changed: boolean;
  changed_field_names: string[];
  observed_at: string;
}

/** Persist a bounded value-free failure summary without changing validation behavior. */
export function recordAssessmentValidationFailure(result: AssessmentValidationResult): boolean {
  if (result.valid || !result.failure_reason) return false;
  try {
    const config = getConfig();
    const assessmentsDir = getAssessmentsDir(config);
    const file = guardPath(
      join(assessmentsDir, DIAGNOSTIC_FILE),
      config.workspaceRoot,
      config.assessmentsDir,
    );
    mkdirSync(dirname(file), { recursive: true });
    const diagnostic: AssessmentValidationFailureDiagnostic = {
      diagnostic_version: DIAGNOSTIC_VERSION,
      reason_code: safeCode(result.failure_reason),
      assessment_config_sha256: safeHash(result.expected_hash),
      current_config_sha256: safeHash(result.actual_hash),
      snapshot_version: safeText(result.assessment?.assessment_security_snapshot_version, 80),
      assessment_created_at: safeTimestamp(result.assessment?.created_at),
      assessment_expires_at: safeTimestamp(result.assessment?.expires_at),
      config_changed: result.failure_reason === "assessment_stale_config",
      changed_field_names: [...new Set((result.config_change_categories || [])
        .map((name) => safeCode(name))
        .filter(Boolean))]
        .sort()
        .slice(0, 32),
      observed_at: new Date().toISOString(),
    };
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
    return {
      diagnostic_version: DIAGNOSTIC_VERSION,
      reason_code: safeCode(raw.reason_code),
      assessment_config_sha256: safeHash(raw.assessment_config_sha256),
      current_config_sha256: safeHash(raw.current_config_sha256),
      snapshot_version: safeText(raw.snapshot_version, 80),
      assessment_created_at: safeTimestamp(raw.assessment_created_at),
      assessment_expires_at: safeTimestamp(raw.assessment_expires_at),
      config_changed: raw.config_changed === true,
      changed_field_names: Array.isArray(raw.changed_field_names)
        ? [...new Set(raw.changed_field_names.map(safeCode).filter(Boolean))].sort().slice(0, 32)
        : [],
      observed_at: safeTimestamp(raw.observed_at) || new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
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
