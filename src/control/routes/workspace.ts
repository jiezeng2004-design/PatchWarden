/**
 * Control Center routes — workspace (/api/workspace/*).
 *
 * Lists workspace directories + agent/config summary, lists first-level repo
 * subdirectories with package.json metadata, and runs on-demand
 * `git status --short` for a single repo. The git-status endpoint rejects path
 * traversal and is the only place that shells out to git.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { type ServerResponse } from "node:http";
import { type AgentAvailability, listAgents } from "../../tools/listAgents.js";
import { resolveWorkspaceRoot } from "../../config.js";
import { guardWorkspacePath } from "../../security/pathGuard.js";
import { config, errorMessage, sendJson } from "../shared.js";

export function handleWorkspace(res: ServerResponse): void {
  let workspaceRoot: string | null = null;
  let directories: string[] = [];
  let agents: AgentAvailability[] = [];
  let configSummary: { toolProfile: string | null; allowedTestCommandsCount: number; enableDirectProfile: boolean } | null = null;

  try {
    workspaceRoot = resolveWorkspaceRoot(config);
  } catch {
    workspaceRoot = null;
  }
  if (workspaceRoot) {
    try {
      directories = readdirSync(workspaceRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
    } catch {
      directories = [];
    }
  }
  try {
    agents = listAgents().agents;
  } catch {
    agents = [];
  }
  try {
    configSummary = {
      toolProfile: config.toolProfile ?? null,
      allowedTestCommandsCount: config.allowedTestCommands.length,
      enableDirectProfile: config.enableDirectProfile ?? false,
    };
  } catch {
    configSummary = null;
  }
  sendJson(res, 200, { workspace_root: workspaceRoot, directories, agents, config: configSummary });
}

interface WorkspaceRepoEntry {
  name: string;
  path: string;
  has_package_json: boolean;
  package_name: string | null;
  version: string | null;
}

/**
 * Lists first-level subdirectories of the workspace root and, for each one,
 * reads package.json (if present) to expose name/version. Read-only and
 * path-bounded: only direct children of workspaceRoot are inspected.
 */
export function handleWorkspaceRepos(res: ServerResponse): void {
  let workspaceRoot: string | null = null;
  try {
    workspaceRoot = resolveWorkspaceRoot(config);
  } catch (err) {
    sendJson(res, 200, { repos: [], workspace_root: null, error: errorMessage(err) });
    return;
  }
  if (!workspaceRoot) {
    sendJson(res, 200, { repos: [], workspace_root: null });
    return;
  }
  let entries: import("node:fs").Dirent[] = [];
  try {
    entries = readdirSync(workspaceRoot, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch (err) {
    sendJson(res, 200, { repos: [], workspace_root: workspaceRoot, error: errorMessage(err) });
    return;
  }
  const repos: WorkspaceRepoEntry[] = entries.map((entry) => {
    const dirPath = join(workspaceRoot as string, entry.name);
    const packageJsonPath = join(dirPath, "package.json");
    let packageName: string | null = null;
    let version: string | null = null;
    let hasPackageJson = false;
    if (existsSync(packageJsonPath)) {
      hasPackageJson = true;
      try {
        const raw = readFileSync(packageJsonPath, "utf-8").replace(/^\uFEFF/, "");
        const data = JSON.parse(raw);
        packageName = typeof data.name === "string" ? data.name : null;
        version = typeof data.version === "string" ? data.version : null;
      } catch {
        // package.json exists but is unreadable/invalid; keep nulls.
      }
    }
    return {
      name: entry.name,
      path: dirPath,
      has_package_json: hasPackageJson,
      package_name: packageName,
      version,
    };
  });
  repos.sort((a, b) => a.name.localeCompare(b.name));
  sendJson(res, 200, { repos, workspace_root: workspaceRoot });
}

/**
 * On-demand `git status --short` for a single repo under workspaceRoot.
 * The repo parameter is resolved against workspaceRoot and must stay inside it;
 * any path traversal attempt is rejected with 400. This intentionally does NOT
 * run a full workspace scan — only the repo the user clicked is inspected.
 */
export function handleWorkspaceRepoStatus(res: ServerResponse, repoParam: string): void {
  try {
    let workspaceRoot: string;
    try {
      workspaceRoot = resolveWorkspaceRoot(config);
    } catch (err) {
      sendJson(res, 500, { error: `workspace root unavailable: ${errorMessage(err)}` });
      return;
    }

    // Reject obvious traversal in the raw parameter before resolving.
    if (repoParam.includes("\0") || repoParam.includes("..")) {
      sendJson(res, 400, { error: "Invalid repo path: traversal segments are not allowed" });
      return;
    }

    let repoAbs: string;
    try {
      // guardWorkspacePath rejects absolute paths outside workspace and any
      // resolved path that escapes workspaceRoot.
      repoAbs = guardWorkspacePath(repoParam || ".", workspaceRoot);
    } catch (err) {
      sendJson(res, 400, { error: `Invalid repo path: ${errorMessage(err)}` });
      return;
    }

    if (!existsSync(repoAbs) || !statSync(repoAbs).isDirectory()) {
      sendJson(res, 404, { error: "Repo directory not found", repo_path: repoParam });
      return;
    }

    // Only `git status --short` is permitted; no arbitrary git subcommand.
    // Timeout guards against a hung git prompt (e.g. credential dialog).
    execFile(
      "git",
      ["status", "--short"],
      { cwd: repoAbs, maxBuffer: 1024 * 1024, timeout: 8000, windowsHide: true, encoding: "utf-8" },
      (err, stdout, stderr) => {
        if (err) {
          // Not a git repo, git missing, or git errored — return a structured
          // failure rather than 500 so the UI can render it gracefully.
          sendJson(res, 200, {
            repo_path: repoParam,
            resolved_repo_path: repoAbs,
            is_git_repo: false,
            changed_files_count: 0,
            untracked_count: 0,
            modified_count: 0,
            is_clean: true,
            short_status: "",
            error: errorMessage(err),
            stderr: stderr ? String(stderr).slice(0, 500) : "",
          });
          return;
        }
        const text = String(stdout);
        const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
        let modified = 0;
        let untracked = 0;
        for (const line of lines) {
          const xy = line.slice(0, 2);
          if (xy === "??") untracked++;
          else modified++;
        }
        sendJson(res, 200, {
          repo_path: repoParam,
          resolved_repo_path: repoAbs,
          is_git_repo: true,
          changed_files_count: lines.length,
          untracked_count: untracked,
          modified_count: modified,
          is_clean: lines.length === 0,
          short_status: text,
          error: null,
        });
      }
    );
  } catch (err) {
    sendJson(res, 500, { error: errorMessage(err) });
  }
}
