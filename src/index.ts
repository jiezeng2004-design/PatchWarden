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

const config = loadConfig();

console.error(`[patchwarden] Workspace: ${config.workspaceRoot}`);
console.error(`[patchwarden] Transport: stdio`);

const server = new Server(
  { name: "patchwarden", version: PATCHWARDEN_VERSION },
  { capabilities: { tools: {} } }
);

registerTools(server);

const transport = new StdioServerTransport();
server.connect(transport).catch((err) => {
  console.error("[patchwarden] Fatal:", err);
  process.exit(1);
});

console.error("[patchwarden] MCP server ready on stdio");
