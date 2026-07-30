import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { detectRepositoryScope } from "../../../security/repoScopeGuard.js";

let root = "";

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});

describe("repository scope guard", () => {
  it("requires confirmation only for a detected multi-project workspace root", () => {
    root = mkdtempSync(join(tmpdir(), "patchwarden-repo-scope-"));
    for (const name of ["project-a", "project-b"]) {
      mkdirSync(join(root, name), { recursive: true });
      writeFileSync(join(root, name, "package.json"), "{}", "utf8");
    }

    const rootScope = detectRepositoryScope(root, root);
    assert.equal(rootScope.confirmation_required, true);
    assert.deepEqual(rootScope.detected_projects.map((entry) => entry.path), ["project-a", "project-b"]);
    assert.equal(detectRepositoryScope(join(root, "project-a"), root).confirmation_required, false);
  });

  it("allows a single-project workspace root and ignores generated directories", () => {
    root = mkdtempSync(join(tmpdir(), "patchwarden-repo-scope-"));
    writeFileSync(join(root, "package.json"), "{}", "utf8");
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "dist", "package.json"), "{}", "utf8");
    const scope = detectRepositoryScope(root, root);
    assert.equal(scope.confirmation_required, false);
    assert.deepEqual(scope.detected_projects.map((entry) => entry.path), ["."]);
  });
});
