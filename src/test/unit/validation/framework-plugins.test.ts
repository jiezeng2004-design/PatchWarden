import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { validateFrameworks } from "../../../validation/frameworkPlugins.js";

describe("framework validation plugins", () => {
  it("detects Next.js and Node.js and emits structured route, output, metadata, and runtime checks", () => {
    const repo = mkdtempSync(join(tmpdir(), "pw-next-plugin-"));
    try {
      mkdirSync(join(repo, "app", "about"), { recursive: true });
      mkdirSync(join(repo, "public"));
      writeFileSync(join(repo, "app", "about", "page.tsx"), "export default function Page(){}", "utf-8");
      writeFileSync(join(repo, "app", "layout.tsx"), "export const metadata = {};", "utf-8");
      writeFileSync(join(repo, "package.json"), JSON.stringify({ dependencies: { next: "15.0.0" }, scripts: { build: "next build", test: "node test.js" } }), "utf-8");
      const result = validateFrameworks(repo);
      assert.equal(result.mode, "framework_plugins");
      assert.deepEqual(result.detected_frameworks, ["nodejs", "nextjs"]);
      const next = result.plugins.find((plugin) => plugin.framework === "nextjs")!;
      assert.ok(next.generated_paths.includes(".next/**"));
      assert.ok(next.recommended_commands.includes("npm run build"));
      assert.match(next.checks.find((check) => check.check === "route_manifest")?.detail || "", /\/about/);
      assert.equal(next.checks.find((check) => check.check === "runtime_console")?.source, "runtimeValidation");
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  it("supports bounded project overrides and falls back safely when detection fails", () => {
    const repo = mkdtempSync(join(tmpdir(), "pw-framework-generic-"));
    try {
      mkdirSync(join(repo, ".patchwarden"));
      writeFileSync(join(repo, ".patchwarden", "framework-validation.json"), JSON.stringify({ plugins: { nextjs: { generated_paths: ["custom-next/**"] } } }), "utf-8");
      const generic = validateFrameworks(repo);
      assert.equal(generic.mode, "generic_fallback");
      assert.deepEqual(generic.detected_frameworks, ["generic"]);

      writeFileSync(join(repo, "package.json"), JSON.stringify({ dependencies: { next: "15" }, scripts: { build: "next build" } }), "utf-8");
      const overridden = validateFrameworks(repo);
      const next = overridden.plugins.find((plugin) => plugin.framework === "nextjs")!;
      assert.deepEqual(next.generated_paths, ["custom-next/**"]);
      assert.equal(next.overrides_applied, true);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
});
