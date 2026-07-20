import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, normalize, resolve, win32 } from "node:path";

export interface WorkspaceRootValidation {
  ok: boolean;
  path: string;
  reason: string | null;
  category: "valid" | "missing" | "not_directory" | "unsafe_root";
}

function normalizeInput(value: string): string {
  return /^[a-z]:[\\/]/i.test(value) ? win32.normalize(value) : normalize(resolve(value));
}

function comparable(value: string): string {
  return normalizeInput(value).replace(/[\\/]+$/, "").toLowerCase();
}

export function unsafeWorkspaceRootLabel(value: string, userHome = homedir()): string | null {
  const resolved = normalizeInput(value);
  const trimmed = resolved.replace(/[\\/]+$/, "");
  const windowsStyle = /^[a-z]:[\\/]/i.test(value) || /^\\\\/.test(value);
  const leaf = (windowsStyle ? win32.basename(trimmed) : basename(trimmed)).toLowerCase();

  if (/^[a-z]:$/i.test(trimmed) || trimmed === "" || trimmed === "/") return "drive root";
  if (comparable(trimmed) === comparable(userHome)) return "user home directory";
  if (leaf === "desktop") return "Desktop";
  if (leaf === "downloads") return "Downloads";
  if (leaf === "documents") return "Documents";
  return null;
}

export function validateWorkspaceRoot(value: string, userHome = homedir()): WorkspaceRootValidation {
  const lexicalPath = normalize(resolve(value || "."));
  if (!existsSync(lexicalPath)) {
    return { ok: false, path: lexicalPath, reason: "workspaceRoot does not exist", category: "missing" };
  }
  let resolved: string;
  try {
    resolved = normalize(realpathSync(lexicalPath));
    if (!statSync(resolved).isDirectory()) {
      return { ok: false, path: resolved, reason: "workspaceRoot is not a directory", category: "not_directory" };
    }
  } catch {
    return { ok: false, path: lexicalPath, reason: "workspaceRoot is not accessible", category: "not_directory" };
  }
  const unsafeLabel = unsafeWorkspaceRootLabel(resolved, userHome);
  if (unsafeLabel) {
    return { ok: false, path: resolved, reason: `workspaceRoot cannot be ${unsafeLabel}`, category: "unsafe_root" };
  }
  return { ok: true, path: resolved, reason: null, category: "valid" };
}
