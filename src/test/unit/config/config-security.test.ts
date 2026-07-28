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
});
