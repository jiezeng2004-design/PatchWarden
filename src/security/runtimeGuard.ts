import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PatchWardenError } from "../errors.js";
import { isPathChildOf, isSamePath } from "../utils/platform.js";

const CRITICAL_RUNTIME_DIRS = ["dist", "src", "scripts", "release"];

/**
 * Refuse operations against the active PatchWarden runtime directory or its
 * critical subdirectories. Extracted from createTask.ts so assess-only flows
 * and direct-session flows share the same protection.
 */
export function guardRuntimeSelfModification(resolvedRepoPath: string): void {
  // runtimeGuard lives at <package-root>/{src,dist}/security/runtimeGuard.*.
  const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const isRuntimeRoot = isSamePath(resolvedRepoPath, runtimeRoot);
  if (
    isRuntimeRoot ||
    isPathChildOf(resolvedRepoPath, runtimeRoot)
  ) {
    const isCritical = CRITICAL_RUNTIME_DIRS.some((dir) => {
      const full = join(runtimeRoot, dir);
      return (
        isSamePath(resolvedRepoPath, full) ||
        isPathChildOf(resolvedRepoPath, full)
      );
    });
    if (isRuntimeRoot || isCritical) {
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
