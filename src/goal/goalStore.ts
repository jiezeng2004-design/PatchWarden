/**
 * v0.8.0: Goal Session 目录 CRUD — 在 workspaceRoot 下管理 .patchwarden/goals/ 目录。
 *
 * 目录结构：
 *   {workspaceRoot}/.patchwarden/goals/{goal_id}/
 *     ├── GOAL.md              人类可读的 goal 描述
 *     ├── GOALS.md             子目标列表（人类可读）
 *     ├── goal_status.json     机器可读的状态文件（原子写）
 *     ├── tasks/               任务产物
 *     └── artifacts/           其他产物
 *
 * 所有文件系统函数都接受可选的 workspaceRoot 参数用于测试；
 * 默认从 getConfig().workspaceRoot 读取。
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { getConfig } from "../config.js";
import { guardPath, guardWorkspacePath } from "../security/pathGuard.js";
import { PatchWardenError } from "../errors.js";
import { atomicWriteFileSync, atomicWriteJsonFileSync } from "../utils/atomicFile.js";
import { redactSensitiveContent } from "../security/contentRedaction.js";
import {
  mutateLockedJsonFileSync,
  readJsonObjectFileSync,
  withFileLock,
  withFileLockSync,
} from "../utils/lockedJsonFile.js";
import {
  type GoalStatus,
  type Subgoal,
  createInitialGoalStatus,
} from "./goalStatus.js";

// ── 辅助：解析 workspaceRoot ──────────────────────────────────────

function resolveWorkspaceRoot(workspaceRoot?: string): string {
  return workspaceRoot ?? getConfig().workspaceRoot;
}

const GOALS_PREFIX = join(".patchwarden", "goals");
const GOAL_ID_MAX_LENGTH = 128;
const GOAL_ID_PATTERN = /^goal_[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Validate the storage key before it can participate in path construction. */
export function assertValidGoalId(goalId: string): void {
  if (
    goalId.length > GOAL_ID_MAX_LENGTH ||
    !GOAL_ID_PATTERN.test(goalId)
  ) {
    throw new PatchWardenError(
      "invalid_goal_id",
      `Invalid goal id. Expected "goal_" followed by at most ${GOAL_ID_MAX_LENGTH - 5} ASCII letters, digits, underscores, or hyphens.`,
      "Use the goal_id returned by create_goal or list_goals.",
      true,
      { goal_id_length: goalId.length }
    );
  }
}

// ── Goal ID 生成 ──────────────────────────────────────────────────

/**
 * 从 title 生成 slug：小写、非字母数字字符替换为 `_`、合并连续 `_`、去除首尾 `_`、截断到 30 字符。
 * 如果 slug 为空（title 全是符号），用 `untitled` 代替。
 */
function titleToSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 30);
  return slug === "" ? "untitled" : slug;
}

/**
 * 生成 `goal_{YYYYMMDD}_{slug}` 格式的 goal id。
 * 冲突时追加 `_2`、`_3`... 直到唯一。
 * 日期用本地时区（new Date()）。
 */
export function generateGoalId(title: string, existingIds: string[]): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const datePart = `${y}${m}${d}`;
  const slug = titleToSlug(title);

  const existing = new Set(existingIds);
  const base = `goal_${datePart}_${slug}`;
  if (!existing.has(base)) {
    return base;
  }

  let counter = 2;
  while (existing.has(`${base}_${counter}`)) {
    counter++;
  }
  return `${base}_${counter}`;
}

// ── 目录路径解析 ──────────────────────────────────────────────────

/**
 * 返回 `.patchwarden/goals/` 目录路径（相对于 workspaceRoot）。
 * 不自动创建目录。
 */
export function getGoalsDir(workspaceRoot?: string): string {
  const wsRoot = resolveWorkspaceRoot(workspaceRoot);
  return guardPath(join(wsRoot, GOALS_PREFIX), wsRoot, GOALS_PREFIX);
}

/**
 * 返回 `{getGoalsDir()}/{goalId}` 路径。
 */
export function getGoalDir(goalId: string, workspaceRoot?: string): string {
  assertValidGoalId(goalId);
  const wsRoot = resolveWorkspaceRoot(workspaceRoot);
  return guardPath(join(getGoalsDir(wsRoot), goalId), wsRoot, GOALS_PREFIX);
}

// ── CRUD ──────────────────────────────────────────────────────────

/**
 * 创建一个新的 Goal Session。
 * - 用 guardWorkspacePath 校验 repoPath 在 workspaceRoot 内
 * - 扫描现有 goal 目录获取 existingIds，调用 generateGoalId
 * - 创建目录结构：goal_dir/、tasks/、artifacts/
 * - 写入 GOAL.md、GOALS.md、goal_status.json
 * 返回 { goal_id, goal_dir }。
 */
export function createGoal(
  repoPath: string,
  title: string,
  description: string,
  workspaceRoot?: string
): { goal_id: string; goal_dir: string } {
  const safeTitle = redactSensitiveContent(title)
    .content
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, 500) || "Untitled goal";
  const safeDescription = redactSensitiveContent(description).content;
  if (Buffer.byteLength(safeDescription, "utf-8") > 1024 * 1024) {
    throw new PatchWardenError(
      "goal_description_too_large",
      "Goal description exceeds the 1 MiB limit.",
      "Split the work into smaller Goal Sessions.",
    );
  }
  const wsRoot = resolveWorkspaceRoot(workspaceRoot);
  const guardedRepo = guardWorkspacePath(repoPath, wsRoot);

  const goalsDir = getGoalsDir(workspaceRoot);
  mkdirSync(goalsDir, { recursive: true });
  return withFileLockSync(join(goalsDir, "goal-creation"), () => {
    const existingIds: string[] = [];
    for (const entry of readdirSync(goalsDir)) {
      const entryPath = join(goalsDir, entry);
      try {
        if (statSync(entryPath).isDirectory()) {
          existingIds.push(entry);
        }
      } catch {
        // Skip entries that cannot be inspected.
      }
    }

    const goalId = generateGoalId(safeTitle, existingIds);
    const goalDir = getGoalDir(goalId, wsRoot);

    mkdirSync(goalDir);
    mkdirSync(join(goalDir, "tasks"));
    mkdirSync(join(goalDir, "artifacts"));

    const now = new Date().toISOString();
    const goalMd = [
      `# ${safeTitle}`,
      "",
      safeDescription,
      "",
      `- Created: ${now}`,
      `- Repo: ${guardedRepo}`,
      "- Status: active",
      "",
    ].join("\n");
    atomicWriteFileSync(join(goalDir, "GOAL.md"), goalMd);

    const goalsMd = `# Subgoals: ${safeTitle}\n\n_No subgoals yet._\n`;
    atomicWriteFileSync(join(goalDir, "GOALS.md"), goalsMd);

    const status = createInitialGoalStatus(goalId, safeTitle, guardedRepo);
    atomicWriteJsonFileSync(join(goalDir, "goal_status.json"), status);

    return { goal_id: goalId, goal_dir: goalDir };
  }, goalBusyOptions("creation"));
}

/**
 * 列出所有 goal 的摘要信息，按 updated_at 降序排列。
 * 无法解析的目录会被跳过。
 */
export function listGoals(
  workspaceRoot?: string
): Array<{
  goal_id: string;
  title: string;
  status: string;
  subgoal_total: number;
  subgoal_accepted: number;
  subgoal_running: number;
  updated_at: string;
}> {
  const goalsDir = getGoalsDir(workspaceRoot);
  if (!existsSync(goalsDir)) {
    return [];
  }

  const results: Array<{
    goal_id: string;
    title: string;
    status: string;
    subgoal_total: number;
    subgoal_accepted: number;
    subgoal_running: number;
    updated_at: string;
  }> = [];

  for (const entry of readdirSync(goalsDir)) {
    try {
      const entryPath = getGoalDir(entry, workspaceRoot);
      if (!statSync(entryPath).isDirectory()) {
        continue;
      }
      const status = readGoalStatus(entry, workspaceRoot);
      results.push({
        goal_id: status.goal_id,
        title: status.title,
        status: status.status,
        subgoal_total: status.subgoals.length,
        subgoal_accepted: status.subgoals.filter((s) => s.status === "accepted").length,
        subgoal_running: status.subgoals.filter((s) => s.status === "running").length,
        updated_at: status.updated_at,
      });
    } catch {
      // 跳过无法解析的目录
    }
  }

  results.sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));
  return results;
}

/**
 * 读取 goal 的完整详情：goal_status.json + GOAL.md 内容。
 * 如果 goal 目录不存在或 goal_status.json 不存在，抛出 PatchWardenError("goal_not_found")。
 */
export function readGoal(
  goalId: string,
  workspaceRoot?: string
): {
  goal_id: string;
  title: string;
  status: string;
  repo_path: string;
  created_at: string;
  updated_at: string;
  goal_description: string;
  subgoals: Subgoal[];
} {
  const goalDir = getGoalDir(goalId, workspaceRoot);
  if (!existsSync(goalDir)) {
    throw new PatchWardenError(
      "goal_not_found",
      `Goal directory not found: "${goalDir}"`,
      "Ensure the goal id exists before reading.",
      true,
      { goal_id: goalId, goal_dir: goalDir }
    );
  }

  const status = readGoalStatus(goalId, workspaceRoot);

  let goalDescription = "";
  const goalMdPath = join(goalDir, "GOAL.md");
  if (existsSync(goalMdPath)) {
    const safeGoalMdPath = guardPath(
      goalMdPath,
      resolveWorkspaceRoot(workspaceRoot),
      GOALS_PREFIX,
    );
    goalDescription = readFileSync(safeGoalMdPath, "utf-8");
  }

  return {
    goal_id: status.goal_id,
    title: status.title,
    status: status.status,
    repo_path: status.repo_path,
    created_at: status.created_at,
    updated_at: status.updated_at,
    goal_description: goalDescription,
    subgoals: status.subgoals,
  };
}

/**
 * Replace goal_status.json under the shared cross-process mutation lock.
 */
export function writeGoalStatus(
  goalId: string,
  status: GoalStatus,
  workspaceRoot?: string
): void {
  const goalDir = getGoalDir(goalId, workspaceRoot);
  if (!existsSync(goalDir)) {
    throw new PatchWardenError(
      "goal_not_found",
      `Goal directory not found: "${goalDir}"`,
      "Ensure the goal has been created before writing its status.",
      true,
      { goal_id: goalId, goal_dir: goalDir },
    );
  }
  const statusPath = getGoalStatusPath(goalId, workspaceRoot);
  if (!existsSync(statusPath)) {
    withFileLockSync(statusPath, () => {
      atomicWriteJsonFileSync(
        statusPath,
        normalizeGoalLifecycle(validateGoalStatus(goalId, status, workspaceRoot)),
      );
    }, goalBusyOptions(goalId));
    return;
  }
  mutateGoalStatus(goalId, () => ({ next: status, result: undefined }), workspaceRoot);
}

/**
 * 读取 goal_status.json 并 JSON.parse。
 * 如果文件不存在，抛出 PatchWardenError("goal_not_found")。
 */
export function readGoalStatus(goalId: string, workspaceRoot?: string): GoalStatus {
  const statusPath = getGoalStatusPath(goalId, workspaceRoot);
  if (!existsSync(statusPath)) {
    throw new PatchWardenError(
      "goal_not_found",
      `goal_status.json not found for goal "${goalId}" at "${statusPath}"`,
      "Ensure the goal has been created via createGoal before reading its status.",
      true,
      { goal_id: goalId, status_path: statusPath }
    );
  }
  let parsed: unknown;
  try {
    parsed = readJsonObjectFileSync(statusPath);
  } catch {
    throw invalidGoalStatus(goalId, "goal_status.json is not valid JSON");
  }
  return validateGoalStatus(goalId, parsed, workspaceRoot);
}

export interface GoalStatusMutation<R> {
  next?: GoalStatus;
  result: R;
}

export function mutateGoalStatus<R>(
  goalId: string,
  mutation: (current: GoalStatus) => GoalStatusMutation<R>,
  workspaceRoot?: string,
): R {
  const statusPath = getGoalStatusPath(goalId, workspaceRoot);
  ensureGoalStatusExists(goalId, statusPath);
  return mutateLockedJsonFileSync<GoalStatus, R>(statusPath, (raw) => {
    const current = validateGoalStatus(goalId, raw, workspaceRoot);
    const outcome = mutation(current);
    if (!outcome.next) return outcome;
    return {
      next: normalizeGoalLifecycle(validateGoalStatus(goalId, outcome.next, workspaceRoot)),
      result: outcome.result,
    };
  }, goalBusyOptions(goalId));
}

export async function mutateGoalStatusAsync<R>(
  goalId: string,
  mutation: (current: GoalStatus) => Promise<GoalStatusMutation<R>>,
  workspaceRoot?: string,
): Promise<R> {
  const statusPath = getGoalStatusPath(goalId, workspaceRoot);
  ensureGoalStatusExists(goalId, statusPath);
  return withFileLock(statusPath, async () => {
    const current = validateGoalStatus(
      goalId,
      readJsonObjectFileSync(statusPath),
      workspaceRoot,
    );
    const outcome = await mutation(current);
    if (outcome.next) {
      atomicWriteJsonFileSync(
        statusPath,
        normalizeGoalLifecycle(validateGoalStatus(goalId, outcome.next, workspaceRoot)),
      );
    }
    return outcome.result;
  }, goalBusyOptions(goalId));
}

function getGoalStatusPath(goalId: string, workspaceRoot?: string): string {
  const wsRoot = resolveWorkspaceRoot(workspaceRoot);
  return guardPath(
    join(getGoalDir(goalId, wsRoot), "goal_status.json"),
    wsRoot,
    GOALS_PREFIX,
  );
}

function ensureGoalStatusExists(goalId: string, statusPath: string): void {
  if (!existsSync(statusPath)) {
    throw new PatchWardenError(
      "goal_not_found",
      `goal_status.json not found for goal "${goalId}" at "${statusPath}"`,
      "Ensure the goal has been created via createGoal before updating it.",
      true,
      { goal_id: goalId, status_path: statusPath },
    );
  }
}

function validateGoalStatus(
  goalId: string,
  value: unknown,
  workspaceRoot?: string,
): GoalStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidGoalStatus(goalId, "expected a JSON object");
  }
  const candidate = value as Partial<GoalStatus>;
  if (candidate.goal_id !== goalId) {
    throw invalidGoalStatus(goalId, "goal_id does not match its directory");
  }
  if (typeof candidate.title !== "string" || typeof candidate.repo_path !== "string") {
    throw invalidGoalStatus(goalId, "title or repo_path is missing");
  }
  if (candidate.status !== "active" && candidate.status !== "completed" && candidate.status !== "abandoned") {
    throw invalidGoalStatus(goalId, "status is invalid");
  }
  if (!Array.isArray(candidate.subgoals)) {
    throw invalidGoalStatus(goalId, "subgoals must be an array");
  }
  guardWorkspacePath(candidate.repo_path, resolveWorkspaceRoot(workspaceRoot));
  return candidate as GoalStatus;
}

function normalizeGoalLifecycle(status: GoalStatus): GoalStatus {
  if (
    status.status === "active" &&
    status.subgoals.length > 0 &&
    status.subgoals.every((subgoal) => subgoal.status === "accepted")
  ) {
    return { ...status, status: "completed", updated_at: new Date().toISOString() };
  }
  return status;
}

function invalidGoalStatus(goalId: string, detail: string): PatchWardenError {
  return new PatchWardenError(
    "invalid_goal_status",
    `Invalid goal status for "${goalId}": ${detail}.`,
    "Recreate the Goal Session or restore a valid goal_status.json artifact.",
    true,
    { goal_id: goalId },
  );
}

function goalBusyOptions(goalId: string) {
  return {
    waitMs: 0,
    busyError: () => new PatchWardenError(
      "goal_busy",
      `Goal "${goalId}" is currently being updated.`,
      "Retry after the active Goal operation finishes.",
      true,
      { goal_id: goalId },
    ),
  };
}
