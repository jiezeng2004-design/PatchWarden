import { strict as assert } from "node:assert";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  appendBoundedTextFileSync,
  readTextFilePrefixSync,
  readTextFileTailLinesSync,
} from "../../../utils/boundedFile.js";

describe("bounded file utilities", () => {
  let root: string | undefined;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it("reads only a bounded suffix while returning the requested final lines", () => {
    root = mkdtempSync(join(tmpdir(), "patchwarden-bounded-tail-"));
    const path = join(root, "large.log");
    writeFileSync(path, `${"old line\n".repeat(200_000)}final-a\nfinal-b\n`, "utf-8");

    assert.equal(readTextFileTailLinesSync(path, 2, 1024), "final-a\nfinal-b");
  });

  it("returns a byte-bounded prefix without loading the rest of the file", () => {
    root = mkdtempSync(join(tmpdir(), "patchwarden-bounded-prefix-"));
    const path = join(root, "large.patch");
    writeFileSync(path, `prefix-${"x".repeat(10_000)}`, "utf-8");

    const result = readTextFilePrefixSync(path, 64);
    assert.equal(result.content, `prefix-${"x".repeat(57)}`);
    assert.equal(result.totalBytes, 10_007);
    assert.equal(result.truncated, true);
  });

  it("serializes bounded appends and retains the newest evidence", () => {
    root = mkdtempSync(join(tmpdir(), "patchwarden-bounded-append-"));
    const path = join(root, "events.log");
    writeFileSync(path, "old\n".repeat(100), "utf-8");

    appendBoundedTextFileSync(path, `${"middle\n".repeat(30)}latest-event\n`, 256);

    assert.ok(statSync(path).size <= 256);
    const content = readFileSync(path, "utf-8");
    assert.match(content, /^\[earlier content truncated\]\n/);
    assert.match(content, /latest-event\n$/);
    assert.equal(existsSync(`${path}.lock`), false);
    assert.deepEqual(readdirSync(root).filter((name) => name.endsWith(".tmp")), []);
  });
});
