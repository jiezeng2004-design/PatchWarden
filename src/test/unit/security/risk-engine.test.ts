import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { buildRiskRuleEvidence } from "../../../security/riskEngine.js";

describe("risk rule evidence", () => {
  it("uses bounded redacted matched text and keeps the six-field contract", () => {
    const [rule] = buildRiskRuleEvidence(
      "high",
      "blocked",
      [],
      ["test_command_not_allowlisted"],
      { test_command_not_allowlisted: "npm run verify -- --api-key=super-secret-value\nnext" },
    );

    assert.deepEqual(Object.keys(rule).sort(), [
      "blocked_capability",
      "confirmation_supported",
      "risk_level",
      "rule_id",
      "safe_alternative",
      "trigger_text",
    ]);
    assert.equal(rule.rule_id, "test_command_not_allowlisted");
    assert.equal(rule.risk_level, "high");
    assert.equal(rule.confirmation_supported, false);
    assert.match(rule.trigger_text, /npm run verify/);
    assert.doesNotMatch(rule.trigger_text, /super-secret-value/);
    assert.ok(rule.trigger_text.length <= 160);
  });
});
