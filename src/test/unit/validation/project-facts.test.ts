import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { validateProjectFacts } from "../../../validation/projectFacts.js";

describe("project facts validation", () => {
  it("warns on unlisted contacts and blocks unconfirmed adoption, license, and forbidden claims", () => {
    const repo = mkdtempSync(join(tmpdir(), "pw-facts-"));
    try {
      mkdirSync(join(repo, ".patchwarden"));
      writeFileSync(join(repo, ".patchwarden", "project-facts.json"), JSON.stringify({
        source: "official-readme",
        brand: { name: "Yistar", email: "official@example.test", github: "https://github.com/example/project" },
        project: { license: "MIT", source: "official-readme" },
        forbidden_claims: ["code never leaves local machine"],
      }), "utf-8");
      writeFileSync(join(repo, "README.md"), [
        "Contact sales@example.test",
        "https://unconfirmed.example.test/path",
        "Trusted by 10,000 users",
        "Licensed under Apache-2.0",
        "code never leaves local machine",
      ].join("\n"), "utf-8");
      const result = validateProjectFacts(repo, [{ path: "README.md", change: "modified" } as any]);
      assert.equal(result.status, "failed");
      assert.equal(result.fact_file, ".patchwarden/project-facts.json");
      assert.equal(result.facts_source, "official-readme");
      assert.ok(result.findings.some((finding) => finding.rule_id === "unconfirmed_contact" && finding.severity === "warn"));
      assert.ok(result.findings.some((finding) => finding.rule_id === "unconfirmed_domain" && finding.severity === "warn"));
      assert.ok(result.findings.some((finding) => finding.rule_id === "unconfirmed_quantitative_or_adoption_claim" && finding.severity === "fail"));
      assert.ok(result.findings.some((finding) => finding.rule_id === "license_claim_mismatch" && finding.severity === "fail"));
      assert.ok(result.findings.some((finding) => finding.rule_id === "forbidden_claim" && finding.severity === "fail"));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("does not invent a failure when no facts file is configured", () => {
    const repo = mkdtempSync(join(tmpdir(), "pw-facts-none-"));
    try {
      const result = validateProjectFacts(repo, []);
      assert.equal(result.status, "not_configured");
      assert.equal(result.errors, 0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
