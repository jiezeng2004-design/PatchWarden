import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import type { PatchWardenConfig } from "../../../config.js";
import {
  applyAdapterInvocationArgs,
  resolveTaskModelSelection,
  validateRequestedModel,
} from "../../../agents/modelSelection.js";
import { PatchWardenError } from "../../../errors.js";

const revision = "a".repeat(64);

describe("task Agent model selection", () => {
  it("applies task, repository, and global defaults in fixed priority order", () => {
    const config = makeConfig({
      default_model: "global/model-v1",
      repoAgentDefaults: { repo: { opencode: "repo/model-v2" } },
    });
    const project = select(config);
    assert.equal(project.effective_model, "repo/model-v2");
    assert.equal(project.configured_default_model, "repo/model-v2");
    assert.equal(project.model_source, "agent_config_default");

    const task = select(config, "task/model-v3");
    assert.equal(task.effective_model, "task/model-v3");
    assert.equal(task.requested_model, "task/model-v3");
    assert.equal(task.model_source, "task_override");
    assert.equal(task.model_fallback_used, false);
  });

  it("keeps an unobserved Claude settings model null while preserving an explicit provider", () => {
    const config = makeConfig({ adapter: "claude", provider: "agnes", settings_policy: "inherit" });
    const selection = select(config);
    assert.equal(selection.effective_model, null);
    assert.equal(selection.model_source, "agent_default_unobserved");
    assert.equal(selection.provider, "agnes");
    assert.equal(selection.model_argument_present, false);
  });

  it("builds exactly one adapter model argument and preserves or isolates Claude settings", () => {
    for (const adapter of ["codex", "claude", "opencode"] as const) {
      const args = applyAdapterInvocationArgs(adapter, {
        command: adapter,
        adapter,
        args: ["run", "--model", "old/model", "-m", "older/model", "--model=oldest/model", "{prompt}"],
      }, "agnes/agnes-2.0-flash");
      assert.deepEqual(args.filter((value) => value === "--model"), ["--model"]);
      assert.equal(args.includes("-m"), false);
      assert.equal(args[args.indexOf("--model") + 1], "agnes/agnes-2.0-flash");
    }

    const inherited = applyAdapterInvocationArgs("claude", {
      command: "claude",
      adapter: "claude",
      args: ["-p", "--setting-sources", "user,project,local", "{prompt}"],
      settings_policy: "inherit",
    }, null);
    assert.deepEqual(inherited, ["-p", "--setting-sources", "user,project,local", "{prompt}"]);

    const isolated = applyAdapterInvocationArgs("claude", {
      command: "claude",
      adapter: "claude",
      args: ["-p", "--setting-sources=user", "{prompt}"],
      settings_policy: "isolated",
    }, "claude/model-v1");
    assert.deepEqual(isolated, ["-p", "--setting-sources", "", "--model", "claude/model-v1", "{prompt}"]);
  });

  it("accepts safe model ids and rejects whitespace, controls, and shell metacharacters", () => {
    assert.equal(validateRequestedModel("  agnes/agnes-2.0-flash  "), "agnes/agnes-2.0-flash");
    for (const value of ["", "two models", "model\nnext", "model;next", "model&next", "model$HOME", `model\"quoted`]) {
      assert.throws(() => validateRequestedModel(value), (error: unknown) =>
        error instanceof PatchWardenError && error.reason === "invalid_model_argument");
    }
    assert.throws(() => validateRequestedModel(`m${"x".repeat(200)}`), /1-200 characters/);
  });

  it("fails before invocation for disallowed models and unknown adapters", () => {
    const restricted = makeConfig({
      available_models: ["agnes/allowed"],
      allow_unlisted_model_override: false,
    });
    assert.throws(() => select(restricted, "agnes/other"), (error: unknown) =>
      error instanceof PatchWardenError && error.reason === "model_not_allowed");

    const unsupported = makeConfig({ adapter: "custom" });
    assert.throws(() => select(unsupported, "custom/model"), (error: unknown) =>
      error instanceof PatchWardenError && error.reason === "model_override_not_supported");
  });

  it("preserves Claude's isolated empty argv through shell-free Windows process launch", () => {
    const child = spawnSync(process.execPath, [
      "-e",
      "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
      "--",
      "--setting-sources",
      "",
    ], { encoding: "utf-8", shell: false, windowsHide: true });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), ["--setting-sources", ""]);
  });
});

function select(config: PatchWardenConfig, requestedModel?: string) {
  return resolveTaskModelSelection({
    agentName: "opencode",
    requestedAgent: "opencode",
    selectedAgent: "opencode",
    requestedModel,
    repoPath: `${config.workspaceRoot}/repo`,
    config,
    agentConfigRevision: revision,
  });
}

function makeConfig(agent: Record<string, unknown> & { repoAgentDefaults?: unknown }): PatchWardenConfig {
  const { repoAgentDefaults, ...agentConfig } = agent;
  return {
    workspaceRoot: "C:/workspace",
    agents: {
      opencode: {
        command: "opencode",
        args: ["run", "{prompt}"],
        adapter: "opencode",
        ...agentConfig,
      },
    },
    repoAgentDefaults: repoAgentDefaults as PatchWardenConfig["repoAgentDefaults"],
  } as unknown as PatchWardenConfig;
}
