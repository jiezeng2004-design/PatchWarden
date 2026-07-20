import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  countRedactionsByCategory,
  redactSensitiveContent,
} from "../../../security/contentRedaction.js";

describe("content redaction token formats", () => {
  it("redacts common provider token shapes without storing real credentials in fixtures", () => {
    const values = [
      `s${"k-"}${"o".repeat(24)}`,
      `s${"k-proj-"}${"p".repeat(24)}`,
      `s${"k-ant-"}${"q".repeat(24)}`,
      `gh${"p_"}${"g".repeat(20)}`,
      `gl${"pat-"}${"a".repeat(20)}`,
      `xox${"b-"}${"1".repeat(20)}`,
      `h${"f_"}${"h".repeat(20)}`,
      `np${"m_"}${"n".repeat(20)}`,
      `${"AK"}${"IA"}${"A".repeat(16)}`,
      `${"AI"}${"za"}${"B".repeat(35)}`,
      `eyJ${"a".repeat(12)}.${"b".repeat(12)}.${"c".repeat(12)}`,
    ];
    const input = values.join("\n");
    const result = redactSensitiveContent(input);

    assert.equal(result.redacted, true);
    assert.deepEqual(result.redaction_categories, ["known_token_format"]);
    for (const value of values) assert.ok(!result.content.includes(value));

    const counts = countRedactionsByCategory(input);
    assert.deepEqual(counts.map(({ category, count }) => ({ category, count })), [
      { category: "known_token_format", count: values.length },
    ]);
  });

  it("redacts provider-prefixed credential assignments", () => {
    const values = ["o".repeat(24), "c".repeat(24), "a".repeat(40)];
    const input = [
      `OPENAI_API_KEY=${values[0]}`,
      `CONTROL_PLANE_API_KEY: ${values[1]}`,
      `AWS_SECRET_ACCESS_KEY='${values[2]}'`,
    ].join("\n");
    const result = redactSensitiveContent(input);

    assert.equal(result.redacted, true);
    assert.deepEqual(result.redaction_categories, ["credential_assignment"]);
    for (const value of values) assert.ok(!result.content.includes(value));
  });

  it("does not redact short prefixes or ordinary tokenizer text", () => {
    const input = "glpat-short tokenizer.ts slack-like xoxb-short";
    assert.deepEqual(redactSensitiveContent(input), {
      content: input,
      redacted: false,
      redaction_categories: [],
    });
  });
});
