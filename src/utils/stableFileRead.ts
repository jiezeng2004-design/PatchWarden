import { createHash } from "node:crypto";
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  type Stats,
} from "node:fs";

const READ_CHUNK_BYTES = 64 * 1024;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Reads a regular file through a descriptor whose identity is checked before
 * and after reading. This avoids following a path that was changed to a link
 * between inspection and content access on platforms without O_NOFOLLOW.
 */
export function readStableRegularFileSync(
  path: string,
  expected?: Stats,
  maxBytes = DEFAULT_MAX_BYTES,
): Buffer {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error("maxBytes must be a non-negative safe integer.");
  }
  const before = expected ?? lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) {
    throw new Error("Expected a bounded regular file.");
  }

  const descriptor = openSync(path, "r");
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || !sameFileIdentity(before, opened) || opened.size > maxBytes) {
      throw new Error("File identity changed before content could be read.");
    }
    const content = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < content.length) {
      const bytesRead = readSync(
        descriptor,
        content,
        offset,
        Math.min(READ_CHUNK_BYTES, content.length - offset),
        offset,
      );
      if (bytesRead === 0) throw new Error("File ended before its inspected size.");
      offset += bytesRead;
    }
    const afterDescriptor = fstatSync(descriptor);
    const afterPath = lstatSync(path);
    if (
      !afterPath.isFile()
      || afterPath.isSymbolicLink()
      || !sameFileIdentity(before, afterDescriptor)
      || !sameFileIdentity(before, afterPath)
    ) {
      throw new Error("File identity changed while content was being read.");
    }
    return content;
  } finally {
    closeSync(descriptor);
  }
}

export function hashStableRegularFileSync(
  path: string,
  expected?: Stats,
  maxBytes = DEFAULT_MAX_BYTES,
): string {
  return createHash("sha256")
    .update(readStableRegularFileSync(path, expected, maxBytes))
    .digest("hex");
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

