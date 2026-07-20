import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  firstHeaderValue,
  timingSafeStringEqual,
} from "../../../security/secretComparison.js";

describe("secret comparison", () => {
  it("accepts only byte-identical strings", () => {
    assert.equal(timingSafeStringEqual("owner-token", "owner-token"), true);
    assert.equal(timingSafeStringEqual("owner-tokeN", "owner-token"), false);
    assert.equal(timingSafeStringEqual("short", "owner-token"), false);
    assert.equal(timingSafeStringEqual("令牌", "令牌"), true);
  });

  it("normalizes scalar, repeated, and missing HTTP headers", () => {
    assert.equal(firstHeaderValue("one"), "one");
    assert.equal(firstHeaderValue(["one", "two"]), "one");
    assert.equal(firstHeaderValue([]), "");
    assert.equal(firstHeaderValue(undefined), "");
  });
});
