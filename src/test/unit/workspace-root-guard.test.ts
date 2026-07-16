import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { unsafeWorkspaceRootLabel, validateWorkspaceRoot } from "../../security/workspaceRootGuard.js";

describe("workspaceRootGuard", () => {
  it("rejects Windows drive roots and common broad folders", () => {
    assert.equal(unsafeWorkspaceRootLabel("C:\\", "C:\\Users\\student"), "drive root");
    assert.equal(unsafeWorkspaceRootLabel("C:\\Users\\student", "C:\\Users\\student"), "user home directory");
    assert.equal(unsafeWorkspaceRootLabel("C:\\Users\\student\\Desktop", "C:\\Users\\student"), "Desktop");
    assert.equal(unsafeWorkspaceRootLabel("C:\\Users\\student\\Downloads", "C:\\Users\\student"), "Downloads");
    assert.equal(unsafeWorkspaceRootLabel("C:\\Users\\student\\Documents", "C:\\Users\\student"), "Documents");
    assert.equal(unsafeWorkspaceRootLabel("\\\\server\\share\\Desktop", "C:\\Users\\student"), "Desktop");
    assert.equal(unsafeWorkspaceRootLabel("/home/student/Downloads", "/home/student"), "Downloads");
    assert.equal(unsafeWorkspaceRootLabel("/work/project", "/home/student"), null);
  });

  it("accepts an existing project directory", () => {
    const root = mkdtempSync(join(tmpdir(), "patchwarden-workspace-"));
    const result = validateWorkspaceRoot(root);
    assert.equal(result.ok, true);
    assert.equal(result.category, "valid");
  });

  it("rejects files and missing directories", () => {
    const root = mkdtempSync(join(tmpdir(), "patchwarden-root-"));
    const file = join(root, "not-a-directory.txt");
    writeFileSync(file, "test", "utf8");
    assert.equal(validateWorkspaceRoot(file).category, "not_directory");
    assert.equal(validateWorkspaceRoot(join(root, "missing")).category, "missing");
  });
});
