/**
 * Dispatch handlers for diagnostic / discovery tools (v0.7.1+).
 *
 * discover_tools and explain_tool are read-only catalog queries.
 * invoke_discovered_tool consumes a discovery token and dispatches to
 * the target tool via handleToolCall.
 *
 * The registry injects the audited dispatcher used by invoke_discovered_tool,
 * avoiding a registry -> diagnosticDispatch -> registry import cycle.
 */

import { discoverTools } from "../discovery/discoverTools.js";
import { explainTool } from "../discovery/explainTool.js";
import { invokeDiscoveredTool } from "../discovery/invokeDiscoveredTool.js";
import { getConfig } from "../../config.js";
import { resolveToolProfile } from "../catalog/toolCatalog.js";
import type { ToolRisk } from "../catalog/toolRegistry.js";
import { getToolDefs } from "../definitions/toolDefs.js";
import type { ToolHandlerMap } from "./types.js";
import { toResult } from "./types.js";

export function buildDiagnosticHandlers(
  dispatchTool: (name: string, args: Record<string, unknown> | undefined) => Promise<unknown>,
): ToolHandlerMap {
  return {
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
    const riskCeilings = new Set<string>([
      "readonly",
      "workspace_read_sensitive",
      "workspace_write",
      "command",
      "release",
      "credential_sensitive",
    ]);
    const requestedRiskCeiling = String(args?.riskCeiling ?? "");
    const riskCeiling = riskCeilings.has(requestedRiskCeiling)
      ? (requestedRiskCeiling as ToolRisk)
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
          return dispatchTool(name, dispatchArgs);
        },
      },
    );
    return toResult(result);
    },
  };
}
