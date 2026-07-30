import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { reloadConfig } from "../../../config.js";
import { readDirectSession } from "../../../direct/directSessionStore.js";
import { PatchWardenError } from "../../../errors.js";
import { createDirectSession } from "../../../tools/direct/createDirectSession.js";
import { buildToolCatalogSnapshot, CHATGPT_DIRECT_TOOL_NAMES } from "../../../tools/catalog/toolCatalog.js";
import { buildToolRegistry } from "../../../tools/catalog/toolRegistry.js";
import { getToolDefs, type ToolDef } from "../../../tools/definitions/toolDefs.js";
import { handleToolCall } from "../../../tools/registry.js";

function tool(annotations: ToolDef["annotations"]): ToolDef {
  return {
    name: "request_direct_review",
    description: "Review an exact Direct operation.",
    annotations,
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string" } },
      required: ["session_id"],
    },
  };
}

describe("Direct MCP metadata", () => {
  it("includes request_direct_review in the Direct catalog and static registry", () => {
    assert.ok(CHATGPT_DIRECT_TOOL_NAMES.includes("request_direct_review"));
    const registry = buildToolRegistry([tool({ readOnlyHint: true })]);
    assert.equal(registry[0]?.name, "request_direct_review");
    assert.equal(registry[0]?.risk, "readonly");
    assert.ok(registry[0]?.modes.includes("direct"));
  });

  it("binds MCP annotations into the catalog manifest hash", () => {
    const first = buildToolCatalogSnapshot([tool({ readOnlyHint: false })], "chatgpt_direct");
    const second = buildToolCatalogSnapshot([tool({ readOnlyHint: true })], "chatgpt_direct");
    assert.notEqual(first.tool_manifest_sha256, second.tool_manifest_sha256);
  });

  it("binds Direct requester identity to trusted config and dispatches exact-operation reviews", async () => {
    const root = mkdtempSync(join(tmpdir(), "patchwarden-direct-tool-meta-"));
    const repo = join(root, "repo");
    const configPath = join(root, "patchwarden.config.json");
    const previousConfig = process.env.PATCHWARDEN_CONFIG;
    const previousProfile = process.env.PATCHWARDEN_TOOL_PROFILE;
    try {
      mkdirSync(repo, { recursive: true });
      writeFileSync(join(repo, "README.md"), "fixture\n", "utf-8");
      execFileSync("git", ["init"], { cwd: repo, windowsHide: true });
      execFileSync("git", ["add", "."], { cwd: repo, windowsHide: true });
      execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture"], { cwd: repo, windowsHide: true });
      writeFileSync(configPath, JSON.stringify({
        workspaceRoot: root,
        enableDirectProfile: true,
        toolProfile: "chatgpt_direct",
        agents: {
          requester: { command: "node", args: ["--version"] },
          reviewer: { command: "node", args: ["--version"] },
        },
        directReview: {
          mode: "enforce",
          requesterAgentName: "requester",
          reviewerAgentName: "reviewer",
          autoReviewRequired: true,
          ttlSeconds: 300,
        },
      }), "utf-8");
      process.env.PATCHWARDEN_CONFIG = configPath;
      process.env.PATCHWARDEN_TOOL_PROFILE = "chatgpt_direct";
      reloadConfig();

      const definitions = getToolDefs();
      const sessionDefinition = definitions.find((entry) => entry.name === "create_direct_session");
      assert.equal(sessionDefinition?.inputSchema.properties.requester_agent, undefined);
      const requestReviewDefinition = definitions.find((entry) => entry.name === "request_direct_review");
      assert.equal(requestReviewDefinition?.annotations?.readOnlyHint, true);
      assert.equal(requestReviewDefinition?.annotations?.openWorldHint, true);
      for (const name of ["apply_patch", "create_file", "mkdir", "move_file", "delete_file", "run_verification", "run_direct_verification_bundle"]) {
        assert.equal(definitions.find((entry) => entry.name === name)?.annotations?.destructiveHint, true, `${name} must advertise side effects`);
      }
      for (const name of ["run_verification", "run_direct_verification_bundle"]) {
        assert.equal(definitions.find((entry) => entry.name === name)?.annotations?.openWorldHint, true, `${name} may access external resources`);
      }

      const createResult = await handleToolCall("create_direct_session", {
        repo_path: "repo",
        requester_agent: "reviewer",
      });
      const session = JSON.parse(createResult.content[0]?.text || "{}") as { session_id?: string; requester_agent?: string };
      assert.ok(session.session_id);
      assert.equal(session.requester_agent, "requester");
      assert.equal(readDirectSession(session.session_id).requester_agent, "requester");
      await assert.rejects(
        createDirectSession({ repo_path: "repo", requester_agent: "reviewer" }),
        (error: unknown) => error instanceof PatchWardenError
          && error.reason === "direct_requester_identity_mismatch",
      );

      const reviewResult = await handleToolCall("request_direct_review", {
        session_id: session.session_id,
        operation_type: "mkdir",
        path: "generated",
      });
      const review = JSON.parse(reviewResult.content[0]?.text || "{}") as { review_id?: string; operation_type?: string; decision?: string };
      assert.match(review.review_id || "", /^direct_review_/);
      assert.equal(review.operation_type, "mkdir");
      assert.equal(review.decision, "blocked");
    } finally {
      if (previousConfig === undefined) delete process.env.PATCHWARDEN_CONFIG;
      else process.env.PATCHWARDEN_CONFIG = previousConfig;
      if (previousProfile === undefined) delete process.env.PATCHWARDEN_TOOL_PROFILE;
      else process.env.PATCHWARDEN_TOOL_PROFILE = previousProfile;
      reloadConfig();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
