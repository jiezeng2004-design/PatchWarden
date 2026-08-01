import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { resolve } from "node:path";
import {
  collectExactProxyValues,
  redactDiagnosticTail,
  redactExactValues,
  sanitizedProcessFailure,
} from "../../scripts/checks/package-install-smoke.js";

const root = resolve(import.meta.dirname, "..", "..");
function read(relativePath) {
  return readFileSync(resolve(root, relativePath), "utf8");
}

describe("release gate contracts", () => {
  it("keeps isolated package installation cache-first, bounded, and lifecycle-free", () => {
    const smoke = read("scripts/checks/package-install-smoke.js");
    assert.doesNotMatch(smoke, /buildChildEnvironment/);
    assert.match(smoke, /--prefer-offline/);
    assert.match(smoke, /--fetch-retries=0/);
    assert.match(smoke, /--fetch-timeout=15000/);
    assert.match(smoke, /NPM_STEP_TIMEOUT_MS = 90_000/);
    assert.match(smoke, /timeoutMs: NPM_STEP_TIMEOUT_MS/);
    assert.match(smoke, /\["pack", "--ignore-scripts"/);
    assert.match(smoke, /\["install", "--ignore-scripts", archive\]/);
  });

  it("redacts only explicit proxy values of sufficient length before failure formatting", () => {
    const hostname = `${randomBytes(8).toString("hex")}.invalid`;
    const host = `${hostname}:18080`;
    const origin = `http://${host}`;
    const exactValue = ["http://", randomBytes(8).toString("hex"), ":", randomBytes(8).toString("hex"), "@", host].join("");
    const unrelatedValue = randomBytes(16).toString("hex");
    const collected = collectExactProxyValues({ HTTPS_PROXY: exactValue, UNRELATED_VALUE: unrelatedValue, HTTP_PROXY: "short" });
    for (const variant of [exactValue, `${exactValue}/`, origin, `${origin}/`, host, hostname]) {
      assert.equal(collected.includes(variant), true);
      assert.equal(redactExactValues(["before", variant, "after"].join(" "), collected).includes(variant), false);
    }
    assert.equal(collected.some((value) => value.includes(unrelatedValue)), false);

    const exactRedacted = redactExactValues(["before", exactValue, exactValue, "after"].join(" "), collected);
    assert.equal(exactRedacted.includes(exactValue), false);
    assert.equal((exactRedacted.match(/<redacted-exact-value>/g) || []).length, 2);

    for (const result of [
      { stderr: ["npm stderr", exactValue, "failed"].join(" ") },
      { stdout: ["npm stdout", exactValue, "failed"].join(" ") },
      { error: { message: ["npm error", exactValue, "failed"].join(" ") } },
    ]) {
      const safeFailure = sanitizedProcessFailure(result, collected);
      assert.equal(safeFailure.includes(exactValue), false);
      assert.match(safeFailure, /<redacted-exact-value>/);
    }

    const schemeless = `${randomBytes(8).toString("hex")}.invalid:28080`;
    const schemelessVariants = collectExactProxyValues({ HTTP_PROXY: schemeless });
    for (const variant of [schemeless, `${schemeless}/`, `http://${schemeless}`, `http://${schemeless}/`]) {
      assert.equal(schemelessVariants.includes(variant), true);
    }
  });

  it("applies exact replacement before pattern redaction and truncation", () => {
    const exactValue = ["https://", randomBytes(8).toString("hex"), ":", randomBytes(8).toString("hex"), "@proxy.invalid:9443"].join("");
    const patternedValue = ["https://", randomBytes(8).toString("hex"), ":", randomBytes(8).toString("hex"), "@fallback.invalid:9443"].join("");
    const redacted = redactDiagnosticTail([exactValue, patternedValue].join("\n"), [exactValue], 4096);
    assert.equal(redacted.includes(exactValue), false);
    assert.equal(redacted.includes(patternedValue), false);
    assert.match(redacted, /https:\/\/<redacted>@fallback\.invalid:9443/);

    const output = redactDiagnosticTail([exactValue, "tail".repeat(64)].join("\n"), [exactValue], 160);
    assert.equal(output.includes(exactValue), false);
    assert.match(output, /^\[truncated to final 160 chars\]/);
  });

  it("wires the tested redaction path into package failures and Desktop receipts", () => {
    const smoke = read("scripts/checks/package-install-smoke.js");
    const preflight = read("scripts/release/desktop-preflight.js");
    assert.match(smoke, /const exactValues = collectExactProxyValues\(process\.env\)/);
    assert.match(smoke, /const safeFailure = sanitizedProcessFailure\(result, exactValues/);
    assert.match(preflight, /const exactRedactionValues = collectExactProxyValues\(process\.env\)/);
    assert.match(preflight, /redactDiagnosticTail\(value, exactRedactionValues, MAX_FAILURE_DIAGNOSTIC_CHARS\)/);
    assert.match(preflight, /stdout_tail/);
    assert.match(preflight, /stderr_tail/);
    assert.match(preflight, /failure diagnostics were saved in preflight-report\.json/);
    assert.match(preflight, /\["run", "verify:package:built"\]/);
    assert.match(preflight, /\["--prefix", "desktop", "run", "stage"\]/);
  });
});
