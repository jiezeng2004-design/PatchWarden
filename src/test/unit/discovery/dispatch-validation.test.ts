import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  parseOptionalTaskTemplate,
  parsePatchOperations,
  parseReleaseStage,
  parseTaskLogFile,
} from "../../../tools/dispatch/validation.js";

describe("dispatch input validation", () => {
  it("validates bounded string enums", () => {
    assert.equal(parseOptionalTaskTemplate("feature_small"), "feature_small");
    assert.equal(parseOptionalTaskTemplate(undefined), undefined);
    assert.throws(() => parseOptionalTaskTemplate("unknown"), /template must be one of/);
    assert.equal(parseReleaseStage(undefined), "local_ready");
    assert.equal(parseReleaseStage("ci_verified"), "ci_verified");
    assert.throws(() => parseReleaseStage("publish_now"), /target_stage must be one of/);
    assert.equal(parseTaskLogFile(undefined), "stdout");
    assert.equal(parseTaskLogFile("verify"), "verify");
    assert.throws(() => parseTaskLogFile("secrets"), /file must be one of/);
  });

  it("accepts well-formed Direct operations and rejects structural mismatches", () => {
    assert.deepEqual(parsePatchOperations([{
      type: "replace_exact",
      old_text: "before",
      new_text: "after",
      occurrence: "exactly_once",
    }]), [{
      type: "replace_exact",
      old_text: "before",
      new_text: "after",
      occurrence: "exactly_once",
    }]);
    assert.throws(() => parsePatchOperations({}), /operations must be an array/);
    assert.throws(
      () => parsePatchOperations([{ type: "replace_exact", new_text: 42 }]),
      /new_text must be a string/,
    );
    assert.throws(
      () => parsePatchOperations([{ type: "shell", new_text: "x" }]),
      /type is invalid/,
    );
  });
});
