/**
 * v0.8.0: Goal Session 子目标状态机 — 不可变更新 + 状态机校验。
 *
 * 类型定义：SubgoalStatus / Subgoal / GoalStatus
 * 状态机合法转换：
 *   ready → running
 *   running → done_by_agent
 *   done_by_agent → accepted | rejected | needs_fix
 *   needs_fix → running
 *
 * 所有更新函数返回新的 GoalStatus 对象，不修改原对象。
 */

import { PatchWardenError } from "../errors.js";
import { redactSensitiveContent } from "../security/contentRedaction.js";

// ── 类型定义 ──────────────────────────────────────────────────────

export type SubgoalStatus =
  | "ready"
  | "running"
  | "done_by_agent"
  | "accepted"
  | "rejected"
  | "needs_fix";

export interface Subgoal {
  id: string;
  title: string;
  status: SubgoalStatus;
  depends_on: string[];
  task_ids: string[];
  accepted_at?: string;
  rejected_reason?: string;
  /** Spec Kit task id 回溯（用于幂等去重） */
  external_ref?: string;
  /** Spec Kit task.files 提示（作用域文件路径列表） */
  scope_hints?: string[];
  /** Managed git worktree associated with an isolated subgoal task. */
  worktree_id?: string;
}

export interface GoalStatus {
  goal_id: string;
  title: string;
  status: "active" | "completed" | "abandoned";
  repo_path: string;
  created_at: string;
  updated_at: string;
  subgoals: Subgoal[];
  /** Spec Kit 验收标准列表 */
  acceptance_criteria?: string[];
}

// ── 合法状态转换表 ────────────────────────────────────────────────

const LEGAL_TRANSITIONS: Record<SubgoalStatus, SubgoalStatus[]> = {
  ready: ["running"],
  running: ["done_by_agent"],
  done_by_agent: ["accepted", "rejected", "needs_fix"],
  accepted: [],
  rejected: [],
  needs_fix: ["running"],
};

// ── 函数实现 ──────────────────────────────────────────────────────

/**
 * 创建初始 GoalStatus，用于新 goal。
 * status 为 "active"，subgoals 为空数组，时间戳为当前 ISO 时间。
 */
export function createInitialGoalStatus(
  goalId: string,
  title: string,
  repoPath: string
): GoalStatus {
  const now = new Date().toISOString();
  return {
    goal_id: goalId,
    title: redactGoalText(title, 500),
    status: "active",
    repo_path: repoPath,
    created_at: now,
    updated_at: now,
    subgoals: [],
  };
}

/**
 * 向 goalStatus 添加一个新 subgoal。
 * subgoal_id 格式：`subgoal-{NNN}`，NNN 三位补零，从 001 开始递增。
 * 校验 dependsOn 中每个 id 是否存在于现有 subgoals。
 * 不可变更新：返回新的 GoalStatus 对象。
 */
export function addSubgoal(
  goalStatus: GoalStatus,
  title: string,
  dependsOn: string[] = []
): { goalStatus: GoalStatus; subgoalId: string } {
  if (goalStatus.status !== "active") {
    throw new PatchWardenError(
      "goal_not_active",
      `Goal "${goalStatus.goal_id}" is ${goalStatus.status} and cannot accept new subgoals.`,
      "Create a new Goal Session for additional work.",
      true,
      { goal_id: goalStatus.goal_id, status: goalStatus.status },
    );
  }
  const existingIds = new Set(goalStatus.subgoals.map((s) => s.id));
  for (const depId of dependsOn) {
    if (!existingIds.has(depId)) {
      throw new PatchWardenError(
        "invalid_dependency",
        `Subgoal dependency "${depId}" does not exist`,
        "Ensure depends_on references only existing subgoal ids.",
        true,
        { subgoal_id: depId, existing_ids: [...existingIds] }
      );
    }
  }

  const nextNumber = goalStatus.subgoals.length + 1;
  const subgoalId = `subgoal-${String(nextNumber).padStart(3, "0")}`;
  const newSubgoal: Subgoal = {
    id: subgoalId,
    title: redactGoalText(title, 500),
    status: "ready",
    depends_on: [...dependsOn],
    task_ids: [],
  };

  const now = new Date().toISOString();
  const updated: GoalStatus = {
    ...goalStatus,
    subgoals: [...goalStatus.subgoals, newSubgoal],
    updated_at: now,
  };

  return { goalStatus: updated, subgoalId };
}

/**
 * 更新指定 subgoal 的状态，校验状态机合法转换。
 * - accepted：设置 accepted_at
 * - rejected：需要 options.rejected_reason
 * 不可变更新：返回新的 GoalStatus 对象。
 */
export function updateSubgoalStatus(
  goalStatus: GoalStatus,
  subgoalId: string,
  newStatus: SubgoalStatus,
  options?: { rejected_reason?: string }
): GoalStatus {
  const index = goalStatus.subgoals.findIndex((s) => s.id === subgoalId);
  if (index === -1) {
    throw new PatchWardenError(
      "subgoal_not_found",
      `Subgoal "${subgoalId}" not found in goal "${goalStatus.goal_id}"`,
      "Ensure the subgoal id exists before updating its status.",
      true,
      { subgoal_id: subgoalId, goal_id: goalStatus.goal_id }
    );
  }

  const current = goalStatus.subgoals[index];
  const legal = LEGAL_TRANSITIONS[current.status];
  if (!legal.includes(newStatus)) {
    throw new PatchWardenError(
      "invalid_status_transition",
      `Invalid status transition for subgoal "${subgoalId}": "${current.status}" -> "${newStatus}"`,
      `Valid transitions from "${current.status}": ${legal.length > 0 ? legal.join(", ") : "(none, terminal state)"}.`,
      true,
      {
        subgoal_id: subgoalId,
        from_status: current.status,
        to_status: newStatus,
        legal_transitions: legal,
      }
    );
  }

  const updatedSubgoal: Subgoal = {
    ...current,
    status: newStatus,
  };

  if (newStatus === "accepted") {
    updatedSubgoal.accepted_at = new Date().toISOString();
  }
  if (newStatus === "rejected") {
    if (!options || !options.rejected_reason) {
      throw new PatchWardenError(
        "invalid_status_transition",
        `Rejecting subgoal "${subgoalId}" requires rejected_reason`,
        "Provide options.rejected_reason when transitioning to \"rejected\".",
        true,
        { subgoal_id: subgoalId, from_status: current.status, to_status: newStatus }
      );
    }
    updatedSubgoal.rejected_reason = redactGoalText(options.rejected_reason, 2000);
  }

  const newSubgoals = [...goalStatus.subgoals];
  newSubgoals[index] = updatedSubgoal;

  return {
    ...goalStatus,
    subgoals: newSubgoals,
    updated_at: new Date().toISOString(),
  };
}

function redactGoalText(value: string, maxChars: number): string {
  return redactSensitiveContent(String(value || "")).content.slice(0, maxChars);
}

/**
 * 将 taskId 关联到指定 subgoal（去重）。
 * 不可变更新：返回新的 GoalStatus 对象。
 */
export function linkTaskToSubgoal(
  goalStatus: GoalStatus,
  subgoalId: string,
  taskId: string
): GoalStatus {
  const index = goalStatus.subgoals.findIndex((s) => s.id === subgoalId);
  if (index === -1) {
    throw new PatchWardenError(
      "subgoal_not_found",
      `Subgoal "${subgoalId}" not found in goal "${goalStatus.goal_id}"`,
      "Ensure the subgoal id exists before linking a task.",
      true,
      { subgoal_id: subgoalId, goal_id: goalStatus.goal_id }
    );
  }

  const current = goalStatus.subgoals[index];
  if (current.task_ids.includes(taskId)) {
    // 已存在，不重复添加，但仍返回等价的新对象以保持不可变契约
    return { ...goalStatus, updated_at: new Date().toISOString() };
  }

  const updatedSubgoal: Subgoal = {
    ...current,
    task_ids: [...current.task_ids, taskId],
  };

  const newSubgoals = [...goalStatus.subgoals];
  newSubgoals[index] = updatedSubgoal;

  return {
    ...goalStatus,
    subgoals: newSubgoals,
    updated_at: new Date().toISOString(),
  };
}
