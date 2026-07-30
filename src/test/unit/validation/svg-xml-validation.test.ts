import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { validateChangedSvgXml } from "../../../validation/svgXmlValidation.js";

describe("SVG/XML validation", () => {
  it("rejects an unescaped ampersand with file, line, and parser reason", () => {
    const repo = mkdtempSync(join(tmpdir(), "pw-svg-bad-"));
    try {
      writeFileSync(join(repo, "bad.svg"), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">\n<text>A & B</text>\n</svg>', "utf-8");
      const result = validateChangedSvgXml(repo, [{ path: "bad.svg", change: "modified" } as any]);
      assert.equal(result.status, "failed");
      const error = result.findings.find((finding) => finding.rule_id === "xml_parse_error")!;
      assert.equal(error.file, "bad.svg");
      assert.ok(error.line >= 2);
      assert.ok(error.reason.length > 0);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  it("accepts escaped entities and valid namespace/viewBox", () => {
    const repo = mkdtempSync(join(tmpdir(), "pw-svg-good-"));
    try {
      writeFileSync(join(repo, "good.svg"), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><text>A &amp; B</text></svg>', "utf-8");
      const result = validateChangedSvgXml(repo, [{ path: "good.svg", change: "added" } as any]);
      assert.equal(result.status, "passed");
      assert.equal(result.parser, "saxes");
      assert.equal(result.browser_cross_check, "runtime_validation");
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  it("rejects duplicate attributes, missing namespaces, invalid viewBox, and missing resources", () => {
    const repo = mkdtempSync(join(tmpdir(), "pw-svg-contract-"));
    try {
      writeFileSync(join(repo, "duplicate.svg"), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" viewBox="0 0 2 2"/>', "utf-8");
      writeFileSync(join(repo, "missing.svg"), '<svg viewBox="0 0 0 10"><image href="missing.png"/></svg>', "utf-8");
      const result = validateChangedSvgXml(repo, [
        { path: "duplicate.svg", change: "added" } as any,
        { path: "missing.svg", change: "added" } as any,
      ]);
      assert.equal(result.status, "failed");
      assert.ok(result.findings.some((finding) => finding.rule_id === "xml_parse_error"));
      assert.ok(result.findings.some((finding) => finding.rule_id === "svg_namespace_invalid"));
      assert.ok(result.findings.some((finding) => finding.rule_id === "svg_viewbox_invalid"));
      assert.ok(result.findings.some((finding) => finding.rule_id === "xml_referenced_resource_missing"));
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
});
