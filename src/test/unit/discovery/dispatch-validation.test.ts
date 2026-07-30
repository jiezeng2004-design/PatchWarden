import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  parseOptionalTaskTemplate,
  parsePatchOperations,
  parseReleaseStage,
  parseTaskLogFile,
} from "../../../tools/dispatch/validation.js";
import { PatchWardenError } from "../../../errors.js";

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
    assert.throws(() => parsePatchOperations({}), (error: unknown) => {
      if (!(error instanceof PatchWardenError)) return false;
      assert.equal(error.reason, "invalid_patch_operation");
      assert.equal(error.details.failed_operation_index, null);
      assert.equal(error.details.operation_type, null);
      assert.equal(error.details.other_operations_applied, false);
      assert.equal(error.details.batch_atomic, true);
      return true;
    });
    assert.throws(
      () => parsePatchOperations([
        { type: "replace_whole_file", new_text: "valid" },
        { type: "replace_exact", new_text: 42 },
      ]),
      (error: unknown) => {
        if (!(error instanceof PatchWardenError)) return false;
        assert.equal(error.details.failed_operation_index, 1);
        assert.equal(error.details.operation_type, "replace_exact");
        assert.equal(error.details.other_operations_applied, false);
        assert.equal(error.details.batch_atomic, true);
        return true;
      },
    );
    assert.throws(
      () => parsePatchOperations([{ type: "shell", new_text: "x" }]),
      (error: unknown) => error instanceof PatchWardenError
        && error.details.failed_operation_index === 0
        && error.details.operation_type === "shell"
        && error.details.other_operations_applied === false
        && error.details.batch_atomic === true,
    );
  });
});
