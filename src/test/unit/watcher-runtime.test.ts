import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { strict as assert } from "node:assert";
import { it } from "node:test";

const watcherPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../runner/watch.js");

async function waitUntil(check: () => boolean, timeoutMs: number, message: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(25);
  }
  throw new Error(message);
}

async function waitForExit(child: ChildProcess, timeoutMs = 3000): Promise<void> {
  if (child.exitCode !== null) return;
  await Promise.race([
    new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())),
    sleep(timeoutMs).then(() => { throw new Error("watcher did not exit in time"); }),
  ]);
}

it("keeps an idle watcher alive, rejects a duplicate, and recovers a stale lock", { timeout: 12_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "pw-watcher-runtime-"));
  const configPath = join(root, "patchwarden.config.json");
  const heartbeatPath = join(root, ".patchwarden", "watcher-heartbeat.json");
  writeFileSync(configPath, JSON.stringify({
    workspaceRoot: root,
    plansDir: ".patchwarden/plans",
    tasksDir: ".patchwarden/tasks",
    agents: {},
    allowedTestCommands: [],
  }), "utf-8");

  const children: ChildProcess[] = [];
  const errors = new Map<ChildProcess, string>();
  const start = (instanceId: string): ChildProcess => {
    const child = spawn(process.execPath, [watcherPath], {
      cwd: root,
      env: {
        ...process.env,
        PATCHWARDEN_CONFIG: configPath,
        PATCHWARDEN_WATCHER_INSTANCE_ID: instanceId,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    errors.set(child, "");
    child.stderr?.on("data", (chunk) => errors.set(child, `${errors.get(child)}${String(chunk)}`));
    children.push(child);
    return child;
  };

  try {
    const first = start("runtime-test-first");
    await waitUntil(
      () => existsSync(heartbeatPath),
      3000,
      `watcher did not create a heartbeat: ${errors.get(first)}`,
    );
    await sleep(300);
    assert.equal(first.exitCode, null, `idle watcher exited early: ${errors.get(first)}`);

    const duplicate = start("runtime-test-duplicate");
    await waitForExit(duplicate);
    assert.equal(duplicate.exitCode, 1, `duplicate watcher was not rejected: ${errors.get(duplicate)}`);
    assert.equal(first.exitCode, null, "duplicate startup disturbed the lock owner");

    first.kill("SIGTERM");
    await waitForExit(first);

    const replacement = start("runtime-test-replacement");
    await waitUntil(() => {
      try {
        return JSON.parse(readFileSync(heartbeatPath, "utf-8")).instance_id === "runtime-test-replacement";
      } catch {
        return false;
      }
    }, 3000, `replacement watcher did not take over the stale lock: ${errors.get(replacement)}`);
    await sleep(300);
    assert.equal(replacement.exitCode, null, `replacement watcher exited early: ${errors.get(replacement)}`);
  } finally {
    for (const child of children) {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    await Promise.all(children.map((child) => waitForExit(child).catch(() => undefined)));
    rmSync(root, { recursive: true, force: true });
  }
});
