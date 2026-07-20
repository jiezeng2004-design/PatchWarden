import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGoal, readGoalStatus } from "../../../goal/goalStore.js";
import {
  importSpecKitTasks,
  parseSpecKitJson,
  type SpecKitInput,
} from "../../../goal/specKitImport.js";
import { PatchWardenError } from "../../../errors.js";

// ── Helpers ───────────────────────────────────────────────────────

let tempDir: string;
let goalId: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "pw-speckit-"));
  const result = createGoal("repo", "Spec Kit Test Goal", "desc", tempDir);
  goalId = result.goal_id;
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function makeStandardInput(): SpecKitInput {
  return {
    spec: "feature-auth",
    tasks: [
      {
        id: "T1",
        desc: "Set up database schema",
        files: ["src/db/schema.ts"],
      },
      {
        id: "T2",
        desc: "Implement auth service",
        files: ["src/auth/service.ts", "src/auth/types.ts"],
      },
      {
        id: "T3",
        desc: "Write integration tests",
        files: ["test/auth.test.ts"],
      },
    ],
  };
}

// ── Tests ─────────────────────────────────────────────────────────

describe("specKitImport", () => {

  describe("parseSpecKitJson", () => {
    it("解析合法 JSON 返回 SpecKitInput", () => {
      const json = JSON.stringify({
        spec: "my-spec",
        tasks: [
          { id: "T1", desc: "Task one", files: ["a.ts"] },
          { id: "T2", desc: "Task two", depends_on: ["T1"] },
        ],
        acceptance: ["T1 passes", "T2 passes"],
      });
      const input = parseSpecKitJson(json);
      assert.equal(input.spec, "my-spec");
      assert.equal(input.tasks.length, 2);
      assert.equal(input.tasks[0].id, "T1");
      assert.equal(input.tasks[0].desc, "Task one");
      assert.deepEqual(input.tasks[0].files, ["a.ts"]);
      assert.deepEqual(input.tasks[1].depends_on, ["T1"]);
      assert.deepEqual(input.acceptance, ["T1 passes", "T2 passes"]);
    });

    it("缺 spec 字段抛出错误", () => {
      const json = JSON.stringify({ tasks: [] });
      assert.throws(
        () => parseSpecKitJson(json),
        (err: unknown) => {
          assert.ok(err instanceof PatchWardenError);
          assert.equal(err.reason, "invalid_spec_kit_input");
          return true;
        }
      );
    });

    it("spec 为空字符串抛出错误", () => {
      const json = JSON.stringify({ spec: "", tasks: [] });
      assert.throws(
        () => parseSpecKitJson(json),
        (err: unknown) => {
          assert.ok(err instanceof PatchWardenError);
          assert.equal(err.reason, "invalid_spec_kit_input");
          return true;
        }
      );
    });

    it("缺 tasks 字段抛出错误", () => {
      const json = JSON.stringify({ spec: "my-spec" });
      assert.throws(
        () => parseSpecKitJson(json),
        (err: unknown) => {
          assert.ok(err instanceof PatchWardenError);
          assert.equal(err.reason, "invalid_spec_kit_input");
          return true;
        }
      );
    });

    it("tasks 不是数组抛出错误", () => {
      const json = JSON.stringify({ spec: "my-spec", tasks: "not-an-array" });
      assert.throws(
        () => parseSpecKitJson(json),
        (err: unknown) => {
          assert.ok(err instanceof PatchWardenError);
          assert.equal(err.reason, "invalid_spec_kit_input");
          return true;
        }
      );
    });

    it("task 缺 id 抛出错误", () => {
      const json = JSON.stringify({
        spec: "my-spec",
        tasks: [{ desc: "no id" }],
      });
      assert.throws(
        () => parseSpecKitJson(json),
        (err: unknown) => {
          assert.ok(err instanceof PatchWardenError);
          assert.equal(err.reason, "invalid_spec_kit_input");
          return true;
        }
      );
    });

    it("无效 JSON 文本抛出错误", () => {
      assert.throws(
        () => parseSpecKitJson("{ not valid json"),
        (err: unknown) => {
          assert.ok(err instanceof PatchWardenError);
          assert.equal(err.reason, "invalid_spec_kit_json");
          return true;
        }
      );
    });
  });

  describe("importSpecKitTasks — 标准导入", () => {
    it("3 个无依赖 task → created_count=3, existing_count=0", () => {
      const input = makeStandardInput();
      const result = importSpecKitTasks(goalId, input, { workspaceRoot: tempDir });

      assert.equal(result.created_count, 3);
      assert.equal(result.existing_count, 0);
      assert.equal(result.subgoal_ids.length, 3);
      assert.equal(result.spec_name, "feature-auth");
      assert.equal(result.goal_id, goalId);
    });

    it("每个 subgoal 的 title = task.desc", () => {
      const input = makeStandardInput();
      const result = importSpecKitTasks(goalId, input, { workspaceRoot: tempDir });

      const status = readGoalStatus(goalId, tempDir);
      assert.equal(status.subgoals.length, 3);
      assert.equal(status.subgoals[0].title, "Set up database schema");
      assert.equal(status.subgoals[1].title, "Implement auth service");
      assert.equal(status.subgoals[2].title, "Write integration tests");
    });

    it("每个 subgoal 的 external_ref = task.id", () => {
      const input = makeStandardInput();
      importSpecKitTasks(goalId, input, { workspaceRoot: tempDir });

      const status = readGoalStatus(goalId, tempDir);
      assert.equal(status.subgoals[0].external_ref, "T1");
      assert.equal(status.subgoals[1].external_ref, "T2");
      assert.equal(status.subgoals[2].external_ref, "T3");
    });

    it("task.files 映射到 scope_hints", () => {
      const input = makeStandardInput();
      importSpecKitTasks(goalId, input, { workspaceRoot: tempDir });

      const status = readGoalStatus(goalId, tempDir);
      assert.deepEqual(status.subgoals[0].scope_hints, ["src/db/schema.ts"]);
      assert.deepEqual(status.subgoals[1].scope_hints, [
        "src/auth/service.ts",
        "src/auth/types.ts",
      ]);
      assert.deepEqual(status.subgoals[2].scope_hints, ["test/auth.test.ts"]);
    });

    it("subgoal_ids 对应新创建的 subgoal id", () => {
      const input = makeStandardInput();
      const result = importSpecKitTasks(goalId, input, { workspaceRoot: tempDir });

      assert.deepEqual(result.subgoal_ids, ["subgoal-001", "subgoal-002", "subgoal-003"]);
    });
  });

  describe("importSpecKitTasks — 依赖关系导入", () => {
    it("T2 depends_on T1 → T2 的 depends_on 含 T1 的 subgoal_id（非 external_ref）", () => {
      const input: SpecKitInput = {
        spec: "feature-deps",
        tasks: [
          { id: "T1", desc: "Foundation task" },
          { id: "T2", desc: "Dependent task", depends_on: ["T1"] },
        ],
      };
      const result = importSpecKitTasks(goalId, input, { workspaceRoot: tempDir });

      assert.equal(result.created_count, 2);

      const status = readGoalStatus(goalId, tempDir);
      assert.equal(status.subgoals.length, 2);

      const t1Subgoal = status.subgoals[0];
      const t2Subgoal = status.subgoals[1];
      assert.equal(t1Subgoal.external_ref, "T1");
      assert.equal(t2Subgoal.external_ref, "T2");

      // T2 depends_on 应包含 T1 的 subgoal_id，而非 external_ref
      assert.ok(t2Subgoal.depends_on.includes(t1Subgoal.id));
      assert.ok(!t2Subgoal.depends_on.includes("T1"));
    });

    it("多级依赖 T3 → T2 → T1 全部正确解析", () => {
      const input: SpecKitInput = {
        spec: "multi-level",
        tasks: [
          { id: "T1", desc: "Level 1" },
          { id: "T2", desc: "Level 2", depends_on: ["T1"] },
          { id: "T3", desc: "Level 3", depends_on: ["T2"] },
        ],
      };
      importSpecKitTasks(goalId, input, { workspaceRoot: tempDir });

      const status = readGoalStatus(goalId, tempDir);
      assert.equal(status.subgoals.length, 3);
      assert.deepEqual(status.subgoals[0].depends_on, []);
      assert.deepEqual(status.subgoals[1].depends_on, ["subgoal-001"]);
      assert.deepEqual(status.subgoals[2].depends_on, ["subgoal-002"]);
    });

    it("依赖不存在的 task → 忽略该依赖并继续创建", () => {
      const input: SpecKitInput = {
        spec: "missing-dep",
        tasks: [
          { id: "T1", desc: "Task with missing dep", depends_on: ["NONEXISTENT"] },
        ],
      };
      const result = importSpecKitTasks(goalId, input, { workspaceRoot: tempDir });

      assert.equal(result.created_count, 1);
      const status = readGoalStatus(goalId, tempDir);
      assert.equal(status.subgoals.length, 1);
      assert.deepEqual(status.subgoals[0].depends_on, []);
    });
  });

  describe("importSpecKitTasks — 验收标准映射", () => {
    it("input.acceptance 写入 GoalStatus.acceptance_criteria", () => {
      const input: SpecKitInput = {
        spec: "feature-acceptance",
        tasks: [{ id: "T1", desc: "Task one" }],
        acceptance: ["T1 passes", "T2 passes"],
      };
      importSpecKitTasks(goalId, input, { workspaceRoot: tempDir });

      const status = readGoalStatus(goalId, tempDir);
      assert.deepEqual(status.acceptance_criteria, ["T1 passes", "T2 passes"]);
    });

    it("无 acceptance → GoalStatus.acceptance_criteria 不存在", () => {
      const input: SpecKitInput = {
        spec: "no-acceptance",
        tasks: [{ id: "T1", desc: "Task one" }],
      };
      importSpecKitTasks(goalId, input, { workspaceRoot: tempDir });

      const status = readGoalStatus(goalId, tempDir);
      assert.equal(status.acceptance_criteria, undefined);
    });

    it("空 acceptance 数组 → GoalStatus.acceptance_criteria 不存在", () => {
      const input: SpecKitInput = {
        spec: "empty-acceptance",
        tasks: [{ id: "T1", desc: "Task one" }],
        acceptance: [],
      };
      importSpecKitTasks(goalId, input, { workspaceRoot: tempDir });

      const status = readGoalStatus(goalId, tempDir);
      assert.equal(status.acceptance_criteria, undefined);
    });
  });

  describe("importSpecKitTasks — 幂等去重", () => {
    it("重复导入相同 JSON → 第二次 created_count=0, existing_count=3", () => {
      const input = makeStandardInput();

      // 第一次导入
      const result1 = importSpecKitTasks(goalId, input, { workspaceRoot: tempDir });
      assert.equal(result1.created_count, 3);
      assert.equal(result1.existing_count, 0);

      // 第二次导入相同 JSON
      const result2 = importSpecKitTasks(goalId, input, { workspaceRoot: tempDir });
      assert.equal(result2.created_count, 0);
      assert.equal(result2.existing_count, 3);
      assert.deepEqual(result2.subgoal_ids, []);
    });

    it("重复导入后 subgoal 总数仍为 3", () => {
      const input = makeStandardInput();
      importSpecKitTasks(goalId, input, { workspaceRoot: tempDir });
      importSpecKitTasks(goalId, input, { workspaceRoot: tempDir });

      const status = readGoalStatus(goalId, tempDir);
      assert.equal(status.subgoals.length, 3);
    });

    it("部分新 task 导入：只创建新增的", () => {
      // 第一次导入 T1, T2
      const input1: SpecKitInput = {
        spec: "partial",
        tasks: [
          { id: "T1", desc: "Task one" },
          { id: "T2", desc: "Task two" },
        ],
      };
      const result1 = importSpecKitTasks(goalId, input1, { workspaceRoot: tempDir });
      assert.equal(result1.created_count, 2);

      // 第二次导入 T1, T2, T3（T1/T2 已存在）
      const input2: SpecKitInput = {
        spec: "partial",
        tasks: [
          { id: "T1", desc: "Task one" },
          { id: "T2", desc: "Task two" },
          { id: "T3", desc: "Task three" },
        ],
      };
      const result2 = importSpecKitTasks(goalId, input2, { workspaceRoot: tempDir });
      assert.equal(result2.created_count, 1);
      assert.equal(result2.existing_count, 2);

      const status = readGoalStatus(goalId, tempDir);
      assert.equal(status.subgoals.length, 3);
    });
  });

  describe("importSpecKitTasks — 无效输入", () => {
    it("spec 为空 → 抛出错误且不创建 subgoal", () => {
      const input = { spec: "", tasks: [] } as unknown as SpecKitInput;
      assert.throws(
        () => importSpecKitTasks(goalId, input, { workspaceRoot: tempDir }),
        (err: unknown) => {
          assert.ok(err instanceof PatchWardenError);
          assert.equal(err.reason, "invalid_spec_kit_input");
          return true;
        }
      );

      const status = readGoalStatus(goalId, tempDir);
      assert.equal(status.subgoals.length, 0);
    });

    it("tasks 不是数组 → 抛出错误且不创建 subgoal", () => {
      const input = { spec: "test", tasks: "not-array" } as unknown as SpecKitInput;
      assert.throws(
        () => importSpecKitTasks(goalId, input, { workspaceRoot: tempDir }),
        (err: unknown) => {
          assert.ok(err instanceof PatchWardenError);
          assert.equal(err.reason, "invalid_spec_kit_input");
          return true;
        }
      );

      const status = readGoalStatus(goalId, tempDir);
      assert.equal(status.subgoals.length, 0);
    });

    it("tasks 缺失 → 抛出错误且不创建 subgoal", () => {
      const input = { spec: "test" } as unknown as SpecKitInput;
      assert.throws(
        () => importSpecKitTasks(goalId, input, { workspaceRoot: tempDir }),
        (err: unknown) => {
          assert.ok(err instanceof PatchWardenError);
          assert.equal(err.reason, "invalid_spec_kit_input");
          return true;
        }
      );

      const status = readGoalStatus(goalId, tempDir);
      assert.equal(status.subgoals.length, 0);
    });
  });

  describe("importSpecKitTasks — JSON 文本端到端", () => {
    it("parseSpecKitJson + importSpecKitTasks 完整流程", () => {
      const json = JSON.stringify({
        spec: "e2e-spec",
        tasks: [
          { id: "T1", desc: "First task", files: ["a.ts"] },
          { id: "T2", desc: "Second task", depends_on: ["T1"] },
        ],
        acceptance: ["All tests pass"],
      });

      const input = parseSpecKitJson(json);
      const result = importSpecKitTasks(goalId, input, { workspaceRoot: tempDir });

      assert.equal(result.created_count, 2);
      assert.equal(result.spec_name, "e2e-spec");

      const status = readGoalStatus(goalId, tempDir);
      assert.equal(status.subgoals.length, 2);
      assert.equal(status.subgoals[0].external_ref, "T1");
      assert.equal(status.subgoals[1].external_ref, "T2");
      assert.deepEqual(status.subgoals[1].depends_on, ["subgoal-001"]);
      assert.deepEqual(status.acceptance_criteria, ["All tests pass"]);
    });
  });
});
