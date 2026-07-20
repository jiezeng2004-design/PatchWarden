import { strict as assert } from "node:assert";
import fs, { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { atomicWriteFileSync } from "../../../utils/atomicFile.js";

describe("atomic file replacement", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "patchwarden-atomic-file-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("retries a transient Windows rename denial without deleting the destination", () => {
    const destination = join(root, "state.json");
    const originalRenameSync = fs.renameSync;
    let attempts = 0;
    fs.renameSync = (oldPath, newPath) => {
      if (process.platform === "win32" && attempts++ === 0) {
        const error = new Error("synthetic transient rename denial") as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      }
      originalRenameSync(oldPath, newPath);
    };
    syncBuiltinESMExports();

    try {
      atomicWriteFileSync(destination, "complete\n");
    } finally {
      fs.renameSync = originalRenameSync;
      syncBuiltinESMExports();
    }

    assert.equal(readFileSync(destination, "utf-8"), "complete\n");
    assert.equal(attempts, process.platform === "win32" ? 2 : 0);
  });
});
