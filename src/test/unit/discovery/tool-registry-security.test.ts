import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  buildToolRegistry,
  getStaticToolMeta,
} from "../../../tools/catalog/toolRegistry.js";
import { discoverTools } from "../../../tools/catalog/toolSearch.js";
import type { ToolDef } from "../../../tools/registry.js";

const STATE_WRITING_SAFE_TOOLS = [
  "safe_audit",
  "safe_finalize_direct_session",
  "safe_audit_direct_session",
] as const;

function toolDef(name: string): ToolDef {
  return {
    name,
    description: name,
    inputSchema: { type: "object", properties: {} },
  };
}

describe("state-writing safe tool metadata", () => {
  it("classifies audit and finalize wrappers as workspace writes", () => {
    for (const name of STATE_WRITING_SAFE_TOOLS) {
      const meta = getStaticToolMeta(name);
      assert.ok(meta, `${name} should have static metadata`);
      assert.equal(meta.risk, "workspace_write");
      assert.ok(meta.modes.includes("audit"));
    }
  });

  it("does not expose state-writing wrappers under a readonly risk ceiling", () => {
    const registry = buildToolRegistry(STATE_WRITING_SAFE_TOOLS.map(toolDef));
    const result = discoverTools(
      {
        query: "",
        riskCeiling: "readonly",
        includeHighRisk: true,
        maxResults: 10,
      },
      registry
    );

    assert.deepEqual(result.results, []);
    assert.ok(result.hidden_results.some((entry) => entry.reason.includes("riskCeiling")));
  });
});
