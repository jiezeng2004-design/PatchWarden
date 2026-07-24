import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isDangerousAllowedTestCommand } from "../../../diagnostics/allowedTestCommandSafety.js";

describe("Doctor allowed test command safety", () => {
  it("does not treat npm format:check scripts as the format executable", () => {
    assert.equal(isDangerousAllowedTestCommand("npm run format:check"), false);
    assert.equal(isDangerousAllowedTestCommand("npm.cmd run format:check"), false);
  });

  it("still detects standalone destructive executables", () => {
    assert.equal(isDangerousAllowedTestCommand("format C:"), true);
    assert.equal(isDangerousAllowedTestCommand("format.exe D:"), true);
    assert.equal(isDangerousAllowedTestCommand("cmd /c shutdown.exe /s"), true);
  });
});
