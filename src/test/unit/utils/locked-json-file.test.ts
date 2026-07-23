import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import fs, { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";
import { readJsonObjectFileSync, withFileLock, withFileLockSync } from "../../../utils/lockedJsonFile.js";

describe("locked JSON file", () => {
  let root: string;
  let jsonFile: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "patchwarden-locked-json-"));
    jsonFile = join(root, "state.json");
    writeFileSync(jsonFile, JSON.stringify({ count: 0 }), "utf-8");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("atomically detaches and retries a transient Windows directory removal error", () => {
    const originalRmSync = fs.rmSync;
    let releaseAttempts = 0;
    fs.rmSync = (path, options) => {
      if (String(path).startsWith(`${jsonFile}.lock.release-`) && releaseAttempts++ === 0) {
        assert.equal(existsSync(`${jsonFile}.lock`), false);
        const error = new Error("synthetic transient lock release failure") as NodeJS.ErrnoException;
        error.code = "ENOTEMPTY";
        throw error;
      }
      originalRmSync(path, options);
    };
    syncBuiltinESMExports();

    try {
      withFileLockSync(jsonFile, () => {
        assert.equal(existsSync(`${jsonFile}.lock`), true);
      });
    } finally {
      fs.rmSync = originalRmSync;
      syncBuiltinESMExports();
    }

    assert.equal(releaseAttempts, 2);
    assert.equal(existsSync(`${jsonFile}.lock`), false);
    assert.deepEqual(readdirSync(root).filter((name) => name.includes(".release-")), []);
  });

  it("uses an atomic lock directory and recovers crash and legacy lock formats", () => {
    withFileLockSync(jsonFile, () => {
      assert.equal(statSync(`${jsonFile}.lock`).isDirectory(), true);
      assert.equal(existsSync(`${jsonFile}.lock/owner.json`), true);
    });

    mkdirSync(`${jsonFile}.lock`);
    withFileLockSync(jsonFile, () => undefined, { corruptLockStaleMs: 0 });
    assert.equal(existsSync(`${jsonFile}.lock`), false);

    writeFileSync(`${jsonFile}.lock`, "{", "utf-8");
    withFileLockSync(jsonFile, () => undefined, { corruptLockStaleMs: 0 });
    assert.equal(existsSync(`${jsonFile}.lock`), false);
  });

  it("fails closed by the deadline when lock creation stays access-denied", () => {
    const originalMkdirSync = fs.mkdirSync;
    fs.mkdirSync = (path, options) => {
      if (String(path) === `${jsonFile}.lock`) {
        const error = new Error("synthetic persistent lock creation denial") as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      }
      return originalMkdirSync(path, options);
    };
    syncBuiltinESMExports();

    try {
      assert.throws(
        () => withFileLockSync(jsonFile, () => undefined, {
          waitMs: 0,
          busyError: () => new Error("synthetic_busy"),
        }),
        /synthetic_busy/,
      );
    } finally {
      fs.mkdirSync = originalMkdirSync;
      syncBuiltinESMExports();
    }
    assert.equal(existsSync(`${jsonFile}.lock`), false);
  });

  it("does not block the event loop when async callers contend", { timeout: 5_000 }, async () => {
    const first = withFileLock(jsonFile, async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 40));
      return "first";
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
    const second = withFileLock(jsonFile, async () => "second", { waitMs: 1_000 });

    assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
    assert.equal(existsSync(`${jsonFile}.lock`), false);
  });

  it("preserves every concurrent cross-process mutation", { timeout: 10_000 }, async () => {
    const modulePath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../../utils/lockedJsonFile.js",
    );
    const startFile = join(root, "start");
    const source = [
      `const fs = await import("node:fs");`,
      `const timers = await import("node:timers/promises");`,
      `const store = await import(${JSON.stringify(pathToFileURL(modulePath).href)});`,
      `while (!fs.existsSync(process.argv[1])) await timers.setTimeout(5);`,
      `store.mutateLockedJsonFileSync(process.argv[2], (current) => {`,
      `  const next = { ...current, count: Number(current.count || 0) + 1 };`,
      `  return { next, result: null };`,
      `});`,
    ].join("\n");

    const children = Array.from({ length: 8 }, () => new Promise<void>((resolveChild, rejectChild) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", source, startFile, jsonFile], {
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.once("error", rejectChild);
      child.once("exit", (code) => {
        if (code === 0) resolveChild();
        else rejectChild(new Error(`mutation worker exited ${code}: ${stderr}`));
      });
    }));
    writeFileSync(startFile, "go", "utf-8");
    await Promise.all(children);

    assert.equal(readJsonObjectFileSync<{ count: number }>(jsonFile).count, children.length);
    assert.equal(existsSync(`${jsonFile}.lock`), false);
    assert.deepEqual(readdirSync(root).filter((name) => name.includes(".tmp")), []);
  });
});
