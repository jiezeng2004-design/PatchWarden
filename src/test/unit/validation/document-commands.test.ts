import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { extractActionableNpmScriptNames, extractDocumentCommandEvidence } from "../../../validation/documentCommands.js";

describe("document command evidence", () => {
  it("preserves complete npm commands and exact script names with source locations", () => {
    const input = [
      "## Usage",
      "```powershell",
      "npm.cmd run typecheck -- --pretty false",
      "```",
      "Run `npm run build -- --profile` before release.",
    ].join("\n");
    const evidence = extractDocumentCommandEvidence(input);
    assert.equal(evidence[0].command, "npm.cmd run typecheck -- --pretty false");
    assert.equal(evidence[0].script_name, "typecheck");
    assert.equal(evidence[0].source_type, "code_block");
    assert.equal(evidence[0].line, 3);
    assert.equal(evidence[1].command, "npm run build -- --profile");
    assert.deepEqual(extractActionableNpmScriptNames(input), ["typecheck", "build"]);
  });

  it("classifies examples and narrative mentions without turning them into blocking scripts", () => {
    const input = [
      "## Example",
      "```sh",
      "npm run nonexistent -- --demo",
      "```",
      "This historical note discusses npm run removed but does not instruct execution.",
      "npm run lint -- --fix=false",
    ].join("\n");
    const evidence = extractDocumentCommandEvidence(input);
    assert.equal(evidence[0].classification, "example");
    assert.equal(evidence[1].source_type, "narrative_example");
    assert.equal(evidence[1].classification, "example");
    assert.equal(evidence[2].classification, "documented_command");
    assert.deepEqual(extractActionableNpmScriptNames(input), ["lint"]);
  });
});
