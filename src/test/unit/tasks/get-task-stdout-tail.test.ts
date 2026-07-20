import { strict as assert } from "node:assert";
import { describe, it, beforeEach, afterEach } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { reloadConfig } from "../../../config.js";
import { getTaskStdoutTail } from "../../../tools/tasks/getTaskStdoutTail.js";

let tempDir: string;
let previousConfig: string | undefined;

describe("getTaskStdoutTail", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pw-stdout-tail-"));
    const tasksDir = join(tempDir, ".patchwarden", "tasks");
    mkdirSync(tasksDir, { recursive: true });
    const configPath = join(tempDir, "patchwarden.config.json");
    writeFileSync(configPath, JSON.stringify({
      workspaceRoot: tempDir,
      tasksDir: ".patchwarden/tasks",
      maxReadFileBytes: 256,
    }), "utf-8");
    previousConfig = process.env.PATCHWARDEN_CONFIG;
    process.env.PATCHWARDEN_CONFIG = configPath;
    reloadConfig();
  });

  afterEach(() => {
    if (previousConfig === undefined) delete process.env.PATCHWARDEN_CONFIG;
    else process.env.PATCHWARDEN_CONFIG = previousConfig;
    reloadConfig();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("reads only the bounded tail of large stdout/stderr logs", () => {
    const taskDir = join(tempDir, ".patchwarden", "tasks", "task_tail_001");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "status.json"), "{}", "utf-8");
    writeFileSync(join(taskDir, "stdout.log"), [
      "old-secret-sentinel-should-not-be-read",
      ...Array.from({ length: 100 }, (_, index) => `stdout-${index}`),
    ].join("\n"), "utf-8");
    writeFileSync(join(taskDir, "stderr.log"), [
      "old-stderr-sentinel-should-not-be-read",
      ...Array.from({ length: 100 }, (_, index) => `stderr-${index}`),
    ].join("\n"), "utf-8");

    const result = getTaskStdoutTail("task_tail_001", 3);

    assert.equal(result.source, "stdout.log");
    assert.ok(result.stdout_tail.includes("stdout-99"));
    assert.ok(!result.stdout_tail.includes("old-secret-sentinel"));
    assert.ok(result.stderr_tail.includes("stderr-99"));
    assert.ok(!result.stderr_tail.includes("old-stderr-sentinel"));
    assert.ok(result.stdout_tail.split("\n").length <= 3);
    assert.ok(result.stderr_tail.split("\n").length <= 3);
  });

  it("clamps invalid line counts and bounds result.md fallback reads", () => {
    const taskDir = join(tempDir, ".patchwarden", "tasks", "task_tail_002");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "status.json"), "{}", "utf-8");
    writeFileSync(join(taskDir, "result.md"), [
      "## Agent stdout",
      "```",
      "fallback-0",
      "fallback-1",
      "```",
      "## Agent stderr",
      "```",
      "fallback-error",
      "```",
      "x".repeat(1024),
    ].join("\n"), "utf-8");

    const result = getTaskStdoutTail("task_tail_002", Number.NaN);

    assert.equal(result.source, "result.md");
    assert.ok(result.stdout_tail.includes("fallback-1"));
    assert.ok(result.stderr_tail.includes("fallback-error"));
    assert.ok(result.stdout_tail.split("\n").length <= 80);
  });
});
