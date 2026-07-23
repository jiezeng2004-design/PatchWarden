import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { guardRuntimeSelfModification } from "../../security/runtimeGuard.js";
import { PatchWardenError } from "../../errors.js";

// Compiled test lives at dist/test/unit/runtime-guard-windows.test.js, so
// walking up three levels lands on the active package root.
const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("guardRuntimeSelfModification (cross-platform)", () => {
  it("blocks the runtime root itself", () => {
    assert.throws(
      () => guardRuntimeSelfModification(runtimeRoot),
      (err: unknown) =>
        err instanceof PatchWardenError &&
        err.reason === "runtime_self_modification_blocked"
    );
  });

  it("blocks case-variant runtime paths on Windows", { skip: process.platform !== "win32" }, () => {
    assert.throws(
      () => guardRuntimeSelfModification(runtimeRoot.toUpperCase()),
      (err: unknown) =>
        err instanceof PatchWardenError &&
        err.reason === "runtime_self_modification_blocked"
    );
  });

  it("blocks the src subdirectory", () => {
    const target = join(runtimeRoot, "src");
    assert.throws(
      () => guardRuntimeSelfModification(target),
      (err: unknown) =>
        err instanceof PatchWardenError &&
        err.reason === "runtime_self_modification_blocked"
    );
  });

  it("blocks the dist subdirectory", () => {
    const target = join(runtimeRoot, "dist");
    assert.throws(
      () => guardRuntimeSelfModification(target),
      (err: unknown) =>
        err instanceof PatchWardenError &&
        err.reason === "runtime_self_modification_blocked"
    );
  });

  it("blocks the scripts subdirectory", () => {
    const target = join(runtimeRoot, "scripts");
    assert.throws(
      () => guardRuntimeSelfModification(target),
      (err: unknown) =>
        err instanceof PatchWardenError &&
        err.reason === "runtime_self_modification_blocked"
    );
  });

  it("blocks the release subdirectory", () => {
    const target = join(runtimeRoot, "release");
    assert.throws(
      () => guardRuntimeSelfModification(target),
      (err: unknown) =>
        err instanceof PatchWardenError &&
        err.reason === "runtime_self_modification_blocked"
    );
  });

  it("allows unrelated paths such as tmpdir", () => {
    assert.doesNotThrow(() => guardRuntimeSelfModification(tmpdir()));
  });

  it("blocks nested paths inside src using platform join (no hardcoded separator)", () => {
    const target = join(runtimeRoot, "src", "security", "runtimeGuard.ts");
    assert.throws(
      () => guardRuntimeSelfModification(target),
      (err: unknown) =>
        err instanceof PatchWardenError &&
        err.reason === "runtime_self_modification_blocked"
    );
  });

  it("allows a non-critical subdirectory under runtimeRoot", () => {
    const target = join(runtimeRoot, "node_modules");
    assert.doesNotThrow(() => guardRuntimeSelfModification(target));
  });

  it("allows a sibling whose name merely shares the runtime prefix", () => {
    assert.doesNotThrow(() => guardRuntimeSelfModification(`${runtimeRoot}-copy`));
  });
});
