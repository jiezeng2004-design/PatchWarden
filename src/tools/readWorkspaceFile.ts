import { readFileSync, statSync } from "node:fs";
import { getConfig } from "../config.js";
import { guardReadPath } from "../security/pathGuard.js";
import { guardSensitivePath } from "../security/sensitiveGuard.js";

export interface ReadWorkspaceFileOutput {
  path: string;
  content: string;
  size: number;
}

export function readWorkspaceFile(relativePath: string): ReadWorkspaceFileOutput {
  const config = getConfig();

  const safePath = guardReadPath(relativePath, config.workspaceRoot);
  guardSensitivePath(safePath);

  const stat = statSync(safePath);
  if (stat.size > config.maxReadFileBytes) {
    throw new Error(
      `File is ${stat.size} bytes, exceeds max of ${config.maxReadFileBytes} bytes.`
    );
  }

  // Only allow text-like files
  if (stat.size > 5_000_000) {
    throw new Error("File exceeds 5 MB size limit.");
  }

  const content = readFileSync(safePath, "utf-8");
  return {
    path: safePath,
    content,
    size: stat.size,
  };
}
