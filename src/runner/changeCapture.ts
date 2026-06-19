import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { isSensitivePath } from "../security/sensitiveGuard.js";

const MAX_HASH_BYTES = 5 * 1024 * 1024;
const MAX_SNAPSHOT_FILES = 5000;
const MAX_DIFF_BYTES = 20 * 1024 * 1024;
const SKIP_DIRECTORIES = new Set([".git", ".safe-bifrost", "node_modules"]);

export interface FileFingerprint {
  size: number;
  sha256: string;
}

export interface RepoSnapshot {
  captured_at: string;
  is_git: boolean;
  head: string | null;
  status: string;
  workspace_dirty: boolean;
  files: Record<string, FileFingerprint>;
  warnings: string[];
}

export interface ChangedFile {
  path: string;
  change: "added" | "modified" | "deleted" | "renamed";
  old_path?: string;
  before_sha256: string | null;
  after_sha256: string | null;
}

export interface ChangeArtifacts {
  changed_files: ChangedFile[];
  diff: string;
  diff_available: boolean;
  diff_truncated: boolean;
  diff_size_bytes: number;
  additions: number;
  deletions: number;
  file_stats: Array<{
    path: string;
    status: ChangedFile["change"];
    additions: number;
    deletions: number;
  }>;
  workspace_dirty_before: boolean;
  workspace_dirty_after: boolean;
}

export function captureRepoSnapshot(repoPath: string): RepoSnapshot {
  const warnings: string[] = [];
  const isGit = runGit(repoPath, ["rev-parse", "--is-inside-work-tree"]).stdout.trim() === "true";
  let head: string | null = null;
  let status = "";
  let paths: string[] = [];

  if (isGit) {
    const headResult = runGit(repoPath, ["rev-parse", "HEAD"]);
    if (headResult.status === 0) head = headResult.stdout.trim() || null;
    status = runGit(repoPath, ["status", "--porcelain=v1", "-uall"]).stdout.trimEnd();
    const listed = runGit(repoPath, ["ls-files", "-co", "--exclude-standard", "-z"]);
    if (listed.status === 0) {
      paths = [...new Set([
        ...listed.stdout.split("\0").filter(Boolean),
        ...walkWorkspace(repoPath),
      ])];
    } else {
      warnings.push("git ls-files failed; using bounded filesystem scan");
      paths = walkWorkspace(repoPath);
    }
  } else {
    warnings.push("repository is not a Git worktree; diff will contain file-change evidence only");
    paths = walkWorkspace(repoPath);
  }

  if (paths.length > MAX_SNAPSHOT_FILES) {
    warnings.push(`snapshot limited to ${MAX_SNAPSHOT_FILES} files`);
    paths = paths.slice(0, MAX_SNAPSHOT_FILES);
  }

  const files: Record<string, FileFingerprint> = {};
  for (const inputPath of paths.sort()) {
    const normalized = inputPath.replace(/\\/g, "/");
    if (!normalized || normalized.startsWith(".safe-bifrost/") || isSensitivePath(normalized)) continue;
    const absolutePath = resolve(repoPath, inputPath);
    try {
      const stat = lstatSync(absolutePath);
      if (!stat.isFile()) continue;
      const sha256 = stat.size <= MAX_HASH_BYTES
        ? createHash("sha256").update(readFileSync(absolutePath)).digest("hex")
        : `large-file:${stat.size}:${Math.trunc(stat.mtimeMs)}`;
      files[normalized] = { size: stat.size, sha256 };
    } catch {
      warnings.push(`could not fingerprint: ${normalized}`);
    }
  }

  return {
    captured_at: new Date().toISOString(),
    is_git: isGit,
    head,
    status,
    workspace_dirty: status.trim().length > 0,
    files,
    warnings,
  };
}

export function writeSnapshot(taskDir: string, filename: string, snapshot: RepoSnapshot): void {
  writeFileSync(join(taskDir, filename), JSON.stringify(snapshot, null, 2), "utf-8");
}

export function buildChangeArtifacts(
  repoPath: string,
  before: RepoSnapshot,
  after: RepoSnapshot
): ChangeArtifacts {
  const changedFiles = compareSnapshots(before, after);
  const sections: string[] = [];
  const scopedPaths = [...new Set(changedFiles.flatMap((file) => file.old_path ? [file.old_path, file.path] : [file.path]))];

  if (before.is_git && after.is_git && scopedPaths.length > 0) {
    if (before.head && after.head && before.head !== after.head) {
      const committed = runGit(repoPath, ["diff", "--no-color", "--binary", before.head, after.head, "--", ...scopedPaths]);
      if (committed.stdout.trim()) sections.push("# Changes committed during task\n", committed.stdout.trimEnd());
    }

    const base = after.head || "HEAD";
    const working = runGit(repoPath, ["diff", "--no-color", "--binary", base, "--", ...scopedPaths]);
    if (working.stdout.trim()) sections.push("# Staged and unstaged changes\n", working.stdout.trimEnd());

    for (const file of changedFiles.filter((item) => item.change === "added").slice(0, 100)) {
      const tracked = runGit(repoPath, ["ls-files", "--error-unmatch", "--", file.path]);
      if (tracked.status === 0) continue;
      const untracked = runGit(repoPath, ["diff", "--no-index", "--no-color", "--binary", "--", "/dev/null", file.path]);
      if (untracked.stdout.trim()) sections.push("# Untracked file\n", untracked.stdout.trimEnd());
    }
  }

  const evidence = [
    "# Safe-Bifrost change evidence",
    `# changed_files: ${changedFiles.length}`,
    `# workspace_dirty_before: ${before.workspace_dirty}`,
    `# workspace_dirty_after: ${after.workspace_dirty}`,
    ...changedFiles.map((file) => `# ${file.change}: ${file.path}`),
  ].join("\n");
  const body = sections.join("\n\n");
  const fullDiff = `${evidence}\n\n${body || (changedFiles.length ? "(textual patch unavailable; see changed-files.json for hash evidence)" : "(no task file changes detected)")}\n`;
  const additions = fullDiff.split(/\r?\n/).filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
  const deletions = fullDiff.split(/\r?\n/).filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
  const fileStats = buildFileStats(repoPath, before, after, changedFiles);

  return {
    changed_files: changedFiles,
    diff: fullDiff,
    diff_available: changedFiles.length > 0,
    diff_truncated: false,
    diff_size_bytes: Buffer.byteLength(fullDiff, "utf-8"),
    additions,
    deletions,
    file_stats: fileStats,
    workspace_dirty_before: before.workspace_dirty,
    workspace_dirty_after: after.workspace_dirty,
  };
}

function buildFileStats(
  repoPath: string,
  before: RepoSnapshot,
  after: RepoSnapshot,
  changedFiles: ChangedFile[]
): ChangeArtifacts["file_stats"] {
  return changedFiles.map((file) => {
    let additions = 0;
    let deletions = 0;
    const paths = file.old_path ? [file.old_path, file.path] : [file.path];

    if (before.is_git && after.is_git) {
      const ranges: string[][] = [];
      if (before.head && after.head && before.head !== after.head) {
        ranges.push([before.head, after.head]);
      }
      ranges.push([after.head || "HEAD"]);
      for (const range of ranges) {
        const result = runGit(repoPath, ["diff", "--numstat", ...range, "--", ...paths]);
        for (const line of result.stdout.split(/\r?\n/).filter(Boolean)) {
          const [added, removed] = line.split(/\s+/);
          if (/^\d+$/.test(added)) additions += Number(added);
          if (/^\d+$/.test(removed)) deletions += Number(removed);
        }
      }
    }

    if (file.change === "added" && additions === 0) {
      try {
        const content = readFileSync(resolve(repoPath, file.path), "utf-8");
        additions = countLines(content);
      } catch {}
    }

    return { path: file.path, status: file.change, additions, deletions };
  });
}

function countLines(content: string): number {
  if (content.length === 0) return 0;
  return content.split(/\r?\n/).length - (content.endsWith("\n") ? 1 : 0);
}

export function compareSnapshots(before: RepoSnapshot, after: RepoSnapshot): ChangedFile[] {
  const paths = [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])].sort();
  const changed: ChangedFile[] = [];
  for (const path of paths) {
    const left = before.files[path];
    const right = after.files[path];
    if (!left && right) {
      changed.push({ path, change: "added", before_sha256: null, after_sha256: right.sha256 });
    } else if (left && !right) {
      changed.push({ path, change: "deleted", before_sha256: left.sha256, after_sha256: null });
    } else if (left.sha256 !== right.sha256) {
      changed.push({ path, change: "modified", before_sha256: left.sha256, after_sha256: right.sha256 });
    }
  }
  const deletedByHash = new Map<string, ChangedFile[]>();
  for (const file of changed.filter((item) => item.change === "deleted" && item.before_sha256)) {
    const entries = deletedByHash.get(file.before_sha256!) || [];
    entries.push(file);
    deletedByHash.set(file.before_sha256!, entries);
  }

  const consumed = new Set<ChangedFile>();
  const renamed: ChangedFile[] = [];
  for (const file of changed.filter((item) => item.change === "added" && item.after_sha256)) {
    const candidates = deletedByHash.get(file.after_sha256!) || [];
    const source = candidates.find((item) => !consumed.has(item));
    if (!source) continue;
    consumed.add(source);
    consumed.add(file);
    renamed.push({
      path: file.path,
      old_path: source.path,
      change: "renamed",
      before_sha256: source.before_sha256,
      after_sha256: file.after_sha256,
    });
  }

  return [...changed.filter((item) => !consumed.has(item)), ...renamed]
    .sort((left, right) => left.path.localeCompare(right.path));
}

function walkWorkspace(root: string): string[] {
  const result: string[] = [];
  const visit = (directory: string) => {
    if (result.length >= MAX_SNAPSHOT_FILES) return;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (result.length >= MAX_SNAPSHOT_FILES) break;
      if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) result.push(relative(root, absolute).replace(/\\/g, "/"));
    }
  };
  visit(root);
  return result;
}

function runGit(repoPath: string, args: string[]) {
  const result = spawnSync("git", args, {
    cwd: repoPath,
    encoding: "utf-8",
    timeout: 30_000,
    maxBuffer: MAX_DIFF_BYTES,
  });
  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}
