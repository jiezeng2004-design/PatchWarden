/**
 * Dispatch handlers for diagnostic / discovery tools (v0.7.1+).
 *
 * discover_tools and explain_tool are read-only catalog queries.
 * invoke_discovered_tool consumes a discovery token and dispatches to
 * the target tool via handleToolCall.
 *
 * Note: This module imports getToolDefs and handleToolCall from
 * registry.ts. The import is a live ESM binding resolved at runtime,
 * so the circular dependency (registry → diagnosticDispatch → registry)
 * is safe: neither binding is touched during module evaluation.
 */

import { discoverTools } from "../discoverTools.js";
import { explainTool } from "../explainTool.js";
import { invokeDiscoveredTool } from "../invokeDiscoveredTool.js";
import { getConfig } from "../../config.js";
import { resolveToolProfile } from "../toolCatalog.js";
import { getToolDefs, handleToolCall } from "../registry.js";
import type { ToolHandlerMap } from "./types.js";
import { toResult } from "./types.js";

export const diagnosticHandlers: ToolHandlerMap = {
  discover_tools: async (args) => {
    const profile =
      args?.profile === "full" ||
      args?.profile === "chatgpt_core" ||
      args?.profile === "chatgpt_direct" ||
      args?.profile === "chatgpt_search"
        ? args.profile
        : undefined;
    const mode =
      args?.mode === "delegate" ||
      args?.mode === "direct" ||
      args?.mode === "audit" ||
      args?.mode === "release" ||
      args?.mode === "diagnostic"
        ? args.mode
        : undefined;
    const riskCeiling = [
      "readonly",
      "workspace_read_sensitive",
      "workspace_write",
      "command",
      "release",
      "credential_sensitive",
    ].includes(String(args?.riskCeiling ?? ""))
      ? (String(args?.riskCeiling) as any)
      : undefined;
    return toResult(
      discoverTools(
        {
          query: String(args?.query ?? ""),
          profile,
          mode,
          maxResults: args?.maxResults !== undefined ? Number(args.maxResults) : undefined,
          riskCeiling,
          includeHighRisk:
            args?.includeHighRisk !== undefined ? Boolean(args.includeHighRisk) : undefined,
        },
        getToolDefs(),
      ),
    );
  },

  explain_tool: async (args) => {
    return toResult(
      explainTool(
        {
          name: String(args?.name ?? ""),
          includeSchema:
            args?.includeSchema !== undefined ? Boolean(args.includeSchema) : undefined,
        },
        getToolDefs(),
      ),
    );
  },

  invoke_discovered_tool: async (args) => {
    const profile = resolveToolProfile(getConfig().toolProfile);
    const result = await invokeDiscoveredTool(
      {
        toolName: String(args?.toolName ?? ""),
        arguments:
          args?.arguments && typeof args.arguments === "object"
            ? (args.arguments as Record<string, unknown>)
            : {},
        discoveryToken: String(args?.discoveryToken ?? ""),
        assessmentId: args?.assessmentId ? String(args.assessmentId) : undefined,
      },
      {
        tools: getToolDefs(),
        profile,
        dispatch: async (name, dispatchArgs) => {
          return handleToolCall(name, dispatchArgs);
        },
      },
    );
    return toResult(result);
  },
};
