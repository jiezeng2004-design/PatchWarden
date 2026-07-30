import type { ExternalDirtyFile } from "./changeCapture.js";

export type ChangeAttributionKind =
  | "task_owned_change"
  | "concurrent_external_change"
  | "preexisting_change"
  | "unattributed_change";

export interface AttributedExternalChange extends ExternalDirtyFile {
  attribution: ChangeAttributionKind;
  evidence: {
    task_id: string;
    runner_pid: number;
    agent_child_pid: number | null;
    process_file_event_observed: boolean;
    reason: string;
  };
}

export interface ChangeAttributionReport {
  schema_version: "patchwarden-change-attribution-v1";
  task_id: string;
  generated_at: string;
  counts: Record<ChangeAttributionKind, number>;
  changes: AttributedExternalChange[];
  manual_scope_review_required: boolean;
  automatic_rollback_safe: boolean;
}

export function buildExternalChangeAttribution(input: {
  taskId: string;
  runnerPid: number;
  agentChildPid?: number | null;
  preexisting: ExternalDirtyFile[];
  duringTask: ExternalDirtyFile[];
}): ChangeAttributionReport {
  const baseEvidence = {
    task_id: input.taskId,
    runner_pid: input.runnerPid,
    agent_child_pid: input.agentChildPid ?? null,
    process_file_event_observed: false,
  };
  const changes: AttributedExternalChange[] = [
    ...input.preexisting.map((change) => ({
      ...change,
      attribution: "preexisting_change" as const,
      evidence: { ...baseEvidence, reason: "Path was dirty in the workspace snapshot captured before task execution." },
    })),
    ...input.duringTask.map((change) => ({
      ...change,
      attribution: "unattributed_change" as const,
      evidence: { ...baseEvidence, reason: "The path changed during the task window, but no process-scoped filesystem event proves which process wrote it." },
    })),
  ];
  const counts: Record<ChangeAttributionKind, number> = {
    task_owned_change: 0,
    concurrent_external_change: 0,
    preexisting_change: 0,
    unattributed_change: 0,
  };
  for (const change of changes) counts[change.attribution] += 1;
  return {
    schema_version: "patchwarden-change-attribution-v1",
    task_id: input.taskId,
    generated_at: new Date().toISOString(),
    counts,
    changes,
    manual_scope_review_required: counts.concurrent_external_change > 0 || counts.unattributed_change > 0,
    automatic_rollback_safe: counts.task_owned_change > 0 && counts.concurrent_external_change === 0 && counts.unattributed_change === 0,
  };
}
