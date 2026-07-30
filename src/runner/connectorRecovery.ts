import type { WatcherStatusSnapshot } from "../watcherStatus.js";

export interface ConnectorRecoveryState {
  connector: {
    state: "not_observable_server_side";
    failure_category: "connector_failure";
    counts_against_agent: false;
  };
  task: {
    state: "not_started" | "task_running" | "terminal";
    task_id: string | null;
  };
  agent: {
    state: "not_started" | "agent_running_or_queued" | "terminal";
    agent: string | null;
  };
  watcher: {
    state: WatcherStatusSnapshot["status"];
    healthy: boolean;
  };
  resume: {
    request_id: string;
    reuse_same_request_id: true;
    duplicate_task_creation_blocked: true;
  };
}

export function buildConnectorRecoveryState(input: {
  request_id: string;
  final_status: string;
  main_task: string | null;
  selected_agent: string | null;
  watcher: WatcherStatusSnapshot;
}): ConnectorRecoveryState {
  const terminal = input.final_status !== "running";
  return {
    connector: {
      state: "not_observable_server_side",
      failure_category: "connector_failure",
      counts_against_agent: false,
    },
    task: {
      state: input.main_task ? (terminal ? "terminal" : "task_running") : "not_started",
      task_id: input.main_task,
    },
    agent: {
      state: input.main_task ? (terminal ? "terminal" : "agent_running_or_queued") : "not_started",
      agent: input.selected_agent,
    },
    watcher: {
      state: input.watcher.status,
      healthy: input.watcher.available,
    },
    resume: {
      request_id: input.request_id,
      reuse_same_request_id: true,
      duplicate_task_creation_blocked: true,
    },
  };
}
