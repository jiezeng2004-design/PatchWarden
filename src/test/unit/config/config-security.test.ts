import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { reloadConfig } from "../../../config.js";

describe("configuration security defaults", () => {
  let root: string;
  let configPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "patchwarden-config-security-"));
    configPath = join(root, "patchwarden.config.json");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("does not implicitly register execution agents", () => {
    writeFileSync(configPath, JSON.stringify({ workspaceRoot: root }), "utf-8");
    const config = reloadConfig(configPath);
    assert.deepEqual(config.agents, {});
  });

  it("preserves explicitly registered agents", () => {
    writeFileSync(configPath, JSON.stringify({
      workspaceRoot: root,
      agents: {
        fixture: { command: process.execPath, args: ["{prompt}"] },
      },
    }), "utf-8");
    const config = reloadConfig(configPath);
    assert.deepEqual(Object.keys(config.agents), ["fixture"]);
    assert.equal(config.agents.fixture.command, process.execPath);
  });

  it("rejects a missing workspace root during config load", () => {
    writeFileSync(configPath, JSON.stringify({ workspaceRoot: join(root, "missing") }), "utf-8");
    assert.throws(() => reloadConfig(configPath), /workspaceRoot does not exist/);
  });

  it("rejects invalid HTTP owner token environment names", () => {
    for (const ownerTokenEnv of ["", "OWNER TOKEN", "9OWNER", "OWNER=TOKEN"]) {
      writeFileSync(configPath, JSON.stringify({
        workspaceRoot: root,
        http: { ownerTokenEnv },
      }), "utf-8");
      assert.throws(
        () => reloadConfig(configPath),
        /http\.ownerTokenEnv must be a valid environment variable name/,
      );
    }
  });

  it("defaults and bounds archived task retention settings", () => {
    writeFileSync(configPath, JSON.stringify({ workspaceRoot: root }), "utf-8");
    const config = reloadConfig(configPath);
    assert.equal(config.taskArchiveRetentionDays, 30);
    assert.equal(config.taskArchiveCleanupIntervalHours, 24);
    assert.equal(config.taskArchiveCleanupMaxBatch, 100);

    for (const invalid of [
      { taskArchiveRetentionDays: 0 },
      { taskArchiveRetentionDays: 3651 },
      { taskArchiveCleanupIntervalHours: 0 },
      { taskArchiveCleanupIntervalHours: 169 },
      { taskArchiveCleanupMaxBatch: 0 },
      { taskArchiveCleanupMaxBatch: 101 },
    ]) {
      writeFileSync(configPath, JSON.stringify({ workspaceRoot: root, ...invalid }), "utf-8");
      assert.throws(() => reloadConfig(configPath), /taskArchive/);
    }
  });

  it("normalizes bounded Agent fallback policy and rejects unsafe overlaps", () => {
    const agents = {
      opencode: { command: process.execPath, args: ["{prompt}"] },
      claude: { command: process.execPath, args: ["{prompt}"] },
      codex: { command: process.execPath, args: ["{prompt}"] },
    };
    writeFileSync(configPath, JSON.stringify({
      workspaceRoot: root,
      agents,
      agent_priority: ["opencode", "claude", "codex"],
      max_retries_per_agent: 1,
      fallback_on: ["agent_execution_error", "verification_failure"],
      do_not_fallback_on: ["policy_block"],
    }), "utf-8");
    const config = reloadConfig(configPath);
    assert.deepEqual(config.agentPriority, ["opencode", "claude", "codex"]);
    assert.equal(config.maxRetriesPerAgent, 1);
    assert.deepEqual(config.fallbackOn, ["agent_execution_error", "verification_failure"]);
    assert.ok(config.doNotFallbackOn?.includes("scope_violation"));
    assert.ok(config.doNotFallbackOn?.includes("connector_failure"));

    for (const invalid of [
      { agentPriority: ["missing"] },
      { agentPriority: ["codex", "codex"] },
      { maxRetriesPerAgent: 4 },
      { fallbackOn: ["policy_block"] },
      { fallbackOn: ["not_a_category"] },
    ]) {
      writeFileSync(configPath, JSON.stringify({ workspaceRoot: root, agents, ...invalid }), "utf-8");
      assert.throws(() => reloadConfig(configPath), /agentPriority|maxRetriesPerAgent|fallbackOn/);
    }
  });

  it("normalizes generated path aliases and rejects unsafe patterns", () => {
    writeFileSync(configPath, JSON.stringify({
      workspaceRoot: root,
      generated_paths: [".next/**", "*.tsbuildinfo"],
      repo_generated_paths: { app: ["custom-output/**"] },
    }), "utf-8");
    const config = reloadConfig(configPath);
    assert.deepEqual(config.generatedPaths, [".next/**", "*.tsbuildinfo"]);
    assert.deepEqual(config.repoGeneratedPaths, { app: ["custom-output/**"] });

    for (const generatedPaths of [["**"], ["../outside/**"], ["C:/outside/**"], ["src/**"], ["**/*.ts"]]) {
      writeFileSync(configPath, JSON.stringify({ workspaceRoot: root, generatedPaths }), "utf-8");
      assert.throws(() => reloadConfig(configPath), /generatedPaths/);
    }
  });

  it("normalizes runtime browser validation and rejects non-loopback targets", () => {
    writeFileSync(configPath, JSON.stringify({
      workspaceRoot: root,
      runtime_validation: {
        enabled: true,
        start_command: "npm run preview",
        base_url: "http://127.0.0.1:4173",
        routes: ["/", "/about"],
        check_broken_images: true,
      },
    }), "utf-8");
    const config = reloadConfig(configPath);
    assert.equal(config.runtimeValidation?.startCommand, "npm run preview");
    assert.equal(config.runtimeValidation?.baseUrl, "http://127.0.0.1:4173");
    assert.deepEqual(config.runtimeValidation?.routes, ["/", "/about"]);

    for (const base_url of ["https://example.com", "http://localhost:4173", "http://user:pass@127.0.0.1:4173"]) {
      writeFileSync(configPath, JSON.stringify({
        workspaceRoot: root,
        runtimeValidation: { enabled: true, start_command: "npm run preview", base_url, routes: ["/"] },
      }), "utf-8");
      assert.throws(() => reloadConfig(configPath), /literal HTTP loopback URL/);
    }
    for (const routes of [["//example.com"], ["/../escape"], ["/bad\\path"]]) {
      writeFileSync(configPath, JSON.stringify({
        workspaceRoot: root,
        runtimeValidation: { enabled: true, start_command: "npm run preview", base_url: "http://127.0.0.1:4173", routes },
      }), "utf-8");
      assert.throws(() => reloadConfig(configPath), /root-relative route/);
    }
  });
});
