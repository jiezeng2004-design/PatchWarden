import { join } from "node:path";
import { pathToFileURL } from "node:url";

export interface CoreValidatedAgentSelection {
  readonly id: string;
  readonly enabled?: boolean;
  readonly model?: string | null;
  readonly envAllowlist?: readonly string[];
}

export type CoreModelValidationReason = "invalid_model" | "save_failed";

export class CoreModelValidationError extends Error {
  readonly reasonCode: CoreModelValidationReason;

  constructor(reasonCode: CoreModelValidationReason) {
    super(reasonCode);
    this.name = "CoreModelValidationError";
    this.reasonCode = reasonCode;
  }
}

/** Preflight Desktop selections with the exact validator shipped by Core. */
export async function validateAgentSelectionsWithCore<T extends CoreValidatedAgentSelection>(
  coreRoot: string,
  selections: readonly T[],
): Promise<T[]> {
  const moduleUrl = pathToFileURL(join(coreRoot, "dist", "agents", "modelSelection.js")).href;
  let optionalModel: ((value: unknown, field: string) => string | null) | null = null;
  try {
    const loaded: unknown = await import(moduleUrl);
    if (isRecord(loaded) && typeof loaded.optionalModel === "function") {
      optionalModel = loaded.optionalModel as (value: unknown, field: string) => string | null;
    }
  } catch {
    throw new CoreModelValidationError("save_failed");
  }
  if (!optionalModel) throw new CoreModelValidationError("save_failed");

  try {
    return selections.map((selection) => selection.model === undefined
      ? { ...selection }
      : { ...selection, model: optionalModel!(selection.model, `agents[${JSON.stringify(selection.id)}].default_model`) });
  } catch {
    throw new CoreModelValidationError("invalid_model");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

