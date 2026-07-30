import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { deriveCompletionState } from "../../../runner/completionState.js";

describe("completion state", () => {
  it("separates implementation, static checks, runtime checks, review readiness, and acceptance", () => {
    assert.deepEqual(deriveCompletionState({
      status: "done_by_agent",
      verify_status: "passed",
      runtime_validation: { status: "passed" },
      manual_scope_review_required: false,
      acceptance_status: "pending",
    }), {
      implementation_complete: true,
      static_verification_complete: true,
      runtime_validation_required: true,
      runtime_validation_complete: true,
      manual_review_required: false,
      user_acceptance_ready: true,
      accepted: false,
    });

    const review = deriveCompletionState({
      status: "done_by_agent",
      verify_status: "passed",
      manual_scope_review_required: true,
    });
    assert.equal(review.implementation_complete, true);
    assert.equal(review.user_acceptance_ready, false);
    assert.equal(review.manual_review_required, true);

    const accepted = deriveCompletionState({ status: "accepted", verify_status: "passed", acceptance_status: "accepted" });
    assert.equal(accepted.accepted, true);
    assert.equal(accepted.runtime_validation_required, false);
    assert.equal(accepted.runtime_validation_complete, false);
    assert.equal(accepted.manual_review_required, true);
    assert.equal(accepted.user_acceptance_ready, false);
  });
});
