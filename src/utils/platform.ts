/**
 * Cross-platform abstractions for PatchWarden.
 *
 * Centralizes platform detection, path separators, the platform-specific null
 * device, and a path-containment helper that works correctly on Windows where
 * forward and backward slashes may be mixed. Use these helpers instead of
 * hard-coded Unix assumptions so the runtime guard and change capture behave
 * consistently across Windows and Unix hosts.
 */
import { sep, relative, isAbsolute } from "node:path";

export const isWindows: boolean = process.platform === "win32";

export const pathSep: string = sep;

export const nullDevice: string = isWindows ? "NUL" : "/dev/null";

export function isSamePath(left: string, right: string): boolean {
  return relative(left, right) === "";
}

/**
 * Returns true when `child` is located inside `parent` (or equals it is NOT
 * treated as a child here — callers that need equality should check it
 * separately). Uses `path.relative` so mixed Windows separators are normalized
 * before comparison, unlike `String.prototype.startsWith`.
 */
export function isPathChildOf(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
