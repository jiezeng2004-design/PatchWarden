import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";

export interface AtomicWriteOptions {
  encoding?: BufferEncoding;
  mode?: number;
}

const transientWindowsRenameErrors = new Set(["EACCES", "EBUSY", "EPERM"]);
const renameRetryDeadlineMs = 1_000;
const renameRetryDelayMs = 10;
const waitArray = new Int32Array(new SharedArrayBuffer(4));

/** Replace a file from a complete same-directory temporary file. */
export function atomicWriteFileSync(
  path: string,
  content: string | NodeJS.ArrayBufferView,
  options: AtomicWriteOptions = {},
): void {
  const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temporaryPath, content, {
      encoding: options.encoding ?? "utf-8",
      flag: "wx",
      ...(options.mode === undefined ? {} : { mode: options.mode }),
    });
    const descriptor = openSync(temporaryPath, "r");
    try {
      try {
        fsyncSync(descriptor);
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error
          ? String((error as NodeJS.ErrnoException).code || "")
          : "";
        // Some Windows filesystems and restricted runtimes reject fsync even
        // after a successful complete write. Keep the same-directory atomic
        // rename guarantee there; unexpected I/O errors still fail closed.
        if (!new Set(["EPERM", "EINVAL", "ENOSYS", "ENOTSUP"]).has(code)) throw error;
      }
    } finally {
      closeSync(descriptor);
    }
    replaceFileSync(temporaryPath, path);
  } catch (error) {
    try { rmSync(temporaryPath, { force: true }); } catch { /* best effort */ }
    throw error;
  }
}

function replaceFileSync(temporaryPath: string, path: string): void {
  const deadline = Date.now() + renameRetryDeadlineMs;
  while (true) {
    try {
      renameSync(temporaryPath, path);
      return;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? String((error as NodeJS.ErrnoException).code || "")
        : "";
      if (
        process.platform !== "win32" ||
        !transientWindowsRenameErrors.has(code) ||
        Date.now() >= deadline
      ) {
        throw error;
      }
      Atomics.wait(waitArray, 0, 0, renameRetryDelayMs);
    }
  }
}

export function atomicWriteJsonFileSync(path: string, value: unknown, mode = 0o600): void {
  atomicWriteFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode });
}
