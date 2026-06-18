import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { getTasksDir, getPlansDir, getConfig } from "../config.js";
import { guardPath, guardWorkspacePath, guardReadPath } from "../security/pathGuard.js";
import { guardTestCommand } from "../security/commandGuard.js";

export type TaskStatus = "pending" | "running" | "done" | "failed";

export interface CreateTaskInput {
  plan_id: string;
  agent: string;
  repo_path?: string;
  test_command?: string;
}

export interface CreateTaskOutput {
  task_id: string;
  plan_id: string;
  agent: string;
  status: TaskStatus;
  path: string;
}

export function createTask(input: CreateTaskInput): CreateTaskOutput {
  const config = getConfig();
  const tasksDir = getTasksDir(config);
  const plansDir = getPlansDir(config);

  // Validate agent
  if (!config.agents[input.agent]) {
    throw new Error(
      `Unknown agent "${input.agent}". Available: ${Object.keys(config.agents).join(", ")}`
    );
  }

  // Validate plan exists BEFORE creating any task directory or files
  const planDir = resolve(plansDir, input.plan_id);
  const planFile = join(planDir, "plan.md");
  guardReadPath(planFile, config.workspaceRoot, config.plansDir);
  if (!existsSync(planFile)) {
    throw new Error(
      `Plan "${input.plan_id}" not found. Save a plan with save_plan first.`
    );
  }

  // Validate repo_path is within workspace
  const safeRepoPath = guardWorkspacePath(
    input.repo_path || config.workspaceRoot,
    config.workspaceRoot
  );

  // Validate test command — must be in allowlist, no swallowing
  let testCmd = "";
  if (input.test_command && input.test_command.trim() !== "") {
    testCmd = guardTestCommand(input.test_command, config);
    // guardTestCommand throws if not in allowedTestCommands
  }

  const taskId = `task_${Date.now()}_${input.plan_id.replace(/^plan_/, "")}`;
  const taskDir = resolve(tasksDir, taskId);

  guardPath(taskDir, config.workspaceRoot, config.tasksDir);
  mkdirSync(taskDir, { recursive: true });

  const status: TaskStatus = "pending";
  const statusFile = join(taskDir, "status.json");
  const statusData = {
    task_id: taskId,
    plan_id: input.plan_id,
    agent: input.agent,
    repo_path: safeRepoPath,
    test_command: testCmd,
    status,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    error: null as string | null,
  };

  writeFileSync(statusFile, JSON.stringify(statusData, null, 2), "utf-8");

  return {
    task_id: taskId,
    plan_id: input.plan_id,
    agent: input.agent,
    status,
    path: taskDir,
  };
}
