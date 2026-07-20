import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isTrustedControlHostHeader } from "../../../control/middleware/auth.js";

describe("Control Center Host validation", () => {
  it("accepts only the configured loopback origin", () => {
    assert.equal(isTrustedControlHostHeader("127.0.0.1:18090", 18090), true);
    assert.equal(isTrustedControlHostHeader("localhost:18090", 18090), true);
    assert.equal(isTrustedControlHostHeader("LOCALHOST", 18090), true);
    assert.equal(isTrustedControlHostHeader("127.0.0.1", 18090), true);
  });

  it("rejects DNS rebinding names, malformed hosts, and the wrong port", () => {
    for (const value of [
      undefined,
      "patchwarden.example",
      "127.0.0.1.example",
      "localhost.example",
      "localhost@evil.example",
      "127.0.0.1:18091",
      "127.0.0.1:0",
      "127.0.0.1:99999",
    ]) {
      assert.equal(isTrustedControlHostHeader(value, 18090), false, String(value));
    }
  });
});
