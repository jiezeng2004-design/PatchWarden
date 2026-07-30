import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { buildExternalChangeAttribution } from "../../../runner/changeAttribution.js";

describe("external change attribution", () => {
  it("keeps baseline dirty paths separate from task-window changes", () => {
    const report = buildExternalChangeAttribution({
      taskId: "task-1",
      runnerPid: 100,
      agentChildPid: 101,
      preexisting: [{ path: "outside-before.txt", change: "modified", before_sha256: "before", after_sha256: "before" }],
      duringTask: [{ path: "outside-during.txt", change: "modified", before_sha256: "before", after_sha256: "after" }],
    });

    assert.deepEqual(report.counts, {
      task_owned_change: 0,
      concurrent_external_change: 0,
      preexisting_change: 1,
      unattributed_change: 1,
    });
    assert.equal(report.changes[0]?.attribution, "preexisting_change");
    assert.equal(report.changes[1]?.attribution, "unattributed_change");
    assert.equal(report.changes[1]?.evidence.runner_pid, 100);
    assert.equal(report.changes[1]?.evidence.agent_child_pid, 101);
  });

  it("requires manual review rather than claiming ownership without a process-scoped file event", () => {
    const report = buildExternalChangeAttribution({
      taskId: "task-2",
      runnerPid: 200,
      preexisting: [],
      duringTask: [{ path: "outside.txt", change: "added", before_sha256: null, after_sha256: "after" }],
    });

    assert.equal(report.counts.task_owned_change, 0);
    assert.equal(report.counts.unattributed_change, 1);
    assert.equal(report.changes[0]?.evidence.process_file_event_observed, false);
    assert.equal(report.manual_scope_review_required, true);
    assert.equal(report.automatic_rollback_safe, false);
  });
});
