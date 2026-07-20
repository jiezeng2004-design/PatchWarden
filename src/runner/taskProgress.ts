import { join } from "node:path";
import type { TaskPhase } from "../tools/tasks/createTask.js";
import { atomicWriteFileSync } from "../utils/atomicFile.js";

const PHASES: Array<{ phase: TaskPhase; label: string }> = [
  { phase: "queued", label: "Queued" },
  { phase: "preparing", label: "Preparing repository snapshot" },
  { phase: "executing_agent", label: "Executing local agent" },
  { phase: "running_tests", label: "Running configured verification" },
  { phase: "collecting_artifacts", label: "Collecting diff and result artifacts" },
  { phase: "completed", label: "Completed" },
];

export function writeTaskProgress(
  taskDir: string,
  phase: TaskPhase,
  options?: { currentCommand?: string | null; note?: string; heartbeatAt?: string }
): void {
  const currentIndex = PHASES.findIndex((item) => item.phase === phase);
  const isTerminalException = phase === "failed" || phase === "canceled";
  const lines = ["# PatchWarden Task Progress", ""];

  for (let index = 0; index < PHASES.length; index++) {
    const item = PHASES[index];
    let marker = " ";
    if (currentIndex >= 0 && index < currentIndex) marker = "x";
    if (currentIndex >= 0 && index === currentIndex) marker = phase === "completed" ? "x" : ">";
    if (isTerminalException && index < PHASES.length - 1) marker = "x";
    lines.push(`- [${marker}] ${item.label}`);
  }

  if (isTerminalException) {
    lines.push("", `Final state: ${phase}`);
  }
  lines.push("", `Phase: ${phase}`);
  lines.push(`Last heartbeat: ${options?.heartbeatAt || new Date().toISOString()}`);
  if (options?.currentCommand) lines.push(`Current command: ${options.currentCommand}`);
  if (options?.note) lines.push("", `Note: ${options.note}`);

  atomicWriteFileSync(join(taskDir, "progress.md"), `${lines.join("\n")}\n`);
}
