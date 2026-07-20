/**
 * v1.0.0 Part B: Worktree 隔离管理器 — 在 workspaceRoot 下管理 git worktree，
 * 为每个 subgoal task 提供独立的代码副本，避免并发任务互相污染工作区。
 *
 * 目录结构：
 *   {workspaceRoot}/_workspacetrees/{worktree_id}/
 *     └── worktree_status.json   机器可读的状态文件（原子写）
 *   {workspaceRoot}/.patchwarden/worktree-archive/{worktree_id}.json
 *     归档的已 discard 状态（worktree 目录被删除后保留审计记录）
 *
 * 安全约束：
 *   - 所有路径经 guardWorkspacePath + guardSensitivePath 校验
 *   - git 命令只用 child_process.execFileSync（不使用 shell），白名单仅
 *     git worktree add/remove/prune + git merge + git branch
 *   - createWorktree 失败时清理半成品 worktree 目录与临时 branch
 *   - 不暴露通用 shell，不 blanket-kill watcher（worktree 与 watcher 无关）
 *
 * 所有文件系统函数都接受可选的 workspaceRoot 参数用于测试；
 * 默认从 getConfig().workspaceRoot 读取。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join, normalize } from "node:path";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { getConfig } from "../config.js";
import { guardPath, guardWorkspacePath } from "../security/pathGuard.js";
import { guardSensitivePath } from "../security/sensitiveGuard.js";
import { PatchWardenError } from "../errors.js";
import { buildGitEnvironment, resolveTrustedExecutable } from "../runner/processSecurity.js";
import { atomicWriteJsonFileSync } from "../utils/atomicFile.js";
import { withFileLockSync } from "../utils/lockedJsonFile.js";

// ── 类型定义 ──────────────────────────────────────────────────────

export interface WorktreeStatus {
  worktree_id: string;
  goal_id: string;
  subgoal_id: string;
  path: string;
  created_at: string;
  status: "active" | "merged" | "discarded";
  branch: string;
  merged_at?: string;
  discarded_at?: string;
}

// ── 常量 ──────────────────────────────────────────────────────────

/** worktree 根目录名，放在 workspaceRoot 下。 */
export const WorktreeDir = "_workspacetrees";

/** 归档目录名（discard 后保留状态），位于 .patchwarden 下，始终为安全路径。 */
const WORKTREE_ARCHIVE_DIR = ".patchwarden/worktree-archive";
const WORKTREE_LOCK_DIR = ".patchwarden/worktree-locks";

const GIT_TIMEOUT_MS = 30000;
const GIT_BRANCH_TIMEOUT_MS = 15000;
const WORKTREE_ID_MAX_LENGTH = 32;
const WORKTREE_ID_PATTERN = /^wt_[a-z0-9]{1,16}_[a-f0-9]{12}$/;

// ── 辅助：解析 workspaceRoot ──────────────────────────────────────

function resolveWorkspaceRoot(workspaceRoot?: string): string {
  return workspaceRoot ?? getConfig().workspaceRoot;
}

/** Accept only IDs emitted by generateWorktreeId(). */
export function assertValidWorktreeId(worktreeId: string): void {
  if (
    worktreeId.length > WORKTREE_ID_MAX_LENGTH ||
    !WORKTREE_ID_PATTERN.test(worktreeId)
  ) {
    throw new PatchWardenError(
      "invalid_worktree_id",
      "Invalid worktree id. Expected the wt_<base36 timestamp>_<12 hex chars> format.",
      "Use the worktree_id returned by create_subgoal_task.",
      true,
      { worktree_id_length: worktreeId.length }
    );
  }
}

// ── 目录路径解析 ──────────────────────────────────────────────────

/**
 * 返回 `<workspaceRoot>/_workspacetrees` 目录路径。不自动创建目录。
 */
export function getWorktreesDir(workspaceRoot?: string): string {
  const wsRoot = resolveWorkspaceRoot(workspaceRoot);
  return guardPath(join(wsRoot, WorktreeDir), wsRoot, WorktreeDir);
}

/**
 * 返回 `<getWorktreesDir()>/<worktreeId>` 路径。
 */
export function getWorktreeDir(worktreeId: string, workspaceRoot?: string): string {
  assertValidWorktreeId(worktreeId);
  const wsRoot = resolveWorkspaceRoot(workspaceRoot);
  return guardPath(
    join(getWorktreesDir(wsRoot), worktreeId),
    wsRoot,
    WorktreeDir
  );
}

// ── ID 与 branch 生成 ─────────────────────────────────────────────

/**
 * 生成 `wt_<timestamp_base36>_<randomHex>` 格式的 worktree id。
 * 内部生成，不接受调用方输入，避免路径注入。
 */
function generateWorktreeId(): string {
  const ts = Date.now().toString(36);
  const rand = randomBytes(6).toString("hex");
  return `wt_${ts}_${rand}`;
}

/**
 * 将字符串清洗为合法 git branch 段：只保留 [a-zA-Z0-9_-]，其余替换为 `_`。
 * 注意 `.` 与 `/` 会被替换：`..` 路径穿越片段无法进入 branch 名；`/` 被排除
 * 是因为 `git worktree add -b <name> <path>` 在 Windows 的 git 上对含 `/` 的
 * 新分支名会报 `fatal: invalid reference`（即便分支名本身合法）。
 */
function sanitizeBranchSegment(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9_-]/g, "_");
  return cleaned === "" ? "x" : cleaned;
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function withWorktreeRepositoryLock<R>(workspaceRoot: string, action: () => R): R {
  const wsRoot = resolveWorkspaceRoot(workspaceRoot);
  const lockDir = guardPath(join(wsRoot, WORKTREE_LOCK_DIR), wsRoot, WORKTREE_LOCK_DIR);
  mkdirSync(lockDir, { recursive: true });
  return withFileLockSync(join(lockDir, "repository-mutation"), action, {
    waitMs: 0,
    busyError: () => new PatchWardenError(
      "worktree_busy",
      "Another managed worktree operation is already changing this repository.",
      "Retry after the active create, merge, or discard operation finishes.",
      true,
    ),
  });
}

function invalidWorktreeStatus(
  worktreeId: string,
  message: string
): never {
  throw new PatchWardenError(
    "invalid_worktree_status",
    `Invalid worktree status for "${worktreeId}": ${message}`,
    "Do not edit worktree_status.json manually; recreate the isolated worktree.",
    true,
    { worktree_id: worktreeId }
  );
}

function validateWorktreeStatus(
  value: unknown,
  worktreeId: string,
  workspaceRoot: string,
  expectedPath: string
): WorktreeStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalidWorktreeStatus(worktreeId, "expected a JSON object");
  }

  const candidate = value as Record<string, unknown>;
  const statusValues = new Set(["active", "merged", "discarded"]);
  if (
    typeof candidate.worktree_id !== "string" ||
    typeof candidate.goal_id !== "string" ||
    typeof candidate.subgoal_id !== "string" ||
    typeof candidate.path !== "string" ||
    typeof candidate.created_at !== "string" ||
    typeof candidate.status !== "string" ||
    !statusValues.has(candidate.status) ||
    typeof candidate.branch !== "string"
  ) {
    return invalidWorktreeStatus(worktreeId, "missing or invalid required fields");
  }

  if (candidate.worktree_id !== worktreeId) {
    return invalidWorktreeStatus(worktreeId, "worktree_id does not match its directory");
  }

  let guardedStatusPath: string;
  try {
    guardedStatusPath = guardPath(candidate.path, workspaceRoot, WorktreeDir);
  } catch {
    return invalidWorktreeStatus(worktreeId, "path is outside the managed worktree root");
  }
  if (!samePath(guardedStatusPath, expectedPath)) {
    return invalidWorktreeStatus(worktreeId, "path does not match its directory");
  }

  const expectedBranch = `pw-${sanitizeBranchSegment(candidate.goal_id)}-${sanitizeBranchSegment(candidate.subgoal_id)}`;
  if (candidate.branch !== expectedBranch) {
    return invalidWorktreeStatus(worktreeId, "branch does not match goal and subgoal metadata");
  }

  if (
    (candidate.merged_at !== undefined && typeof candidate.merged_at !== "string") ||
    (candidate.discarded_at !== undefined && typeof candidate.discarded_at !== "string")
  ) {
    return invalidWorktreeStatus(worktreeId, "invalid lifecycle timestamp");
  }

  return candidate as unknown as WorktreeStatus;
}

// ── 原子写 ────────────────────────────────────────────────────────

function writeStatusAtomic(statusFilePath: string, status: WorktreeStatus): void {
  atomicWriteJsonFileSync(statusFilePath, status);
}

function runGit(args: string[], cwd: string, timeoutMs: number): void {
  const env = buildGitEnvironment(cwd);
  execFileSync(resolveTrustedExecutable("git", cwd, { pathValue: env.PATH }), args, {
    cwd,
    timeout: timeoutMs,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env,
  });
}

function gitErrorMessage(err: unknown): string {
  if (err && typeof err === "object" && "stderr" in err) {
    const stderr = (err as { stderr?: Buffer | string }).stderr;
    if (stderr) {
      const text = Buffer.isBuffer(stderr) ? stderr.toString("utf-8") : String(stderr);
      if (text.trim()) return text.trim();
    }
  }
  return err instanceof Error ? err.message : String(err);
}

// ── 公共 API ──────────────────────────────────────────────────────

/**
 * 为指定 goal/subgoal 创建一个隔离的 git worktree。
 *
 * 流程：
 *   1. 生成 worktreeId（内部随机），拼出 worktreePath 与 branch
 *   2. guardWorkspacePath + guardSensitivePath 校验路径
 *   3. `git worktree add -b <branch> <worktreePath>` 创建 worktree
 *   4. 原子写入 worktree_status.json（status="active"）
 *
 * 失败时清理：若 git worktree add 或写 status 失败，移除已创建的 worktree
 * 目录与临时 branch，抛出 PatchWardenError("worktree_create_failed")。
 *
 * @returns { worktreeId, worktreePath, branch }
 */
export function createWorktree(
  goalId: string,
  subgoalId: string,
  workspaceRoot: string
): { worktreeId: string; worktreePath: string; branch: string } {
  return withWorktreeRepositoryLock(workspaceRoot, () => {
  const wsRoot = resolveWorkspaceRoot(workspaceRoot);

  const worktreeId = generateWorktreeId();
  const worktreePath = getWorktreeDir(worktreeId, workspaceRoot);
  const branch = `pw-${sanitizeBranchSegment(goalId)}-${sanitizeBranchSegment(subgoalId)}`;

  // 安全：校验 worktreePath 在 workspaceRoot 内且非敏感路径
  guardWorkspacePath(worktreePath, wsRoot);
  guardSensitivePath(worktreePath);

  let worktreeCreated = false;
  let branchCreated = false;

  try {
    runGit(["worktree", "add", "-b", branch, worktreePath], wsRoot, GIT_TIMEOUT_MS);
    worktreeCreated = true;
    branchCreated = true;

    // 原子写入 worktree_status.json（worktreePath 是新目录，无旧 status，直接 tmp + rename）
    const statusFilePath = join(worktreePath, "worktree_status.json");
    const now = new Date().toISOString();
    const status: WorktreeStatus = {
      worktree_id: worktreeId,
      goal_id: goalId,
      subgoal_id: subgoalId,
      path: worktreePath,
      created_at: now,
      status: "active",
      branch,
    };
    writeStatusAtomic(statusFilePath, status);

    return { worktreeId, worktreePath, branch };
  } catch (err) {
    // 清理半成品
    if (worktreeCreated) {
      try {
        rmSync(worktreePath, { recursive: true, force: true });
      } catch { /* ignore */ }
      // rmSync 可能无法清除 git 的 worktree 元数据，再尝试 git worktree remove
      try {
        runGit(["worktree", "remove", "--force", worktreePath], wsRoot, GIT_BRANCH_TIMEOUT_MS);
      } catch { /* ignore */ }
    }
    if (branchCreated) {
      try {
        runGit(["branch", "-D", branch], wsRoot, GIT_BRANCH_TIMEOUT_MS);
      } catch { /* ignore — branch 可能未创建或已随 worktree remove 清理 */ }
    }

    if (err instanceof PatchWardenError) throw err;

    throw new PatchWardenError(
      "worktree_create_failed",
      `Failed to create worktree for goal "${goalId}" / subgoal "${subgoalId}": ${gitErrorMessage(err)}`,
      "Ensure workspaceRoot is a git repository with at least one commit, and the worktree path is writable.",
      true,
      {
        goal_id: goalId,
        subgoal_id: subgoalId,
        branch,
        worktree_path: worktreePath,
      }
    );
  }
  });
}

/**
 * 读取 worktree_status.json。不存在返回 null。
 * 路径逃逸或敏感路径会抛 PatchWardenError（不静默吞掉安全违规）。
 */
export function readWorktreeStatus(
  worktreeId: string,
  workspaceRoot?: string
): WorktreeStatus | null {
  const wsRoot = resolveWorkspaceRoot(workspaceRoot);
  const worktreePath = getWorktreeDir(worktreeId, workspaceRoot);

  guardWorkspacePath(worktreePath, wsRoot);
  guardSensitivePath(worktreePath);

  const statusFilePath = join(worktreePath, "worktree_status.json");
  if (!existsSync(statusFilePath)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(statusFilePath, "utf-8"));
  } catch {
    return invalidWorktreeStatus(worktreeId, "file is not valid JSON");
  }
  return validateWorktreeStatus(parsed, worktreeId, wsRoot, worktreePath);
}

/**
 * 将 worktree 的 branch 合并回主工作区（workspaceRoot）。
 *
 * 流程：
 *   1. 读取 worktree_status.json，校验 status === "active"
 *   2. `git merge <branch>`（在 workspaceRoot 执行）
 *   3. 原子更新 worktree_status.json：status="merged"，merged_at=ISO timestamp
 *
 * 合并失败时抛 PatchWardenError("worktree_merge_failed")，不删除 worktree
 * （保留供人工排查冲突）。
 */
export function mergeWorktree(
  worktreeId: string,
  workspaceRoot: string
): { status: "merged" } {
  return withWorktreeRepositoryLock(workspaceRoot, () => {
  const wsRoot = resolveWorkspaceRoot(workspaceRoot);
  const worktreePath = getWorktreeDir(worktreeId, workspaceRoot);

  guardWorkspacePath(worktreePath, wsRoot);
  guardSensitivePath(worktreePath);

  const status = readWorktreeStatus(worktreeId, workspaceRoot);
  if (!status) {
    throw new PatchWardenError(
      "worktree_not_found",
      `Worktree "${worktreeId}" not found or has no worktree_status.json`,
      "Ensure the worktree id was created via createWorktree before merging.",
      true,
      { worktree_id: worktreeId }
    );
  }

  if (status.status !== "active") {
    throw new PatchWardenError(
      "invalid_worktree_state",
      `Worktree "${worktreeId}" is not active (current status: "${status.status}")`,
      "Only active worktrees can be merged.",
      true,
      { worktree_id: worktreeId, current_status: status.status }
    );
  }

  try {
    runGit(["merge", status.branch], wsRoot, GIT_TIMEOUT_MS);
  } catch (err) {
    // 合并失败：不删 worktree，保留供人工排查
    throw new PatchWardenError(
      "worktree_merge_failed",
      `Failed to merge worktree branch "${status.branch}" into workspace: ${gitErrorMessage(err)}`,
      "Resolve merge conflicts manually in the main workspace, then retry or discard the worktree.",
      true,
      { worktree_id: worktreeId, branch: status.branch }
    );
  }

  const updatedStatus: WorktreeStatus = {
    ...status,
    status: "merged",
    merged_at: new Date().toISOString(),
  };
  const statusFilePath = join(worktreePath, "worktree_status.json");
  writeStatusAtomic(statusFilePath, updatedStatus);

  return { status: "merged" };
  });
}

/**
 * 丢弃 worktree：移除 worktree 目录与临时 branch，归档最终状态。
 *
 * 流程：
 *   1. 读取 worktree_status.json（在 remove 之前读取，因为 status 文件位于
 *      worktree 目录内），校验 status === "active"
 *   2. `git worktree remove --force <worktreePath>`
 *   3. `git branch -D <branch>` 删除临时 branch
 *   4. 把更新后的 status（discarded）写到归档目录
 *      `<workspaceRoot>/.patchwarden/worktree-archive/<worktreeId>.json`
 *      （.patchwarden 始终为安全路径，用 guardWorkspacePath 校验）
 *
 * 移除失败抛 PatchWardenError("worktree_discard_failed")。
 */
export function discardWorktree(
  worktreeId: string,
  workspaceRoot: string
): { status: "discarded" } {
  return withWorktreeRepositoryLock(workspaceRoot, () => {
  const wsRoot = resolveWorkspaceRoot(workspaceRoot);
  const worktreePath = getWorktreeDir(worktreeId, workspaceRoot);

  guardWorkspacePath(worktreePath, wsRoot);
  guardSensitivePath(worktreePath);

  // 在 remove 之前读取 status（status 文件位于 worktree 目录内）
  const status = readWorktreeStatus(worktreeId, workspaceRoot);
  if (!status) {
    throw new PatchWardenError(
      "worktree_not_found",
      `Worktree "${worktreeId}" not found or has no worktree_status.json`,
      "Ensure the worktree id was created via createWorktree before discarding.",
      true,
      { worktree_id: worktreeId }
    );
  }

  if (status.status !== "active") {
    throw new PatchWardenError(
      "invalid_worktree_state",
      `Worktree "${worktreeId}" is not active (current status: "${status.status}")`,
      "Only active worktrees can be discarded.",
      true,
      { worktree_id: worktreeId, current_status: status.status }
    );
  }

  try {
    runGit(["worktree", "remove", "--force", worktreePath], wsRoot, GIT_TIMEOUT_MS);
  } catch (err) {
    throw new PatchWardenError(
      "worktree_discard_failed",
      `Failed to remove worktree "${worktreeId}": ${gitErrorMessage(err)}`,
      "Remove the worktree directory manually and run `git worktree prune`.",
      true,
      { worktree_id: worktreeId, worktree_path: worktreePath }
    );
  }

  // 删除临时 branch（best effort — 可能已随 worktree remove 清理）
  try {
    runGit(["branch", "-D", status.branch], wsRoot, GIT_BRANCH_TIMEOUT_MS);
  } catch { /* ignore */ }

  // 归档最终状态到 .patchwarden/worktree-archive/（worktree 目录可能已消失）
  const archivedStatus: WorktreeStatus = {
    ...status,
    status: "discarded",
    discarded_at: new Date().toISOString(),
  };

  const archiveDir = join(wsRoot, WORKTREE_ARCHIVE_DIR);
  guardWorkspacePath(archiveDir, wsRoot);
  // The archive path is workspace-confined and contains only managed status metadata.

  try {
    mkdirSync(archiveDir, { recursive: true });
  } catch { /* ignore */ }

  const archiveFilePath = join(archiveDir, `${worktreeId}.json`);
  writeStatusAtomic(archiveFilePath, archivedStatus);

  return { status: "discarded" };
  });
}
