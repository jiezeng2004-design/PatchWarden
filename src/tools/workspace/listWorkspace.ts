import { readdirSync, statSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { getConfig } from "../../config.js";
import { guardPath } from "../../security/pathGuard.js";
import { guardSensitivePath } from "../../security/sensitiveGuard.js";

export interface ListEntry {
  name: string;
  type: "file" | "directory";
  size?: number;
}

export interface ListWorkspaceOutput {
  path: string;
  entries: ListEntry[];
}

const MAX_LIST_FILES = 200;

export function listWorkspace(relativePath?: string): ListWorkspaceOutput {
  const config = getConfig();
  const targetPath = relativePath
    ? resolve(config.workspaceRoot, relativePath)
    : config.workspaceRoot;

  const guarded = guardPath(targetPath, config.workspaceRoot);

  if (!existsSync(guarded)) {
    throw new Error(`Path not found: "${relativePath || "."}"`);
  }

  const stat = statSync(guarded);
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: "${relativePath || "."}"`);
  }

  const entries: ListEntry[] = [];
  const raw = readdirSync(guarded);

  for (const name of raw) {
    // Skip hidden files and sensitive paths
    const fullPath = resolve(guarded, name);
    try {
      guardSensitivePath(fullPath);
    } catch {
      continue; // skip sensitive files silently
    }

    try {
      const s = statSync(fullPath);
      entries.push({
        name,
        type: s.isDirectory() ? "directory" : "file",
        size: s.isFile() ? s.size : undefined,
      });
    } catch {
      // can't stat, skip
    }

    if (entries.length >= MAX_LIST_FILES) break;
  }

  return {
    path: relativePath || ".",
    entries: entries.sort((a, b) => {
      // directories first, then alphabetically
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    }),
  };
}
