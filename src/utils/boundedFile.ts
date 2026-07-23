import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readSync,
  statSync,
} from "node:fs";
import { atomicWriteFileSync } from "./atomicFile.js";
import { withFileLockSync } from "./lockedJsonFile.js";

const TRUNCATION_MARKER = Buffer.from("[earlier content truncated]\n", "utf-8");

export interface BoundedTextRead {
  content: string;
  totalBytes: number;
  truncated: boolean;
}

export function readTextFilePrefixSync(path: string, maxBytes: number): BoundedTextRead {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("maxBytes must be a positive integer");
  }
  const descriptor = openSync(path, "r");
  try {
    const totalBytes = fstatSync(descriptor).size;
    const length = Math.min(totalBytes, maxBytes);
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const bytesRead = readSync(descriptor, buffer, offset, length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    let content = buffer.subarray(0, offset).toString("utf-8");
    if (totalBytes > offset && content.endsWith("\uFFFD")) content = content.slice(0, -1);
    return { content, totalBytes, truncated: totalBytes > offset };
  } finally {
    closeSync(descriptor);
  }
}

export function readTextFileTailLinesSync(
  path: string,
  lines: number,
  maxBytes = 1024 * 1024,
): string {
  if (!existsSync(path)) return "";
  const boundedLines = Number.isFinite(lines)
    ? Math.max(1, Math.min(1000, Math.trunc(lines)))
    : 100;
  const suffix = readFileSuffix(path, maxBytes);
  let text = suffix.content.toString("utf-8");
  if (suffix.truncated) {
    const firstNewline = text.indexOf("\n");
    if (firstNewline >= 0) text = text.slice(firstNewline + 1);
  }
  const allLines = text.split(/\r?\n/);
  if (allLines.at(-1) === "") allLines.pop();
  return allLines.slice(-boundedLines).join("\n");
}

export function appendBoundedTextFileSync(
  path: string,
  content: string,
  maxBytes = 2 * 1024 * 1024,
): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= TRUNCATION_MARKER.length) {
    throw new Error("maxBytes must exceed the truncation marker size");
  }
  withFileLockSync(path, () => {
    const incoming = Buffer.from(content, "utf-8");
    const existingSize = existsSync(path) ? statSync(path).size : 0;
    if (existingSize + incoming.length <= maxBytes) {
      appendFileSync(path, incoming, { mode: 0o600 });
      return;
    }

    const incomingSuffix = incoming.subarray(Math.max(0, incoming.length - maxBytes + TRUNCATION_MARKER.length));
    const existingBudget = Math.max(
      0,
      maxBytes - TRUNCATION_MARKER.length - incomingSuffix.length,
    );
    const existingSuffix = existingBudget > 0 && existingSize > 0
      ? readFileSuffix(path, existingBudget).content
      : Buffer.alloc(0);
    const output = Buffer.concat([TRUNCATION_MARKER, existingSuffix, incomingSuffix]);
    const mode = existsSync(path) ? statSync(path).mode : 0o600;
    atomicWriteFileSync(path, output, { mode });
  });
}

function readFileSuffix(path: string, maxBytes: number): { content: Buffer; truncated: boolean } {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("maxBytes must be a positive integer");
  }
  const descriptor = openSync(path, "r");
  try {
    const size = fstatSync(descriptor).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const bytesRead = readSync(descriptor, buffer, offset, length - offset, size - length + offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return {
      content: offset === length ? buffer : buffer.subarray(0, offset),
      truncated: size > length,
    };
  } finally {
    closeSync(descriptor);
  }
}
