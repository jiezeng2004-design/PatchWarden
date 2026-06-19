import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TaskPhase } from "./tools/createTask.js";

export interface TaskRuntimeData {
  phase: TaskPhase;
  last_heartbeat_at: string;
  current_command: string | null;
  runner_pid?: number;
  child_pid?: number;
}

export function readTaskRuntime(taskDir: string): Partial<TaskRuntimeData> {
  const runtimeFile = join(taskDir, "runtime.json");
  if (!existsSync(runtimeFile)) return {};
  try {
    return JSON.parse(readFileSync(runtimeFile, "utf-8")) as Partial<TaskRuntimeData>;
  } catch {
    return {};
  }
}

export function writeTaskRuntime(
  taskDir: string,
  patch: Partial<TaskRuntimeData>
): TaskRuntimeData {
  const current = readTaskRuntime(taskDir);
  const next = {
    phase: "preparing" as TaskPhase,
    last_heartbeat_at: new Date().toISOString(),
    current_command: null,
    ...current,
    ...patch,
  };
  writeFileSync(join(taskDir, "runtime.json"), JSON.stringify(next, null, 2), "utf-8");
  return next;
}
