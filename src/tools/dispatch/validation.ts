import type { PatchOperation, PatchOperationType } from "../../direct/directPatch.js";
import type { ReleaseStage } from "../../release/releaseGate.js";
import { TASK_TEMPLATE_NAMES, type TaskTemplateName } from "../taskTemplates.js";

const RELEASE_STAGES: ReadonlySet<ReleaseStage> = new Set([
  "local_ready",
  "packed_ready",
  "published_verified",
  "github_release_verified",
  "ci_verified",
]);
const PATCH_OPERATION_TYPES: ReadonlySet<PatchOperationType> = new Set([
  "replace_exact",
  "insert_before",
  "insert_after",
  "replace_whole_file",
]);
const PATCH_OCCURRENCES = new Set(["first", "all", "exactly_once"]);
const TASK_LOG_FILES = new Set(["stdout", "stderr", "test", "verify"]);

export function parseOptionalTaskTemplate(value: unknown): TaskTemplateName | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !TASK_TEMPLATE_NAMES.includes(value as TaskTemplateName)) {
    throw new Error(`template must be one of: ${TASK_TEMPLATE_NAMES.join(", ")}`);
  }
  return value as TaskTemplateName;
}

export function parseReleaseStage(value: unknown): ReleaseStage {
  const stage = value === undefined || value === null || value === ""
    ? "local_ready"
    : String(value);
  if (!RELEASE_STAGES.has(stage as ReleaseStage)) {
    throw new Error(`target_stage must be one of: ${[...RELEASE_STAGES].join(", ")}`);
  }
  return stage as ReleaseStage;
}

export function parseTaskLogFile(value: unknown): "stdout" | "stderr" | "test" | "verify" {
  const file = value === undefined || value === null || value === "" ? "stdout" : String(value);
  if (!TASK_LOG_FILES.has(file)) {
    throw new Error(`file must be one of: ${[...TASK_LOG_FILES].join(", ")}`);
  }
  return file as "stdout" | "stderr" | "test" | "verify";
}

export function parsePatchOperations(value: unknown): PatchOperation[] {
  if (!Array.isArray(value)) throw new Error("operations must be an array");
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`operations[${index}] must be an object`);
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.type !== "string" || !PATCH_OPERATION_TYPES.has(record.type as PatchOperationType)) {
      throw new Error(`operations[${index}].type is invalid`);
    }
    if (typeof record.new_text !== "string") {
      throw new Error(`operations[${index}].new_text must be a string`);
    }
    if (record.old_text !== undefined && typeof record.old_text !== "string") {
      throw new Error(`operations[${index}].old_text must be a string`);
    }
    if (
      record.occurrence !== undefined
      && (typeof record.occurrence !== "string" || !PATCH_OCCURRENCES.has(record.occurrence))
    ) {
      throw new Error(`operations[${index}].occurrence is invalid`);
    }
    return {
      type: record.type as PatchOperationType,
      new_text: record.new_text,
      ...(record.old_text === undefined ? {} : { old_text: record.old_text }),
      ...(record.occurrence === undefined
        ? {}
        : { occurrence: record.occurrence as PatchOperation["occurrence"] }),
    };
  });
}
