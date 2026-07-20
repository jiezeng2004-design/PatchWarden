import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  claimPendingTask,
  readTaskStatusFile,
  updateTaskStatusFile,
} from "../../../runner/taskStatusStore.js";

describe("task status store", () => {
  let root: string;
  let statusFile: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pw-task-status-"));
    statusFile = join(root, "status.json");
    writeFileSync(statusFile, JSON.stringify({ status: "pending", phase: "queued" }), "utf-8");
  });

  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it("claims pending exactly once and preserves later control fields", () => {
    assert.equal(claimPendingTask(statusFile, { status: "running", phase: "preparing" }).claimed, true);
    assert.equal(claimPendingTask(statusFile, { status: "running" }).claimed, false);

    updateTaskStatusFile(statusFile, { cancel_requested: true, phase: "canceling" });
    updateTaskStatusFile(statusFile, { last_heartbeat_at: new Date().toISOString() });
    const status = readTaskStatusFile(statusFile);
    assert.equal(status.status, "running");
    assert.equal(status.cancel_requested, true);
    assert.equal(status.phase, "canceling");
    assert.deepEqual(readdirSync(root).filter((name) => name.includes(".tmp") || name.endsWith(".lock")), []);
  });

  it("allows only one of several processes to claim the same task", { timeout: 10_000 }, async () => {
    const modulePath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../../runner/taskStatusStore.js",
    );
    const startFile = join(root, "start");
    const source = [
      `const fs = await import("node:fs");`,
      `const timers = await import("node:timers/promises");`,
      `const store = await import(${JSON.stringify(pathToFileURL(modulePath).href)});`,
      `while (!fs.existsSync(process.argv[1])) await timers.setTimeout(5);`,
      `const result = store.claimPendingTask(process.argv[2], { status: "running", phase: "preparing" });`,
      `process.stdout.write(JSON.stringify(result));`,
    ].join("\n");

    const children = Array.from({ length: 6 }, () => new Promise<string>((resolveOutput, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", source, startFile, statusFile], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code === 0) resolveOutput(stdout);
        else reject(new Error(`claim worker exited ${code}: ${stderr}`));
      });
    }));
    writeFileSync(startFile, "go", "utf-8");

    const results = (await Promise.all(children)).map((output) => JSON.parse(output));
    assert.equal(results.filter((result) => result.claimed).length, 1);
    assert.equal(readTaskStatusFile(statusFile).status, "running");
    assert.equal(existsSync(`${statusFile}.lock`), false);
  });
});
