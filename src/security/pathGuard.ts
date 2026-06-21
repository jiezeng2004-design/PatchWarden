import {
  basename,
  dirname,
  isAbsolute,
  normalize,
  parse,
  resolve,
  sep,
} from "node:path";
import { realpathSync } from "node:fs";
import { PatchWardenError } from "../errors.js";

export function guardPath(
  requestedPath: string,
  workspaceRoot: string,
  allowedPrefix?: string
): string {
  const ws = normalize(resolve(workspaceRoot));
  const candidate =
    requestedPath === "" || requestedPath === "."
      ? ws
      : normalize(
          isAbsolute(requestedPath)
            ? resolve(requestedPath)
            : resolve(ws, requestedPath)
        );

  const realCandidate = realPathOrExistingPrefix(candidate);
  const realWs = realPathOrSelf(ws);

  assertInside(realCandidate, realWs, requestedPath, "Path escapes workspace");

  if (allowedPrefix) {
    const prefixPath = normalize(resolve(ws, allowedPrefix));
    assertInside(
      realCandidate,
      realPathOrExistingPrefix(prefixPath),
      requestedPath,
      `Path outside allowed prefix: "${requestedPath}" is not under "${allowedPrefix}"`
    );
  }

  return normalize(realCandidate);
}

export function guardReadPath(
  requestedPath: string,
  workspaceRoot: string,
  allowedPrefix?: string
): string {
  const guarded = guardPath(requestedPath, workspaceRoot, allowedPrefix);

  try {
    return realpathSync(guarded);
  } catch {
    throw new Error(`File not found: "${requestedPath}"`);
  }
}

export function guardWorkspacePath(
  inputPath: string,
  workspaceRoot: string
): string {
  const ws = normalize(resolve(workspaceRoot));
  const input = inputPath || ".";

  const winDriveMatch = input.match(/^([A-Za-z]):[/\\]/);
  const wsDriveMatch = ws.match(/^([A-Za-z]):[/\\]/);
  if (winDriveMatch && wsDriveMatch) {
    if (winDriveMatch[1].toLowerCase() !== wsDriveMatch[1].toLowerCase()) {
      throw new PatchWardenError(
        "workspace_path_escape",
        `repo_path "${input}" is on drive ${winDriveMatch[1].toUpperCase()}: ` +
          `but workspace is on drive ${wsDriveMatch[1].toUpperCase()}:. All paths must be under the configured workspace.`,
        "Pass a repo_path located under the configured workspaceRoot.",
        true,
        { path: input, operation: "resolve_repo_path", safe_alternative: "Use a repository path inside workspaceRoot." }
      );
    }
  } else if (winDriveMatch && !wsDriveMatch) {
    throw new PatchWardenError(
      "workspace_path_escape",
      `repo_path "${input}" appears to be a Windows path but workspace ` +
        `"${workspaceRoot}" is a Unix path. All paths must be under the configured workspace.`,
      "Use the same path style as workspaceRoot and keep repo_path inside it.",
      true,
      { path: input, operation: "resolve_repo_path", safe_alternative: "Use the workspaceRoot path style and an internal repository path." }
    );
  }

  const resolved = normalize(
    isAbsolute(input) ? resolve(input) : resolve(ws, input)
  );
  const realResolved = realPathOrExistingPrefix(resolved);
  const realWs = realPathOrSelf(ws);

  assertInside(
    realResolved,
    realWs,
    input,
    `repo_path "${input}" is outside workspace "${workspaceRoot}". All paths must be under the configured workspace.`
  );

  return normalize(realResolved);
}

function realPathOrSelf(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    return normalize(value);
  }
}

function realPathOrExistingPrefix(candidate: string): string {
  const normalized = normalize(candidate);
  const root = parse(normalized).root;
  const suffix: string[] = [];
  let current = normalized;

  while (current && current !== root) {
    try {
      return resolve(realpathSync(current), ...suffix);
    } catch {
      suffix.unshift(basename(current));
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  try {
    return resolve(realpathSync(root || current), ...suffix);
  } catch {
    return normalized;
  }
}

function assertInside(
  candidate: string,
  root: string,
  requestedPath: string,
  message: string
): void {
  const normalizedRoot = normalize(root);
  const normalizedCandidate = normalize(candidate);
  const checkRoot = process.platform === "win32"
    ? normalizedRoot.toLowerCase()
    : normalizedRoot;
  const checkCandidate = process.platform === "win32"
    ? normalizedCandidate.toLowerCase()
    : normalizedCandidate;

  if (
    checkCandidate !== checkRoot &&
    !checkCandidate.startsWith(checkRoot + sep)
  ) {
    if (message.startsWith("Path escapes workspace")) {
      throw new PatchWardenError(
        "workspace_path_escape",
        `Path escapes workspace: "${requestedPath}" resolves to "${normalizedCandidate}" which is outside "${normalizedRoot}"`,
        "Use a path inside the configured workspace and allowed prefix.",
        true,
        { path: requestedPath, operation: "path_access", safe_alternative: "Read a path inside the configured workspace and allowed prefix." }
      );
    }
    throw new PatchWardenError(
      "workspace_path_escape",
      message,
      "Use a path inside the configured workspace and allowed prefix.",
      true,
      { path: requestedPath, operation: "path_access", safe_alternative: "Read a path inside the configured workspace and allowed prefix." }
    );
  }
}
