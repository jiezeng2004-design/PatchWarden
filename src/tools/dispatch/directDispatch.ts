/**
 * Dispatch handlers for Direct session tools.
 *
 * Direct sessions allow ChatGPT to apply patches directly within a
 * repo-scoped workspace. All handlers guard on enableDirectProfile.
 */

import { getConfig } from "../../config.js";
import { PatchWardenError } from "../../errors.js";
import { createDirectSession } from "../createDirectSession.js";
import { searchWorkspace } from "../searchWorkspace.js";
import { applyPatch } from "../applyPatch.js";
import { runVerification } from "../runVerification.js";
import { runDirectVerificationBundle } from "../runDirectVerificationBundle.js";
import { finalizeDirectSession } from "../finalizeDirectSession.js";
import { auditSession } from "../auditSession.js";
import { syncFile } from "../syncFile.js";
import {
  safeAuditDirectSession,
  safeDirectSummary,
  safeFinalizeDirectSession,
} from "../safeViews.js";
import type { ToolHandlerMap } from "./types.js";
import { toResult } from "./types.js";

/** Mirror of guardDirectProfileEnabled from the original registry.ts. */
function guardDirectProfileEnabled(): void {
  const config = getConfig();
  if (!config.enableDirectProfile) {
    throw new PatchWardenError(
      "direct_profile_disabled",
      "Direct profile is disabled by local config.",
      "Set enableDirectProfile: true in patchwarden.config.json to use Direct session tools.",
      true,
      { operation: "direct_tool_call" },
    );
  }
}

export const directHandlers: ToolHandlerMap = {
  create_direct_session: async (args) => {
    guardDirectProfileEnabled();
    return toResult(
      await createDirectSession({
        repo_path: String(args?.repo_path ?? ""),
        title: args?.title ? String(args.title) : undefined,
      }),
    );
  },

  search_workspace: async (args) => {
    guardDirectProfileEnabled();
    return toResult(
      searchWorkspace({
        session_id: String(args?.session_id ?? ""),
        query: String(args?.query ?? ""),
        max_results: args?.max_results ? Number(args.max_results) : undefined,
        case_sensitive:
          args?.case_sensitive !== undefined ? Boolean(args.case_sensitive) : undefined,
        max_preview_chars: args?.max_preview_chars ? Number(args.max_preview_chars) : undefined,
        include_globs: Array.isArray(args?.include_globs)
          ? args.include_globs.map(String)
          : undefined,
      }),
    );
  },

  apply_patch: async (args) => {
    guardDirectProfileEnabled();
    return toResult(
      applyPatch({
        session_id: String(args?.session_id ?? ""),
        path: String(args?.path ?? ""),
        expected_sha256: String(args?.expected_sha256 ?? ""),
        operations: Array.isArray(args?.operations) ? (args.operations as any) : [],
      }),
    );
  },

  run_verification: async (args) => {
    guardDirectProfileEnabled();
    return toResult(
      await runVerification({
        session_id: String(args?.session_id ?? ""),
        command: String(args?.command ?? ""),
        timeout_seconds: args?.timeout_seconds ? Number(args.timeout_seconds) : undefined,
      }),
    );
  },

  run_direct_verification_bundle: async (args) => {
    guardDirectProfileEnabled();
    return toResult(
      await runDirectVerificationBundle({
        session_id: String(args?.session_id ?? ""),
        commands: Array.isArray(args?.commands)
          ? args.commands.map((command) => String(command))
          : [],
        timeout_seconds: args?.timeout_seconds ? Number(args.timeout_seconds) : undefined,
      }),
    );
  },

  finalize_direct_session: async (args) => {
    guardDirectProfileEnabled();
    return toResult(
      await finalizeDirectSession({
        session_id: String(args?.session_id ?? ""),
      }),
    );
  },

  audit_session: async (args) => {
    guardDirectProfileEnabled();
    return toResult(
      auditSession({
        session_id: String(args?.session_id ?? ""),
      }),
    );
  },

  safe_direct_summary: async (args) => {
    guardDirectProfileEnabled();
    return toResult(
      safeDirectSummary(String(args?.session_id ?? ""), {
        max_items: args?.max_items !== undefined ? Number(args.max_items) : undefined,
      }),
    );
  },

  safe_finalize_direct_session: async (args) => {
    guardDirectProfileEnabled();
    return toResult(
      await safeFinalizeDirectSession(String(args?.session_id ?? ""), {
        max_items: args?.max_items !== undefined ? Number(args.max_items) : undefined,
      }),
    );
  },

  safe_audit_direct_session: async (args) => {
    guardDirectProfileEnabled();
    return toResult(
      safeAuditDirectSession(String(args?.session_id ?? ""), {
        max_items: args?.max_items !== undefined ? Number(args.max_items) : undefined,
      }),
    );
  },

  sync_file: async (args) => {
    guardDirectProfileEnabled();
    return toResult(
      syncFile(
        String(args?.session_id ?? ""),
        String(args?.source_path ?? ""),
        String(args?.target_path ?? ""),
        {
          expected_source_sha256: args?.expected_source_sha256
            ? String(args.expected_source_sha256)
            : undefined,
          expected_target_sha256: args?.expected_target_sha256
            ? String(args.expected_target_sha256)
            : undefined,
        },
      ),
    );
  },
};
