import { PatchWardenError } from "../errors.js";
import { readAssessment } from "../assessments/assessmentStore.js";
import type { ToolRisk } from "../tools/catalog/toolRegistry.js";

export interface InvocationAssessmentResult {
  dispatchArgs: Record<string, unknown>;
}

/** Bind a dynamic high-risk call to a real, one-use assessment contract. */
export function validateInvocationAssessment(
  toolName: string,
  risk: ToolRisk,
  args: Record<string, unknown>,
  assessmentId: string | undefined,
): InvocationAssessmentResult {
  if (risk !== "workspace_write" && risk !== "release") return { dispatchArgs: args };
  const id = String(assessmentId || "").trim();
  if (!id) {
    throw new PatchWardenError(
      risk === "release" ? "release_confirmation_required" : "assessment_required",
      `Tool "${toolName}" requires an authoritative assessment.`,
      "Run the supported assessment flow and pass the complete assessment_id.",
      true,
      { tool: toolName, risk },
    );
  }
  // create_task currently owns the only full assess -> freshness check ->
  // atomic consume contract. Never let an unrelated assessment authorize a
  // different workspace-write or release tool.
  if (toolName !== "create_task") {
    throw new PatchWardenError(
      risk === "release" ? "release_assessment_unsupported" : "assessment_tool_mismatch",
      `Tool "${toolName}" does not own an assessment consumption contract for dynamic invocation.`,
      "Invoke the tool through its dedicated guarded flow; arbitrary assessment IDs cannot authorize it.",
      true,
      { tool: toolName, risk },
    );
  }
  if (args.assessment_id !== undefined && String(args.assessment_id) !== id) {
    throw new PatchWardenError(
      "assessment_parameter_mismatch",
      "The wrapper assessmentId and create_task assessment_id do not match.",
      "Pass one complete assessment ID consistently.",
      true,
      { tool: toolName },
    );
  }
  if (args.execution_mode !== undefined && args.execution_mode !== "execute") {
    throw new PatchWardenError(
      "assessment_parameter_mismatch",
      "A dynamic assessed create_task invocation must use execution_mode=execute.",
      "Run assess_only through the dedicated create_task flow, then invoke the assessed execution.",
      true,
      { tool: toolName, field: "execution_mode" },
    );
  }
  const assessment = readAssessment(id);
  if (Date.parse(assessment.expires_at) <= Date.now()) {
    throw new PatchWardenError(
      "assessment_expired",
      `Assessment "${id}" has expired.`,
      "Run assess_only again and use the new complete assessment_id.",
      true,
      { assessment_id: id, expires_at: assessment.expires_at },
    );
  }
  if (assessment.used_at) {
    throw new PatchWardenError(
      "assessment_used",
      `Assessment "${id}" has already been used.`,
      "Run assess_only again; assessments authorize one task only.",
      true,
      { assessment_id: id, used_at: assessment.used_at },
    );
  }
  if (assessment.decision === "blocked") {
    throw new PatchWardenError(
      "assessment_blocked",
      `Assessment "${id}" is blocked by policy.`,
      "Resolve the policy findings and create a new assessment.",
      true,
      { assessment_id: id },
    );
  }
  if (assessment.requires_confirm && !assessment.confirmed) {
    throw new PatchWardenError(
      "assessment_confirmation_required",
      `Assessment "${id}" still requires local confirmation.`,
      "Run patchwarden-confirm locally, then retry before expiry.",
      true,
      { assessment_id: id },
    );
  }
  return {
    dispatchArgs: { ...args, assessment_id: id, execution_mode: "execute" },
  };
}
