import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PatchWardenError } from "../errors.js";

const CRITICAL_RUNTIME_DIRS = ["dist", "src", "scripts", "release"];

/**
 * Refuse operations against the active PatchWarden runtime directory or its
 * critical subdirectories. Extracted from createTask.ts so assess-only flows
 * and direct-session flows share the same protection.
 */
export function guardRuntimeSelfModification(resolvedRepoPath: string): void {
  const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  if (
    resolvedRepoPath === runtimeRoot ||
    resolvedRepoPath.startsWith(runtimeRoot + resolve("/")[0])
  ) {
    const isCritical = CRITICAL_RUNTIME_DIRS.some((dir) => {
      const full = join(runtimeRoot, dir);
      return (
        resolvedRepoPath === full ||
        resolvedRepoPath.startsWith(full + resolve("/")[0])
      );
    });
    if (resolvedRepoPath === runtimeRoot || isCritical) {
      throw new PatchWardenError(
        "runtime_self_modification_blocked",
        `repo_path points to the active PatchWarden runtime or its critical subdirectories.`,
        "Use a dev copy or git worktree for PatchWarden development. The running MCP server must not be modified by a task.",
        true,
        {
          operation: "runtime_guard",
          path: resolvedRepoPath,
          runtime_root: runtimeRoot,
          safe_alternative:
            "Clone or copy PatchWarden to a separate directory for development tasks.",
        }
      );
    }
  }
}
