import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const SKIPPED_DIRECTORIES = new Set([".git", ".patchwarden", "node_modules", "dist", "build", "coverage", "release"]);
const MAX_CANDIDATES = 20;

export interface RepositoryScopeCandidate {
  path: string;
  markers: Array<"package_json" | "git">;
}

export interface RepositoryScopeDetection {
  workspace_root: string;
  repo_path: string;
  is_workspace_root: boolean;
  detected_projects: RepositoryScopeCandidate[];
  confirmation_required: boolean;
}

export function detectRepositoryScope(repoPath: string, workspaceRoot: string): RepositoryScopeDetection {
  const root = resolve(workspaceRoot);
  const repo = resolve(repoPath);
  const isWorkspaceRoot = samePath(root, repo);
  const candidates = isWorkspaceRoot ? discoverProjects(root) : [];
  return {
    workspace_root: root,
    repo_path: repo,
    is_workspace_root: isWorkspaceRoot,
    detected_projects: candidates,
    confirmation_required: isWorkspaceRoot && candidates.length >= 2,
  };
}

function discoverProjects(root: string): RepositoryScopeCandidate[] {
  const candidates: RepositoryScopeCandidate[] = [];
  const rootMarkers = markersFor(root);
  if (rootMarkers.length > 0) candidates.push({ path: ".", markers: rootMarkers });
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (candidates.length >= MAX_CANDIDATES) break;
    if (!entry.isDirectory() || entry.isSymbolicLink() || SKIPPED_DIRECTORIES.has(entry.name.toLowerCase())) continue;
    const child = join(root, entry.name);
    const markers = markersFor(child);
    if (markers.length > 0) candidates.push({ path: entry.name, markers });
  }
  return candidates.sort((left, right) => left.path.localeCompare(right.path));
}

function markersFor(directory: string): Array<"package_json" | "git"> {
  const markers: Array<"package_json" | "git"> = [];
  if (isRegularFile(join(directory, "package.json"))) markers.push("package_json");
  const git = join(directory, ".git");
  if (existsSync(git)) {
    try {
      const stat = lstatSync(git);
      if (!stat.isSymbolicLink() && (stat.isDirectory() || stat.isFile())) markers.push("git");
    } catch {
      // An inaccessible marker is not enough evidence to authorize a workspace-root task.
    }
  }
  return markers;
}

function isRegularFile(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left).replace(/[\\/]+$/, "");
  const normalizedRight = resolve(right).replace(/[\\/]+$/, "");
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}
