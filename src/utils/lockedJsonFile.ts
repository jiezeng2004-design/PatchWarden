import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJsonFileSync } from "./atomicFile.js";

export interface LockedJsonMutation<T extends object, R> {
  next?: T;
  result: R;
}

export interface LockedJsonOptions {
  waitMs?: number;
  corruptLockStaleMs?: number;
  busyError?: () => Error;
}

const waitArray = new Int32Array(new SharedArrayBuffer(4));
const lockReleaseRetryCodes = new Set(["EACCES", "EBUSY", "EPERM"]);
const lockReleaseRetryMs = 1_000;
const lockReleaseRetryDelayMs = 10;
const deadOwnerGraceMs = 250;
const lockOwnerFile = "owner.json";

interface AcquiredLock {
  path: string;
  owner: string;
}

interface LockRecord {
  owner?: string;
  pid?: number;
}

export function readJsonObjectFileSync<T extends object>(path: string): T {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Expected a JSON object in ${path}`);
  }
  return parsed as T;
}

export function mutateLockedJsonFileSync<T extends object, R>(
  path: string,
  mutation: (current: T) => LockedJsonMutation<T, R>,
  options: LockedJsonOptions = {},
): R {
  return withFileLockSync(path, () => {
    const current = readJsonObjectFileSync<T>(path);
    const outcome = mutation(current);
    if (outcome.next) atomicWriteJsonFileSync(path, outcome.next);
    return outcome.result;
  }, options);
}

/** Serialize an arbitrary same-file read/modify/write sequence across processes. */
export function withFileLockSync<R>(
  path: string,
  action: () => R,
  options: LockedJsonOptions = {},
): R {
  const lock = acquireLock(path, options);
  try {
    return action();
  } finally {
    releaseLock(lock.path, lock.owner);
  }
}

/** Hold the same cross-process lock for the lifetime of an async operation. */
export async function withFileLock<R>(
  path: string,
  action: () => Promise<R>,
  options: LockedJsonOptions = {},
): Promise<R> {
  // Async callers must not use the synchronous Atomics.wait loop: a second
  // request in the same Node event loop would otherwise block the first
  // request from finishing its awaited mutation and releasing the lock.
  const lock = await acquireLockAsync(path, options);
  try {
    return await action();
  } finally {
    releaseLock(lock.path, lock.owner);
  }
}

async function acquireLockAsync(path: string, options: LockedJsonOptions): Promise<AcquiredLock> {
  const lockPath = `${path}.lock`;
  const owner = `${process.pid}-${randomBytes(8).toString("hex")}`;

  const deadline = Date.now() + (options.waitMs ?? 2000);
  while (true) {
    if (tryCreateLock(lockPath, owner)) return { path: lockPath, owner };
    if (
      removeStaleLock(lockPath, options.corruptLockStaleMs ?? 30_000) &&
      tryCreateLock(lockPath, owner)
    ) {
      return { path: lockPath, owner };
    }
    if (Date.now() >= deadline) {
      throw options.busyError?.() ?? new Error(`JSON file is busy: ${path}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, lockReleaseRetryDelayMs));
  }
}

function acquireLock(path: string, options: LockedJsonOptions): AcquiredLock {
  const lockPath = `${path}.lock`;
  const owner = `${process.pid}-${randomBytes(8).toString("hex")}`;

  const deadline = Date.now() + (options.waitMs ?? 2000);
  while (true) {
    if (tryCreateLock(lockPath, owner)) return { path: lockPath, owner };
    if (
      removeStaleLock(lockPath, options.corruptLockStaleMs ?? 30_000) &&
      tryCreateLock(lockPath, owner)
    ) {
      return { path: lockPath, owner };
    }
    if (Date.now() >= deadline) {
      throw options.busyError?.() ?? new Error(`JSON file is busy: ${path}`);
    }
    Atomics.wait(waitArray, 0, 0, lockReleaseRetryDelayMs);
  }
}

function tryCreateLock(lockPath: string, owner: string): boolean {
  try {
    mkdirSync(lockPath, { mode: 0o700 });
  } catch (error) {
    const code = errorCode(error);
    if (code === "EEXIST" || lockReleaseRetryCodes.has(code || "")) return false;
    throw error;
  }

  try {
    writeFileSync(join(lockPath, lockOwnerFile), JSON.stringify({
      owner,
      pid: process.pid,
      created_at: new Date().toISOString(),
    }), { encoding: "utf-8", flag: "wx", mode: 0o600 });
    return true;
  } catch (error) {
    try { rmSync(lockPath, { recursive: true, force: true }); } catch { /* leave fail-closed */ }
    throw error;
  }
}

function releaseLock(lockPath: string, owner: string): void {
  const deadline = Date.now() + lockReleaseRetryMs;
  let removalStarted = false;
  while (true) {
    if (!removalStarted) {
      const currentOwner = readLock(lockPath)?.owner;
      if (currentOwner !== owner) {
        if (!existsSync(lockPath)) return;
        if (currentOwner !== undefined) return;
        if (Date.now() >= deadline) {
          throw new Error(`Unable to verify lock ownership before release: ${lockPath}`);
        }
        Atomics.wait(waitArray, 0, 0, lockReleaseRetryDelayMs);
        continue;
      }
    }
    try {
      rmSync(lockPath, { recursive: true, force: false });
      return;
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT") return;
      if (!code || !lockReleaseRetryCodes.has(code) || Date.now() >= deadline) throw error;
      removalStarted = true;
      Atomics.wait(waitArray, 0, 0, lockReleaseRetryDelayMs);
    }
  }
}

function removeStaleLock(lockPath: string, corruptLockStaleMs: number): boolean {
  const lock = readLock(lockPath);
  let ageMs: number;
  try {
    ageMs = Date.now() - statSync(lockPath).mtimeMs;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return true;
    throw error;
  }
  const stale = typeof lock?.pid === "number"
    ? !processIsAlive(lock.pid) && ageMs >= deadOwnerGraceMs
    : ageMs >= corruptLockStaleMs;
  if (!stale) return false;

  // Re-read immediately before removal so one stale-lock contender cannot
  // delete a replacement acquired after its first observation.
  const latest = readLock(lockPath);
  if (lock?.owner) {
    if (latest?.owner !== lock.owner || latest.pid !== lock.pid) return false;
  } else if (latest) {
    return false;
  }
  try {
    rmSync(lockPath, { recursive: true, force: false });
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return true;
    if (lockReleaseRetryCodes.has(errorCode(error) || "")) return false;
    throw error;
  }
}

function readLock(path: string): LockRecord | null {
  try {
    const metadata = statSync(path);
    const recordPath = metadata.isDirectory() ? join(path, lockOwnerFile) : path;
    return readJsonObjectFileSync<LockRecord>(recordPath);
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Only ESRCH proves the process does not exist. Access-denied and unknown
    // platform errors must keep the lock fail-closed.
    return errorCode(error) !== "ESRCH";
  }
}

function errorCode(error: unknown): string | null {
  return error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code || "")
    : null;
}
