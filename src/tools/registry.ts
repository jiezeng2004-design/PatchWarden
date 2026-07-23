/**
 * Shared tool registry for PatchWarden MCP server.
 * Used by both stdio (index.ts) and HTTP (httpServer.ts) transports.
 *
 * ToolDef interface and getToolDefs() live in ./definitions/toolDefs.ts.
 * They are re-exported here so existing callers that import from
 * "./registry.js" continue to work after the Task 4 split.
 */

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { getConfig } from "../config.js";
import { errorPayload, PatchWardenError } from "../errors.js";
import { logger } from "../logging.js";
import {
  buildToolCatalogSnapshot,
  getLastToolCatalogSnapshot,
  resolveToolProfile,
  type ToolCatalogSnapshot,
} from "./catalog/toolCatalog.js";
import { getToolDefs, type ToolDef } from "./definitions/toolDefs.js";
import { coreHandlers, runTaskHandler } from "./dispatch/coreDispatch.js";
import { goalHandlers } from "./dispatch/goalDispatch.js";
import { directHandlers } from "./dispatch/directDispatch.js";
import { releaseHandlers } from "./dispatch/releaseDispatch.js";
import { buildDiagnosticHandlers } from "./dispatch/diagnosticDispatch.js";
import type { ToolHandlerMap } from "./dispatch/types.js";

// Re-export ToolDef and getToolDefs for backward compatibility with
// callers that still import from "./registry.js".
export { getToolDefs, type ToolDef };

// ── Catalog snapshot helper ──────────────────────────────────────

export function getToolCatalogSnapshot(): ToolCatalogSnapshot {
  const tools = getToolDefs();
  const config = getConfig();
  return buildToolCatalogSnapshot(tools, resolveToolProfile(config.toolProfile));
}

// ── Dispatch map ─────────────────────────────────────────────────

/**
 * Combined dispatch map assembled from all domain handler maps. Profile and
 * feature gates decide which tools are exposed; handlers also enforce their
 * own runtime gates, so the map itself is configuration-independent.
 */
function buildDispatchMap(): ToolHandlerMap {
  const map: ToolHandlerMap = {
    ...coreHandlers,
    ...goalHandlers,
    ...directHandlers,
    ...releaseHandlers,
    run_task: runTaskHandler,
  };
  Object.assign(map, buildDiagnosticHandlers((name, args) => handleToolCall(name, args)));
  return map;
}

const dispatchMap: ToolHandlerMap = buildDispatchMap();

// ── Request handler ───────────────────────────────────────────────

export async function handleToolCall(name: string, args: Record<string, unknown> | undefined) {
  const startTime = Date.now();
  const taskId = args?.task_id ? String(args.task_id) : args?.session_id ? String(args.session_id) : undefined;
  try {
    const result = await handleToolCallInternal(name, args);
    logger.audit(name, true, Date.now() - startTime, undefined, taskId);
    return result;
  } catch (err) {
    const errorReason = err instanceof Error ? err.message : String(err);
    logger.audit(name, false, Date.now() - startTime, errorReason, taskId);
    throw err;
  }
}

async function handleToolCallInternal(name: string, args: Record<string, unknown> | undefined) {
  const handler = dispatchMap[name];
  if (!handler) {
    throw new Error(`Unknown tool: ${name}`);
  }
  return handler(args);
}

// ── Register on MCP Server ────────────────────────────────────────

export function registerTools(server: Server) {
  // Compute the active tool list ONCE to guarantee list/call consistency.
  // Re-calling getToolDefs() on every request risks divergence between
  // tools/list and tools/call when the profile is reconfigured at runtime.
  const activeTools = getToolDefs();
  const activeNames = new Set(activeTools.map((tool) => tool.name));

  // Verify every registered tool has a dispatch handler.
  // The dispatch map may contain extra handlers for tools exposed under
  // other profiles (e.g. get_plan is only in the "full" profile), so we
  // only check the subset direction: every active tool must have a handler.
  for (const tool of activeTools) {
    if (!dispatchMap[tool.name]) {
      throw new Error(
        `Dispatch map is missing handler for registered tool "${tool.name}".`,
      );
    }
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const catalog = getLastToolCatalogSnapshot();
    return {
      tools: activeTools,
      ...(catalog
        ? {
            _meta: {
              server_version: catalog.server_version,
              schema_epoch: catalog.schema_epoch,
              tool_profile: catalog.tool_profile,
              tool_count: catalog.tool_count,
              tool_manifest_sha256: catalog.tool_manifest_sha256,
            },
          }
        : {}),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      if (!activeNames.has(name)) {
        const catalog = getToolCatalogSnapshot();
        throw new PatchWardenError(
          "tool_catalog_mismatch",
          `Tool "${name}" is not available in the active ${catalog.tool_profile} profile. The client may be using a stale tool catalog.`,
          "Refresh or reconnect the ChatGPT Connector and open a new conversation before retrying.",
          true,
          {
            requested_tool: name,
            refresh_required: true,
            server_version: catalog.server_version,
            schema_epoch: catalog.schema_epoch,
            tool_profile: catalog.tool_profile,
            tool_count: catalog.tool_count,
            tool_names: catalog.tool_names,
            tool_manifest_sha256: catalog.tool_manifest_sha256,
            next_tool_call: {
              name: "health_check",
              arguments: { detail: "self_diagnostic" },
            },
            connector_refresh_steps: [
              "1. Run PatchWarden.cmd health locally to confirm the active profile and manifest hash.",
              "2. In ChatGPT Platform, refresh or reconnect the Connector (do not reuse an old session).",
              "3. Open a NEW ChatGPT conversation; old conversations retain their cached tool catalog.",
              "4. Call health_check in the new conversation and verify tool_manifest_sha256 matches the local report.",
            ],
          }
        );
      }
      return await handleToolCall(name, args);
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify(errorPayload(err)) }],
        isError: true,
      };
    }
  });
}
