import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { deriveTaskObservability } from "../../../control/runtime.js";

const watcher: any = { status: "healthy", available: true, last_heartbeat_at: "2026-07-29T00:00:00.000Z", heartbeat_age_seconds: 1 };
const task: any = { status: "running", phase: "running_agent", acceptance_status: null, current_command: "codex exec", last_heartbeat_at: "2026-07-29T00:00:00.000Z" };

describe("task observability", () => {
  it("distinguishes an Agent that is still running from connector visibility and Watcher health", () => {
    const result = deriveTaskObservability(task, watcher, { is_stale: false, stale_reasons: [] }, Date.parse("2026-07-29T00:00:05.000Z"));
    assert.equal(result.task_state, "agent_running");
    assert.equal(result.agent_state, "running");
    assert.equal(result.watcher_state, "healthy");
    assert.equal(result.connector_state, "not_observable_server_side");
    assert.equal(result.heartbeat_age_seconds, 5);
    assert.equal(result.current_command, "codex exec");
  });

  it("distinguishes a stale task and a user-confirmation wait", () => {
    assert.equal(deriveTaskObservability(task, watcher, { is_stale: true, stale_reasons: ["heartbeat_stale"] }).task_state, "task_stuck");
    assert.equal(deriveTaskObservability({ ...task, status: "done_by_agent", acceptance_status: "blocked" }, watcher, { is_stale: false, stale_reasons: [] }).task_state, "awaiting_user_confirmation");
  });
});
