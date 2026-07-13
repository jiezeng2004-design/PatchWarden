#!/usr/bin/env node
/**
 * PatchWarden MCP Server — stdio transport
 *
 * Run: node dist/index.js
 * Used by OpenAI tunnel-client via `--mcp.command`:
 *   tunnel-client ... --mcp.command "node" --mcp.args "dist/index.js"
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { registerTools } from "./tools/registry.js";
import { PATCHWARDEN_VERSION } from "./version.js";
import { logger } from "./logging.js";

const config = loadConfig();

logger.info(`[patchwarden] Workspace: ${config.workspaceRoot}`);
logger.info("[patchwarden] Transport: stdio");

const server = new Server(
  { name: "patchwarden", version: PATCHWARDEN_VERSION },
  { capabilities: { tools: {} } }
);

registerTools(server);

const transport = new StdioServerTransport();
server.connect(transport).catch((err) => {
  logger.fatal("[patchwarden] Fatal", {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});

logger.info("[patchwarden] MCP server ready on stdio");
