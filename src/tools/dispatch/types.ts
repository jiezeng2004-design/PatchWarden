/**
 * Shared types and helpers for the dispatch map.
 *
 * Each domain dispatch file exports a `ToolHandlerMap` whose handlers
 * directly call the existing tool functions — no logic is rewritten.
 */

export type ToolHandler = (
  args: Record<string, unknown> | undefined,
) => Promise<{ content: Array<{ type: string; text: string }> }>;

export type ToolHandlerMap = Record<string, ToolHandler>;

/**
 * Wrap a plain data value into the MCP CallToolResult content envelope.
 * Mirrors the original `toResult` helper from registry.ts.
 */
export function toResult(data: unknown): {
  content: Array<{ type: string; text: string }>;
} {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}
