import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { getTasksDir, getPlansDir, getConfig } from "../config.js";
import { guardPath } from "../security/pathGuard.js";
import { readTaskRuntime } from "../taskRuntime.js";
import type { TaskPhase, TaskStatus } from "./createTask.js";

export interface TaskEntry {
  task_id: string;
  plan_id: string;
  title: string;
  agent: string;
  status: TaskStatus;
  phase: TaskPhase;
  created_at: string;
  updated_at: string;
  workspace_root: string;
  repo_path: string;
  resolved_repo_path: string;
  test_command: string;
  verify_commands: string[];
  error: string | null;
  last_heartbeat_at: string;
  current_command: string | null;
  timeout_seconds: number;
}

export interface ListTasksInput {
  status?: string;
  limit?: number;
}

export interface ListTasksOutput {
  tasks: TaskEntry[];
  total: number;
}

export function listTasks(input?: ListTasksInput): ListTasksOutput {
  const config = getConfig();
  const tasksDir = getTasksDir(config);
  const plansDir = getPlansDir(config);
  const limit = input?.limit && input.limit > 0 ? Math.min(input.limit, 100) : 20;
  const filterStatus = input?.status || null;

  if (!existsSync(tasksDir)) {
    return { tasks: [], total: 0 };
  }

  const entries = readdirSync(tasksDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .sort((a, b) => {
      // Sort by mtime descending (newest first)
      try {
        const sa = statSync(join(tasksDir, a.name, "status.json"));
        const sb = statSync(join(tasksDir, b.name, "status.json"));
        return sb.mtimeMs - sa.mtimeMs;
      } catch {
        return b.name.localeCompare(a.name);
      }
    });

  const tasks: TaskEntry[] = [];

  for (const entry of entries) {
    if (tasks.length >= limit) break;
    const taskId = entry.name;
    const taskDir = join(tasksDir, taskId);
    const statusFile = join(taskDir, "status.json");

    if (!existsSync(statusFile)) continue;

    try {
      const data = JSON.parse(readFileSync(statusFile, "utf-8"));
      const runtime = readTaskRuntime(taskDir);
      if (filterStatus && data.status !== filterStatus) continue;

      // Read plan title from plans directory (not task dir)
      let title = `Plan: ${data.plan_id || "unknown"}`;
      if (data.plan_id) {
        const planFile = join(plansDir, data.plan_id, "plan.md");
        if (existsSync(planFile)) {
          try {
            const planContent = readFileSync(planFile, "utf-8");
            const titleMatch = planContent.match(/^#\s*(.+)/m);
            if (titleMatch) title = titleMatch[1];
          } catch { /* keep default */ }
        }
      }

      tasks.push({
        task_id: taskId,
        plan_id: data.plan_id || "",
        title,
        agent: data.agent || "",
        status: data.status || "pending",
        phase: runtime.phase || data.phase || "queued",
        created_at: data.created_at || "",
        updated_at: data.updated_at || "",
        workspace_root: data.workspace_root || config.workspaceRoot,
        repo_path: data.repo_path || ".",
        resolved_repo_path: data.resolved_repo_path || data.repo_path || config.workspaceRoot,
        test_command: data.test_command || "",
        verify_commands: Array.isArray(data.verify_commands) ? data.verify_commands : [],
        error: data.error || null,
        last_heartbeat_at: runtime.last_heartbeat_at || data.last_heartbeat_at || data.updated_at || "",
        current_command: runtime.current_command ?? data.current_command ?? null,
        timeout_seconds: data.timeout_seconds || config.defaultTaskTimeoutSeconds,
      });
    } catch {
      // skip corrupted entries
    }
  }

  return { tasks, total: tasks.length };
}
