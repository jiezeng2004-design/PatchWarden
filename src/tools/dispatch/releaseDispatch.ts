/**
 * Dispatch handlers for release-mode tools (v1.3.0+).
 *
 * Wraps releaseCheck, releasePrepare, releaseVerify, and releaseCleanup
 * from releaseMode.ts.
 */

import {
  releaseCheck,
  releasePrepare,
  releaseVerify,
  releaseCleanup,
} from "../release/releaseMode.js";
import type { ToolHandlerMap } from "./types.js";
import { toResult } from "./types.js";
import { parseReleaseStage } from "./validation.js";

export const releaseHandlers: ToolHandlerMap = {
  release_check: async (args) => {
    return toResult(
      await releaseCheck({
        repo_path: String(args?.repo_path ?? ""),
        target_stage: parseReleaseStage(args?.target_stage),
        package_name: args?.package_name ? String(args.package_name) : undefined,
        version: args?.version ? String(args.version) : undefined,
        github_repo: args?.github_repo ? String(args.github_repo) : undefined,
        branch: args?.branch ? String(args.branch) : undefined,
      }),
    );
  },

  release_prepare: async (args) => {
    return toResult(
      releasePrepare({
        repo_path: String(args?.repo_path ?? ""),
        required_commands: Array.isArray(args?.required_commands)
          ? args.required_commands.map(String)
          : undefined,
        timeout_seconds:
          args?.timeout_seconds !== undefined ? Number(args.timeout_seconds) : undefined,
      }),
    );
  },

  release_verify: async (args) => {
    return toResult(
      await releaseVerify({
        repo_path: String(args?.repo_path ?? ""),
        package_name: args?.package_name ? String(args.package_name) : undefined,
        version: args?.version ? String(args.version) : undefined,
        github_repo: args?.github_repo ? String(args.github_repo) : undefined,
        branch: args?.branch ? String(args.branch) : undefined,
      }),
    );
  },

  release_cleanup: async (args) => {
    return toResult(
      releaseCleanup({
        repo_path: String(args?.repo_path ?? ""),
        dry_run: args?.dry_run !== undefined ? Boolean(args.dry_run) : undefined,
        patterns: Array.isArray(args?.patterns) ? args.patterns.map(String) : undefined,
      }),
    );
  },
};
