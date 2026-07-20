import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { createSubgoalTask } from "../../../tools/goals/goalSubgoalTask.js";
import { PatchWardenError } from "../../../errors.js";
import { createGoal } from "../../../goal/goalStore.js";
import { reloadConfig } from "../../../config.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Tests ─────────────────────────────────────────────────────────
//
// 说明：createSubgoalTask 内部调用 createTask，后者使用 getConfig()（无 workspaceRoot
// 覆盖），因此 happy-path 依赖真实配置的工作区，留待集成测试覆盖。
// 此处仅测试不触及 createTask 完整流程的错误路径：
//   - invalid_execution_mode：在读取 goal 之前即抛错
//   - goal_not_found：readGoalStatus 在默认工作区找不到 goal 即抛错

describe("createSubgoalTask", () => {

  describe("错误路径", () => {
    it("execution_mode=assess_only 抛 invalid_execution_mode", async () => {
      await assert.rejects(
        () =>
          createSubgoalTask({
            goal_id: "goal_nonexistent_test",
            subgoal_title: "Sub A",
            repo_path: "repo",
            execution_mode: "assess_only",
          }),
        (err: unknown) => {
          assert.ok(err instanceof PatchWardenError);
          assert.equal(err.reason, "invalid_execution_mode");
          assert.equal(err.blocked, true);
          return true;
        }
      );
    });

    it("goal_id 不存在抛 goal_not_found", async () => {
      await assert.rejects(
        () =>
          createSubgoalTask({
            goal_id: "goal_definitely_does_not_exist_99999",
            subgoal_title: "Sub A",
            repo_path: "repo",
          }),
        (err: unknown) => {
          assert.ok(err instanceof PatchWardenError);
          assert.equal(err.reason, "goal_not_found");
          assert.equal(err.blocked, true);
          assert.ok(err.details.goal_id === "goal_definitely_does_not_exist_99999");
          return true;
        }
      );
    });

    it("assess_only 优先于 goal_not_found（在读取 goal 前校验）", async () => {
      // execution_mode=assess_only 应先抛 invalid_execution_mode，
      // 而不是去读不存在的 goal
      await assert.rejects(
        () =>
          createSubgoalTask({
            goal_id: "goal_definitely_does_not_exist_99999",
            subgoal_title: "Sub A",
            repo_path: "repo",
            execution_mode: "assess_only",
          }),
        (err: unknown) => {
          assert.ok(err instanceof PatchWardenError);
          assert.equal(err.reason, "invalid_execution_mode");
          return true;
        }
      );
    });

    it("rejects a repo_path that differs from the Goal's bound repository", async () => {
      const root = mkdtempSync(join(tmpdir(), "patchwarden-goal-repo-"));
      const previousConfig = process.env.PATCHWARDEN_CONFIG;
      try {
        const repoA = join(root, "repo-a");
        const repoB = join(root, "repo-b");
        mkdirSync(repoA, { recursive: true });
        mkdirSync(repoB, { recursive: true });
        const configPath = join(root, "patchwarden.config.json");
        writeFileSync(configPath, JSON.stringify({ workspaceRoot: root, agents: {} }), "utf-8");
        process.env.PATCHWARDEN_CONFIG = configPath;
        reloadConfig();
        const goal = createGoal(repoA, "Bound repo", "test", root);

        await assert.rejects(
          createSubgoalTask({
            goal_id: goal.goal_id,
            subgoal_title: "Wrong repo",
            repo_path: repoB,
            isolate_worktree: false,
          }),
          (error: unknown) =>
            error instanceof PatchWardenError && error.reason === "goal_repo_mismatch",
        );
      } finally {
        if (previousConfig === undefined) delete process.env.PATCHWARDEN_CONFIG;
        else process.env.PATCHWARDEN_CONFIG = previousConfig;
        reloadConfig();
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
});
