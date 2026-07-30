/**
 * Dispatch handlers for Direct session tools.
 *
 * Direct sessions allow ChatGPT to apply patches directly within a
 * repo-scoped workspace. All handlers guard on enableDirectProfile.
 */

import { getConfig } from "../../config.js";
import { PatchWardenError } from "../../errors.js";
import { createDirectSession } from "../direct/createDirectSession.js";
import { searchWorkspace } from "../workspace/searchWorkspace.js";
import { applyPatch } from "../workspace/applyPatch.js";
import { runVerification } from "../tasks/runVerification.js";
import { runDirectVerificationBundle } from "../direct/runDirectVerificationBundle.js";
import { finalizeDirectSession } from "../direct/finalizeDirectSession.js";
import { auditSession } from "../diagnostics/auditSession.js";
import { syncFile } from "../workspace/syncFile.js";
import { createDirectFile, deleteDirectFile, mkdirDirect, moveDirectFile } from "../workspace/directFileOperations.js";
import { requestDirectReview } from "../../direct/directReviewGate.js";
import type { DirectReviewOperationType } from "../../direct/directSessionStore.js";
import {
  safeAuditDirectSession,
  safeDirectSummary,
  safeFinalizeDirectSession,
} from "../diagnostics/safeViews.js";
import type { ToolHandlerMap } from "./types.js";
import { toResult } from "./types.js";
import { parsePatchOperations } from "./validation.js";

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
        expected_changes: args?.expected_changes !== undefined
          ? Boolean(args.expected_changes)
          : undefined,
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
        operations: parsePatchOperations(args?.operations),
        review_id: args?.review_id ? String(args.review_id) : undefined,
      }),
    );
  },

  create_file: async (args) => {
    guardDirectProfileEnabled();
    return toResult(createDirectFile({
      session_id: String(args?.session_id ?? ""),
      path: String(args?.path ?? ""),
      content: String(args?.content ?? ""),
      review_id: args?.review_id ? String(args.review_id) : undefined,
    }));
  },

  mkdir: async (args) => {
    guardDirectProfileEnabled();
    return toResult(mkdirDirect({ session_id: String(args?.session_id ?? ""), path: String(args?.path ?? ""), review_id: args?.review_id ? String(args.review_id) : undefined }));
  },

  move_file: async (args) => {
    guardDirectProfileEnabled();
    return toResult(moveDirectFile({
      session_id: String(args?.session_id ?? ""),
      source_path: String(args?.source_path ?? ""),
      target_path: String(args?.target_path ?? ""),
      expected_source_sha256: String(args?.expected_source_sha256 ?? ""),
      review_id: args?.review_id ? String(args.review_id) : undefined,
    }));
  },

  delete_file: async (args) => {
    guardDirectProfileEnabled();
    return toResult(deleteDirectFile({
      session_id: String(args?.session_id ?? ""),
      path: String(args?.path ?? ""),
      expected_sha256: String(args?.expected_sha256 ?? ""),
      confirm_delete: args?.confirm_delete === true,
      review_id: args?.review_id ? String(args.review_id) : undefined,
    }));
  },

  request_direct_review: async (args) => {
    guardDirectProfileEnabled();
    const operationType = String(args?.operation_type ?? "") as DirectReviewOperationType;
    return toResult(await requestDirectReview({
      session_id: String(args?.session_id ?? ""),
      operation_type: operationType,
      path: args?.path,
      source_path: args?.source_path,
      target_path: args?.target_path,
      expected_sha256: args?.expected_sha256,
      expected_source_sha256: args?.expected_source_sha256,
      operations: operationType === "patch" ? parsePatchOperations(args?.operations) : args?.operations,
      content: args?.content,
      command: args?.command,
      commands: args?.commands,
      timeout_seconds: args?.timeout_seconds,
    }));
  },

  run_verification: async (args) => {
    guardDirectProfileEnabled();
    return toResult(
      await runVerification({
        session_id: String(args?.session_id ?? ""),
        command: String(args?.command ?? ""),
        timeout_seconds: args?.timeout_seconds ? Number(args.timeout_seconds) : undefined,
        review_id: args?.review_id ? String(args.review_id) : undefined,
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
        review_id: args?.review_id ? String(args.review_id) : undefined,
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
