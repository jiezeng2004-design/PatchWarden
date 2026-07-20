import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { sep } from "node:path";
import { nullDevice, isWindows, pathSep } from "../../utils/platform.js";

describe("platform null device abstraction", () => {
  it("exposes a nullDevice string", () => {
    assert.equal(typeof nullDevice, "string");
    assert.ok(nullDevice.length > 0);
  });

  it("returns NUL on Windows and /dev/null elsewhere", () => {
    if (isWindows) {
      assert.equal(nullDevice, "NUL");
    } else {
      assert.equal(nullDevice, "/dev/null");
    }
  });

  it("isWindows matches process.platform", () => {
    assert.equal(isWindows, process.platform === "win32");
  });

  it("pathSep matches path.sep", () => {
    assert.equal(pathSep, sep);
  });
});
