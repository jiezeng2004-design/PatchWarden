/**
 * v0.8.0: Spec Kit tasks 导入 — 将 Spec Kit 的 spec/tasks 结构转换为 Goal Session 子目标。
 *
 * - 解析 Spec Kit JSON（parseSpecKitJson）
 * - 幂等导入：按 external_ref 去重，重复导入不产生重复 subgoal
 * - 依赖解析：将 task.depends_on（external_ref 引用）解析为本地 subgoal id
 * - 验收标准映射：input.acceptance → GoalStatus.acceptance_criteria
 *
 * 不引入第三方依赖，仅用 Node.js 内置模块。
 */

import { PatchWardenError } from "../errors.js";
import { addSubgoal, type GoalStatus } from "./goalStatus.js";
import { readGoalStatus, writeGoalStatus } from "./goalStore.js";

// ── 类型定义 ──────────────────────────────────────────────────────

export interface SpecKitTask {
  id: string;
  desc: string;
  files?: string[];
  /** 引用其他 task 的 id（external_ref） */
  depends_on?: string[];
}

export interface SpecKitInput {
  spec: string;
  tasks: SpecKitTask[];
  acceptance?: string[];
}

export interface SpecKitImportResult {
  goal_id: string;
  spec_name: string;
  created_count: number;
  existing_count: number;
  subgoal_ids: string[];
}

// ── JSON 解析 ─────────────────────────────────────────────────────

/**
 * 解析 Spec Kit JSON 文本并验证结构。
 *
 * 必须包含：
 * - spec: 非空字符串
 * - tasks: 数组，每个元素含 id（字符串）和 desc（字符串）
 *
 * 可选：
 * - acceptance: 字符串数组
 *
 * 解析失败或结构不合法时抛出 PatchWardenError("invalid_spec_kit_json" | "invalid_spec_kit_input")。
 */
export function parseSpecKitJson(jsonText: string): SpecKitInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    throw new PatchWardenError(
      "invalid_spec_kit_json",
      `Failed to parse Spec Kit JSON: ${e instanceof Error ? e.message : String(e)}`,
      "Ensure the input is valid JSON.",
      true,
      {}
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new PatchWardenError(
      "invalid_spec_kit_input",
      "Spec Kit JSON must be a JSON object",
      'Ensure the top-level value is an object with "spec" and "tasks" fields.',
      true,
      { actual_type: Array.isArray(parsed) ? "array" : typeof parsed }
    );
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj.spec !== "string" || obj.spec === "") {
    throw new PatchWardenError(
      "invalid_spec_kit_input",
      'Spec Kit JSON must contain a non-empty "spec" string field',
      'Add a "spec" field with a non-empty string value describing the specification name.',
      true,
      { spec: obj.spec }
    );
  }

  if (!Array.isArray(obj.tasks)) {
    throw new PatchWardenError(
      "invalid_spec_kit_input",
      'Spec Kit JSON must contain a "tasks" array field',
      'Add a "tasks" field with an array of task objects (each with "id" and "desc").',
      true,
      { tasks_type: Array.isArray(obj.tasks) ? "array" : typeof obj.tasks }
    );
  }

  const tasks: SpecKitTask[] = [];
  for (let i = 0; i < obj.tasks.length; i++) {
    const raw = obj.tasks[i];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new PatchWardenError(
        "invalid_spec_kit_input",
        `Spec Kit task at index ${i} must be an object`,
        "Each task must be an object with at least \"id\" and \"desc\" string fields.",
        true,
        { task_index: i, actual_type: typeof raw }
      );
    }
    const t = raw as Record<string, unknown>;
    if (typeof t.id !== "string" || t.id === "") {
      throw new PatchWardenError(
        "invalid_spec_kit_input",
        `Spec Kit task at index ${i} must have a non-empty "id" string`,
        "Ensure each task has a unique non-empty string \"id\".",
        true,
        { task_index: i, id: t.id }
      );
    }
    if (typeof t.desc !== "string") {
      throw new PatchWardenError(
        "invalid_spec_kit_input",
        `Spec Kit task at index ${i} (id="${t.id}") must have a "desc" string`,
        "Ensure each task has a \"desc\" string describing the task.",
        true,
        { task_index: i, id: t.id, desc_type: typeof t.desc }
      );
    }

    const task: SpecKitTask = { id: t.id, desc: t.desc };
    if (Array.isArray(t.files)) {
      task.files = t.files.filter((f): f is string => typeof f === "string");
    }
    if (Array.isArray(t.depends_on)) {
      task.depends_on = t.depends_on.filter(
        (d): d is string => typeof d === "string"
      );
    }
    tasks.push(task);
  }

  const result: SpecKitInput = { spec: obj.spec, tasks };
  if (Array.isArray(obj.acceptance)) {
    result.acceptance = obj.acceptance.filter(
      (a): a is string => typeof a === "string"
    );
  }

  return result;
}

// ── 导入实现 ──────────────────────────────────────────────────────

/**
 * 将 Spec Kit tasks 导入到指定 Goal Session，创建对应的 subgoal。
 *
 * 行为：
 * - 验证 input（spec 非空、tasks 为数组）
 * - 幂等去重：按 external_ref（task.id）匹配现有 subgoal，已存在则跳过
 * - 依赖解析：将 task.depends_on（external_ref）解析为本地 subgoal id
 *   - 先创建无依赖的 subgoal，再处理有依赖的，支持多级依赖
 *   - 依赖的 task 在同一批次中：用刚创建的 subgoal_id
 *   - 依赖的 task 不存在：忽略该依赖并记录 warning（console.warn）
 * - 验收标准：input.acceptance 非空时写入 GoalStatus.acceptance_criteria
 * - 持久化：用 writeGoalStatus 原子写入
 *
 * @param goalId       目标 Goal 标识
 * @param input        Spec Kit 输入（spec + tasks + acceptance）
 * @param options      可选配置：workspaceRoot 用于测试
 * @returns SpecKitImportResult
 */
export function importSpecKitTasks(
  goalId: string,
  input: SpecKitInput,
  options?: { workspaceRoot?: string }
): SpecKitImportResult {
  // ── 验证 ───────────────────────────────────────────────────
  if (!input || typeof input !== "object") {
    throw new PatchWardenError(
      "invalid_spec_kit_input",
      "Spec Kit input must be an object",
      "Pass a SpecKitInput object with spec, tasks, and optional acceptance fields.",
      true,
      {}
    );
  }
  if (typeof input.spec !== "string" || input.spec === "") {
    throw new PatchWardenError(
      "invalid_spec_kit_input",
      'Spec Kit input must contain a non-empty "spec" string',
      "Ensure input.spec is a non-empty string.",
      true,
      { spec: input.spec }
    );
  }
  if (!Array.isArray(input.tasks)) {
    throw new PatchWardenError(
      "invalid_spec_kit_input",
      'Spec Kit input must contain a "tasks" array',
      "Ensure input.tasks is an array of SpecKitTask objects.",
      true,
      { tasks_type: Array.isArray(input.tasks) ? "array" : typeof input.tasks }
    );
  }

  const workspaceRoot = options?.workspaceRoot;

  // ── 读取现有 GoalStatus ────────────────────────────────────
  let goalStatus: GoalStatus = readGoalStatus(goalId, workspaceRoot);

  // ── 构建 external_ref → subgoal_id 映射（现有 subgoal）─────
  const refToSubgoalId = new Map<string, string>();
  for (const sg of goalStatus.subgoals) {
    if (sg.external_ref) {
      refToSubgoalId.set(sg.external_ref, sg.id);
    }
  }

  // ── 幂等去重：区分新 task 和已存在的 task ─────────────────
  const newTasks: SpecKitTask[] = [];
  let existingCount = 0;
  for (const task of input.tasks) {
    if (refToSubgoalId.has(task.id)) {
      existingCount++;
    } else {
      newTasks.push(task);
    }
  }

  // 新批次中所有 task id 集合（用于判断依赖是否在同批次）
  const newTaskIds = new Set(newTasks.map((t) => t.id));

  // ── 按依赖顺序创建 subgoal（拓扑排序，迭代多轮）────────────
  const createdIds: string[] = [];
  let remaining = [...newTasks];

  // 辅助：创建单个 subgoal 并设置 external_ref / scope_hints
  const createSubgoalForTask = (
    gs: GoalStatus,
    task: SpecKitTask,
    resolvedDeps: string[]
  ): { goalStatus: GoalStatus; subgoalId: string } => {
    const { goalStatus: newGs, subgoalId } = addSubgoal(gs, task.desc, resolvedDeps);

    // 新 subgoal 是数组最后一个元素，追加 external_ref 和 scope_hints
    const subgoals = [...newGs.subgoals];
    const lastIdx = subgoals.length - 1;
    const updated: typeof subgoals[number] = {
      ...subgoals[lastIdx],
      external_ref: task.id,
    };
    if (task.files && task.files.length > 0) {
      updated.scope_hints = [...task.files];
    }
    subgoals[lastIdx] = updated;

    return { goalStatus: { ...newGs, subgoals }, subgoalId };
  };

  while (remaining.length > 0) {
    const stillRemaining: SpecKitTask[] = [];
    let progress = false;

    // 正向遍历：保持输入顺序，先创建的 task 可被同批次后续 task 依赖
    for (const task of remaining) {
      const deps = task.depends_on ?? [];

      const resolvedDeps: string[] = [];
      let hasUnresolvedInBatch = false;

      for (const dep of deps) {
        if (refToSubgoalId.has(dep)) {
          // 依赖已存在（已有 subgoal 或本批次已创建）
          resolvedDeps.push(refToSubgoalId.get(dep)!);
        } else if (newTaskIds.has(dep)) {
          // 依赖同批次中尚未创建的 task
          hasUnresolvedInBatch = true;
        } else {
          // 依赖的 task 不存在任何地方：忽略并记录 warning
          console.warn(
            `[specKitImport] Task "${task.id}" depends on non-existent task "${dep}"; ignoring this dependency.`
          );
        }
      }

      if (!hasUnresolvedInBatch) {
        const { goalStatus: newGs, subgoalId } = createSubgoalForTask(
          goalStatus,
          task,
          resolvedDeps
        );
        goalStatus = newGs;
        refToSubgoalId.set(task.id, subgoalId);
        createdIds.push(subgoalId);
        progress = true;
      } else {
        stillRemaining.push(task);
      }
    }

    remaining = stillRemaining;

    if (!progress && remaining.length > 0) {
      // 检测到循环依赖：强制创建剩余 task，忽略未解析的同批次依赖
      for (const task of remaining) {
        const deps = task.depends_on ?? [];
        const resolvedDeps: string[] = [];
        for (const dep of deps) {
          if (refToSubgoalId.has(dep)) {
            resolvedDeps.push(refToSubgoalId.get(dep)!);
          } else if (newTaskIds.has(dep)) {
            console.warn(
              `[specKitImport] Circular dependency detected: task "${task.id}" depends on "${dep}" which could not be resolved; ignoring this dependency.`
            );
          } else {
            console.warn(
              `[specKitImport] Task "${task.id}" depends on non-existent task "${dep}"; ignoring this dependency.`
            );
          }
        }
        const { goalStatus: newGs, subgoalId } = createSubgoalForTask(
          goalStatus,
          task,
          resolvedDeps
        );
        goalStatus = newGs;
        refToSubgoalId.set(task.id, subgoalId);
        createdIds.push(subgoalId);
      }
      break;
    }
  }

  // ── 验收标准 ───────────────────────────────────────────────
  if (input.acceptance && input.acceptance.length > 0) {
    goalStatus = {
      ...goalStatus,
      acceptance_criteria: [...input.acceptance],
    };
  }

  // ── 持久化（原子写）────────────────────────────────────────
  writeGoalStatus(goalId, goalStatus, workspaceRoot);

  // ── 返回结果 ───────────────────────────────────────────────
  return {
    goal_id: goalId,
    spec_name: input.spec,
    created_count: createdIds.length,
    existing_count: existingCount,
    subgoal_ids: createdIds,
  };
}
