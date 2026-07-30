import type { CompletionState } from "./completionState.js";

export interface LowNoiseAcceptanceReport {
  source_changes: number;
  generated_changes: number;
  scope_violations: number;
  verification: Record<string, string>;
  runtime_validation: {
    status: string;
    routes_checked: number;
    broken_images: number;
    console_errors: number;
  };
  audit: string;
  manual_items: string[];
  acceptance_status: "accepted" | "user_acceptance_ready" | "manual_review_required" | "needs_fix";
  expandable_evidence: {
    diff: string;
    logs: string[];
    details: string[];
  };
}

export function buildLowNoiseAcceptanceReport(input: {
  source_changes: number;
  generated_changes: number;
  scope_violations: number;
  verification_commands: Array<{ command?: string; status?: string }>;
  runtime_validation?: unknown;
  completion_state: CompletionState;
  audit?: string;
  manual_items?: string[];
}): LowNoiseAcceptanceReport {
  const runtime = asRecord(input.runtime_validation);
  const routeResults = Array.isArray(runtime.route_results) ? runtime.route_results.map(asRecord) : [];
  const manualItems = [...new Set((input.manual_items || []).filter(Boolean))].slice(0, 50);
  if (input.completion_state.manual_review_required && manualItems.length === 0) {
    manualItems.push(input.completion_state.runtime_validation_required
      ? "Complete the recorded manual review items before acceptance."
      : "Runtime validation was not configured; complete an equivalent manual/browser review before acceptance.");
  }
  const acceptanceStatus = input.completion_state.accepted
    ? "accepted"
    : input.completion_state.user_acceptance_ready
      ? "user_acceptance_ready"
      : input.completion_state.manual_review_required
        ? "manual_review_required"
        : "needs_fix";
  return {
    source_changes: nonNegative(input.source_changes),
    generated_changes: nonNegative(input.generated_changes),
    scope_violations: nonNegative(input.scope_violations),
    verification: Object.fromEntries(input.verification_commands.slice(0, 50).map((entry, index) => [
      String(entry.command || `command_${index + 1}`).slice(0, 240),
      String(entry.status || "unknown").slice(0, 40),
    ])),
    runtime_validation: {
      status: String(runtime.status || "not_configured"),
      routes_checked: nonNegative(Number(runtime.routes_checked ?? routeResults.length)),
      broken_images: routeResults.reduce((total, result) => total + nonNegative(Number(result.broken_images || 0)), 0),
      console_errors: routeResults.reduce((total, result) => total + nonNegative(Number(result.console_errors || 0)), 0),
    },
    audit: String(input.audit || "not_run"),
    manual_items: manualItems,
    acceptance_status: acceptanceStatus,
    expandable_evidence: {
      diff: "diff.patch",
      logs: ["stdout.log", "stderr.log", "test.log", "verify.log"],
      details: ["result.json", "changed-files.json", "audit.json", "runtime-validation.json"],
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function nonNegative(value: number): number { return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0; }
