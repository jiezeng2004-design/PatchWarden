import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { buildConnectorRecoveryState } from "../../../runner/connectorRecovery.js";

describe("connector recovery state", () => {
  it("separates an unobservable connector from running task, Agent, and Watcher state", () => {
    const state = buildConnectorRecoveryState({
      request_id: "request-502-retry",
      final_status: "running",
      main_task: "task-running",
      selected_agent: "codex",
      watcher: {
        status: "healthy",
        available: true,
        last_heartbeat_at: "2026-07-29T00:00:00.000Z",
        heartbeat_age_seconds: 1,
        stale_after_seconds: 30,
        heartbeat_pid: 42,
        instance_id: "watcher-test",
        launcher_pid: 41,
        reason: null,
        activity: "running task",
      },
    });

    assert.equal(state.connector.state, "not_observable_server_side");
    assert.equal(state.connector.counts_against_agent, false);
    assert.equal(state.task.state, "task_running");
    assert.equal(state.agent.state, "agent_running_or_queued");
    assert.equal(state.watcher.healthy, true);
    assert.equal(state.resume.reuse_same_request_id, true);
    assert.equal(state.resume.duplicate_task_creation_blocked, true);
  });
});
