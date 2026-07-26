import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { reloadConfig } from "../../../config.js";
import { migrateQueuedSubgoalsFromTasks } from "../../../goal/subgoalSync.js";
import { addSubgoal, linkTaskToSubgoal, updateSubgoalStatus } from "../../../goal/goalStatus.js";
import { createGoal, readGoalStatus, writeGoalStatus } from "../../../goal/goalStore.js";

describe("legacy queued subgoal migration", () => {
  let root: string;
  let previousConfigPath: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pw-goal-queue-migration-"));
    previousConfigPath = process.env.PATCHWARDEN_CONFIG;
    const configPath = join(root, "config.json");
    writeFileSync(configPath, JSON.stringify({ workspaceRoot: root, agents: {} }), "utf-8");
    process.env.PATCHWARDEN_CONFIG = configPath;
    reloadConfig(configPath);
  });

  afterEach(() => {
    if (previousConfigPath === undefined) delete process.env.PATCHWARDEN_CONFIG;
    else process.env.PATCHWARDEN_CONFIG = previousConfigPath;
    reloadConfig(previousConfigPath);
    rmSync(root, { recursive: true, force: true });
  });

  it("moves legacy running subgoals with pending tasks to queued", () => {
    const { goal_id: goalId } = createGoal("repo", "Legacy Goal", "desc", root);
    let goal = readGoalStatus(goalId, root);
    const added = addSubgoal(goal, "Pending task");
    goal = linkTaskToSubgoal(added.goalStatus, added.subgoalId, "task-legacy-pending");
    goal = updateSubgoalStatus(goal, added.subgoalId, "running");
    writeGoalStatus(goalId, goal, root);

    const taskDir = join(root, ".patchwarden", "tasks", "task-legacy-pending");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "status.json"), JSON.stringify({
      task_id: "task-legacy-pending",
      status: "pending",
      phase: "queued",
    }), "utf-8");

    assert.equal(migrateQueuedSubgoalsFromTasks(goalId, root), 1);
    const migrated = readGoalStatus(goalId, root).subgoals[0];
    assert.equal(migrated.status, "queued");
    assert.equal(migrated.last_task_status, "pending");
  });
});
