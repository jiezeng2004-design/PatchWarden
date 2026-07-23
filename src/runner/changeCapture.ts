import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, relative, resolve, isAbsolute } from "node:path";
import { execFile } from "node:child_process";
import { redactSensitiveContent } from "../security/contentRedaction.js";
import { isSensitivePath } from "../security/sensitiveGuard.js";
import { nullDevice } from "../utils/platform.js";
import { buildGitEnvironment, resolveTrustedExecutable } from "./processSecurity.js";
import { atomicWriteJsonFileSync } from "../utils/atomicFile.js";

const MAX_HASH_BYTES = 5 * 1024 * 1024;
const MAX_SNAPSHOT_FILES = 5000;
const MAX_DIFF_BYTES = 20 * 1024 * 1024;
const DIFF_TRUNCATION_MARKER = "\n[PATCHWARDEN DIFF TRUNCATED]\n";
const SKIP_DIRECTORIES = new Set([".git", ".patchwarden", "node_modules"]);

export interface FileFingerprint {
  size: number;
  sha256: string;
  tracked: boolean;
  ignored: boolean;
}

export interface RepoSnapshot {
  captured_at: string;
  is_git: boolean;
  head: string | null;
  status: string;
  workspace_dirty: boolean;
  files: Record<string, FileFingerprint>;
  dirty_paths: string[]; // paths that git status --porcelain reports as modified/added/deleted/untracked/renamed
  warnings: string[];
}

export interface ChangedFile {
  path: string;
  change: "added" | "modified" | "deleted" | "renamed";
  old_path?: string;
  before_sha256: string | null;
  after_sha256: string | null;
  tracked: boolean;
  ignored: boolean;
  kind: "source" | "build_artifact" | "runtime_generated";
}

export interface ClassifiedChange {
  path: string;
  change: ChangedFile["change"];
  tracked: boolean;
  ignored: boolean;
  kind: ChangedFile["kind"];
  reason: string;
}

export interface ArtifactHygiene {
  counts: {
    source_changes: number;
    tracked_build_artifacts: number;
    ignored_untracked_artifacts: number;
    runtime_generated_files: number;
    suspicious_changes: number;
  };
  source_changes: ClassifiedChange[];
  tracked_build_artifacts: ClassifiedChange[];
  ignored_untracked_artifacts: ClassifiedChange[];
  runtime_generated_files: ClassifiedChange[];
  suspicious_changes: ClassifiedChange[];
}

export interface ChangeArtifacts {
  changed_files: ChangedFile[];
  diff: string;
  diff_available: boolean;
  diff_truncated: boolean;
  diff_redacted?: boolean;
  diff_redaction_categories?: string[];
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
  patch_mode: "textual" | "no_changes" | "hash_only";
  unavailable_reason: string | null;
  artifact_hygiene: ArtifactHygiene;
}

export async function captureRepoSnapshot(repoPath: string, signal?: AbortSignal): Promise<RepoSnapshot> {
  throwIfAborted(signal);
  const warnings: string[] = [];
  const isGitResult = await runGit(repoPath, ["rev-parse", "--is-inside-work-tree"], signal);
  const isGit = isGitResult.stdout.trim() === "true";
  let head: string | null = null;
  let status = "";
  let paths: string[] = [];
  const trackedPaths = new Map<string, Set<string>>();
  const ignoredPaths = new Map<string, Set<string>>();

  const dirtyPaths = new Set<string>();
  if (isGit) {
    // The following five git calls are independent of each other and can run in parallel.
    const [headResult, statusResult, trackedResult, ignoredResult, listedResult] = await Promise.all([
      runGit(repoPath, ["rev-parse", "HEAD"], signal),
      runGit(repoPath, ["status", "--porcelain=v1", "-uall"], signal),
      runGit(repoPath, ["ls-files", "-z"], signal),
      runGit(repoPath, ["ls-files", "-o", "-i", "--exclude-standard", "-z"], signal),
      runGit(repoPath, ["ls-files", "-co", "--exclude-standard", "-z"], signal),
    ]);

    if (headResult.status === 0) head = headResult.stdout.trim() || null;
    status = statusResult.stdout.trimEnd();
    // Parse git status --porcelain to collect all dirty paths
    for (const line of status.split("\n")) {
      if (line.length < 4) continue;
      const st = line.slice(0, 2); // XY status codes
      const rawPath = line.slice(3);
      // M=modified, A=added, D=deleted, ?=untracked, R=renamed, !=ignored
      if (/[MAD\?R]/.test(st)) {
        if (st.includes("R")) {
          // Rename: rawPath is "oldname -> newname"
          const parts = rawPath.split(" -> ");
          if (parts.length === 2) {
            dirtyPaths.add(normalizePath(parts[0]));
            dirtyPaths.add(normalizePath(parts[1]));
          } else {
            dirtyPaths.add(normalizePath(rawPath));
          }
        } else {
          dirtyPaths.add(normalizePath(rawPath));
        }
      }
    }
    if (trackedResult.status === 0) {
      for (const path of trackedResult.stdout.split("\0").filter(Boolean)) addSnapshotPath(trackedPaths, path);
    }
    if (ignoredResult.status === 0) {
      for (const path of ignoredResult.stdout.split("\0").filter(Boolean)) addSnapshotPath(ignoredPaths, path);
    } else {
      warnings.push("git ignored-file discovery failed; ignored classification may be incomplete");
    }
    if (listedResult.status === 0) {
      paths = [...new Set([
        ...listedResult.stdout.split("\0").filter(Boolean),
        ...walkWorkspace(repoPath, signal),
      ])];
    } else {
      warnings.push("git ls-files failed; using bounded filesystem scan");
      paths = walkWorkspace(repoPath, signal);
    }
  } else {
    warnings.push("repository is not a Git worktree; diff will contain file-change evidence only");
    paths = walkWorkspace(repoPath, signal);
  }

  if (paths.length > MAX_SNAPSHOT_FILES) {
    warnings.push(`snapshot limited to ${MAX_SNAPSHOT_FILES} files`);
    paths = paths.slice(0, MAX_SNAPSHOT_FILES);
  }

  const files: Record<string, FileFingerprint> = {};
  for (const inputPath of paths.sort()) {
    throwIfAborted(signal);
    const normalized = normalizePath(inputPath);
    if (!normalized || normalized.startsWith(".patchwarden/") || isSensitivePath(normalized)) continue;
    const absolutePath = resolve(repoPath, inputPath);
    try {
      const stat = lstatSync(absolutePath);
      if (!stat.isFile()) continue;
      const sha256 = stat.size <= MAX_HASH_BYTES
        ? createHash("sha256").update(readFileSync(absolutePath)).digest("hex")
        : `large-file:${stat.size}:${Math.trunc(stat.mtimeMs)}`;
      files[normalized] = {
        size: stat.size,
        sha256,
        tracked: hasSnapshotPath(trackedPaths, normalized),
        ignored: !hasSnapshotPath(trackedPaths, normalized) && hasSnapshotPath(ignoredPaths, normalized),
      };
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
    dirty_paths: [...dirtyPaths],
    warnings,
  };
}

export function writeSnapshot(taskDir: string, filename: string, snapshot: RepoSnapshot): void {
  atomicWriteJsonFileSync(join(taskDir, filename), snapshot);
}

export async function buildChangeArtifacts(
  repoPath: string,
  before: RepoSnapshot,
  after: RepoSnapshot,
  signal?: AbortSignal,
): Promise<ChangeArtifacts> {
  throwIfAborted(signal);
  const changedFiles = compareSnapshots(before, after);
  const artifactHygiene = classifyArtifactHygiene(changedFiles);
  const sections: string[] = [];
  const scopedPaths = [...new Set(changedFiles.flatMap((file) => file.old_path ? [file.old_path, file.path] : [file.path]))];
  const evidence = [
    "# PatchWarden change evidence",
    `# changed_files: ${changedFiles.length}`,
    `# workspace_dirty_before: ${before.workspace_dirty}`,
    `# workspace_dirty_after: ${after.workspace_dirty}`,
    ...changedFiles.map((file) => `# ${file.change}: ${file.path}`),
  ].join("\n");
  let retainedSectionBytes = 0;
  let diffTruncated = Buffer.byteLength(evidence, "utf-8") > MAX_DIFF_BYTES;
  const sectionBudget = Math.max(
    0,
    MAX_DIFF_BYTES
      - Math.min(Buffer.byteLength(evidence, "utf-8"), MAX_DIFF_BYTES)
      - Buffer.byteLength(DIFF_TRUNCATION_MARKER, "utf-8")
      - 2,
  );
  const appendSection = (label: string, content: string, commandTruncated = false): void => {
    if (!content.trim()) {
      if (commandTruncated) diffTruncated = true;
      return;
    }
    const block = `${sections.length > 0 ? "\n\n" : ""}${label}\n\n${content.trimEnd()}`;
    const remaining = Math.max(0, sectionBudget - retainedSectionBytes);
    const bounded = utf8Prefix(block, remaining);
    if (bounded) {
      sections.push(bounded);
      retainedSectionBytes += Buffer.byteLength(bounded, "utf-8");
    }
    if (commandTruncated || Buffer.byteLength(bounded, "utf-8") < Buffer.byteLength(block, "utf-8")) {
      diffTruncated = true;
    }
  };

  if (before.is_git && after.is_git && scopedPaths.length > 0) {
    if (before.head && after.head && before.head !== after.head) {
      const committed = await runGit(repoPath, ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--binary", before.head, after.head, "--", ...scopedPaths], signal);
      appendSection("# Changes committed during task", committed.stdout, committed.truncated);
    }

    if (retainedSectionBytes < sectionBudget) {
      const base = after.head || "HEAD";
      const working = await runGit(repoPath, ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--binary", base, "--", ...scopedPaths], signal);
      appendSection("# Staged and unstaged changes", working.stdout, working.truncated);
    } else {
      diffTruncated = true;
    }

    for (const file of changedFiles.filter((item) => item.change === "added").slice(0, 100)) {
      throwIfAborted(signal);
      if (retainedSectionBytes >= sectionBudget) {
        diffTruncated = true;
        break;
      }
      const tracked = await runGit(repoPath, ["ls-files", "--error-unmatch", "--", file.path], signal);
      if (tracked.status === 0) continue;
      const untracked = await runGit(repoPath, ["diff", "--no-ext-diff", "--no-textconv", "--no-index", "--no-color", "--binary", "--", nullDevice, file.path], signal);
      appendSection("# Untracked file", untracked.stdout, untracked.truncated);
    }
  }

  const body = sections.join("");
  const rawDiff = `${evidence}\n\n${body || (changedFiles.length ? "(textual patch unavailable; see changed-files.json for hash evidence)" : "(no task file changes detected)")}\n`;
  const sanitized = sanitizeDiffEvidence(rawDiff, MAX_DIFF_BYTES);
  const fullDiff = sanitized.content;
  diffTruncated ||= sanitized.truncated;
  const additions = fullDiff.split(/\r?\n/).filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
  const deletions = fullDiff.split(/\r?\n/).filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
  const fileStats = await buildFileStats(repoPath, before, after, changedFiles, signal);

  return {
    changed_files: changedFiles,
    diff: fullDiff,
    diff_available: changedFiles.length > 0,
    diff_truncated: diffTruncated,
    diff_redacted: sanitized.redacted,
    diff_redaction_categories: sanitized.redaction_categories,
    diff_size_bytes: Buffer.byteLength(fullDiff, "utf-8"),
    additions,
    deletions,
    file_stats: fileStats,
    workspace_dirty_before: before.workspace_dirty,
    workspace_dirty_after: after.workspace_dirty,
    patch_mode: changedFiles.length === 0 ? "no_changes" : body ? "textual" : "hash_only",
    unavailable_reason: changedFiles.length > 0 && !body
      ? (before.is_git && after.is_git
          ? "Git could not produce a textual patch for the changed files; hash evidence remains available."
          : "Repository is not a Git worktree; only bounded hash evidence is available.")
      : null,
    artifact_hygiene: artifactHygiene,
  };
}

export function sanitizeDiffEvidence(
  input: string,
  maxBytes = MAX_DIFF_BYTES,
): {
  content: string;
  truncated: boolean;
  redacted: boolean;
  redaction_categories: string[];
} {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("maxBytes must be a positive integer");
  }
  const redaction = redactSensitiveContent(input);
  const encodedBytes = Buffer.byteLength(redaction.content, "utf-8");
  if (encodedBytes <= maxBytes) {
    return {
      content: redaction.content,
      truncated: false,
      redacted: redaction.redacted,
      redaction_categories: redaction.redaction_categories,
    };
  }
  const marker = utf8Prefix(DIFF_TRUNCATION_MARKER, maxBytes);
  const markerBytes = Buffer.byteLength(marker, "utf-8");
  return {
    content: utf8Prefix(redaction.content, Math.max(0, maxBytes - markerBytes)) + marker,
    truncated: true,
    redacted: redaction.redacted,
    redaction_categories: redaction.redaction_categories,
  };
}

async function buildFileStats(
  repoPath: string,
  before: RepoSnapshot,
  after: RepoSnapshot,
  changedFiles: ChangedFile[],
  signal?: AbortSignal,
): Promise<ChangeArtifacts["file_stats"]> {
  const results = await Promise.all(changedFiles.map(async (file) => {
    throwIfAborted(signal);
    let additions = 0;
    let deletions = 0;
    const paths = file.old_path ? [file.old_path, file.path] : [file.path];

    if (before.is_git && after.is_git) {
      const ranges: string[][] = [];
      if (before.head && after.head && before.head !== after.head) {
        ranges.push([before.head, after.head]);
      }
      ranges.push([after.head || "HEAD"]);
      const rangeResults = await Promise.all(
        ranges.map((range) => runGit(repoPath, ["diff", "--no-ext-diff", "--no-textconv", "--numstat", ...range, "--", ...paths], signal))
      );
      for (const result of rangeResults) {
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
      } catch {} // probe failure handled by return value (additions stays 0)
    }

    return { path: file.path, status: file.change, additions, deletions };
  }));
  return results;
}

function countLines(content: string): number {
  if (content.length === 0) return 0;
  return content.split(/\r?\n/).length - (content.endsWith("\n") ? 1 : 0);
}

export function compareSnapshots(
  before: RepoSnapshot,
  after: RepoSnapshot,
  platform: NodeJS.Platform = process.platform,
): ChangedFile[] {
  const changed: ChangedFile[] = [];
  for (const { path, leftPath, rightPath, left, right } of pairSnapshotFiles(before.files, after.files, platform)) {
    if (!left && right) {
      changed.push(classifyChangedFile(path, "added", null, right));
    } else if (left && !right) {
      changed.push(classifyChangedFile(path, "deleted", left, null));
    } else if (left && right && left.sha256 === right.sha256 && leftPath !== rightPath) {
      // Windows lookup is case-insensitive, but a case-only Git rename is still
      // auditable work and must not disappear from the evidence set.
      changed.push({
        path: rightPath!,
        old_path: leftPath!,
        change: "renamed",
        before_sha256: left.sha256,
        after_sha256: right.sha256,
        tracked: left.tracked || right.tracked,
        ignored: right.ignored,
        kind: classifyPathKind(rightPath!),
      });
    } else if (left && right && left.sha256 !== right.sha256) {
      changed.push(classifyChangedFile(path, "modified", left, right));
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
      tracked: file.tracked || source.tracked,
      ignored: file.ignored,
      kind: classifyPathKind(file.path),
    });
  }

  return [...changed.filter((item) => !consumed.has(item)), ...renamed]
    .sort((left, right) => left.path.localeCompare(right.path));
}

export function emptyArtifactHygiene(): ArtifactHygiene {
  return {
    counts: {
      source_changes: 0,
      tracked_build_artifacts: 0,
      ignored_untracked_artifacts: 0,
      runtime_generated_files: 0,
      suspicious_changes: 0,
    },
    source_changes: [],
    tracked_build_artifacts: [],
    ignored_untracked_artifacts: [],
    runtime_generated_files: [],
    suspicious_changes: [],
  };
}

// ── Phase 4: External dirty file baseline ─────────────────────────

export interface ExternalDirtyFile {
  path: string;
  change: ChangedFile["change"];
  before_sha256: string | null;
  after_sha256: string | null;
}

/**
 * Extract files that are dirty in the workspace but outside the target repo.
 * Used to establish a baseline before task execution.
 */
export function extractExternalDirtyFiles(
  workspaceSnapshot: RepoSnapshot,
  repoPath: string,
  workspaceRoot: string,
  platform: NodeJS.Platform = process.platform,
): ExternalDirtyFile[] {
  const dirtyFiles: ExternalDirtyFile[] = [];
  const dirtyPathSet = new Map<string, Set<string>>();
  for (const path of workspaceSnapshot.dirty_paths) addSnapshotPath(dirtyPathSet, path, platform);
  for (const [path, fingerprint] of Object.entries(workspaceSnapshot.files)) {
    const absolutePath = resolve(workspaceRoot, path);
    const rel = relative(repoPath, absolutePath);
    // If the path is outside repoPath (starts with .. or is absolute)
    if (rel.startsWith("..") || isAbsolute(rel)) {
      // A file is "external dirty" if:
      // 1. Git reports it as dirty (modified/added/deleted/untracked) via dirty_paths, OR
      // 2. It's not tracked by git (untracked file), OR
      // 3. It's explicitly ignored
      const isDirty = hasSnapshotPath(dirtyPathSet, path, platform);
      const isUntracked = !fingerprint.tracked;
      const isIgnored = fingerprint.ignored;
      if (isDirty || isUntracked || isIgnored) {
        dirtyFiles.push({
          path,
          change: isDirty ? "modified" : "added",
          before_sha256: fingerprint.sha256,
          after_sha256: null,
        });
      }
    }
  }
  return dirtyFiles;
}

/**
 * Compare external dirty files between baseline and post-task snapshots.
 * Returns files that are NEW (not present in baseline) or CHANGED
 * (same path but different sha256, meaning the task modified them).
 */
export function findNewExternalDirtyFiles(
  baseline: ExternalDirtyFile[],
  current: ExternalDirtyFile[],
  platform: NodeJS.Platform = process.platform,
): ExternalDirtyFile[] {
  const baselineMap = new Map<string, ExternalDirtyFile[]>();
  for (const file of baseline) {
    const key = comparableSnapshotPath(file.path, platform);
    baselineMap.set(key, [...(baselineMap.get(key) ?? []), file]);
  }
  return current.filter((f) => {
    const candidates = baselineMap.get(comparableSnapshotPath(f.path, platform)) ?? [];
    const baselineFile = candidates.length <= 1
      ? candidates[0]
      : candidates.find((candidate) => normalizePath(candidate.path) === normalizePath(f.path));
    if (!baselineFile) return true; // New path — definitely new
    // Same path but content changed during task execution
    if (baselineFile.before_sha256 !== f.before_sha256) return true;
    return false;
  });
}

// ── Phase 6: Artifact manifest ────────────────────────────────────

export interface ArtifactManifestEntry {
  path: string;
  type: string;
  size: number;
  sha256: string;
  generated_by: string;
  created_at: string;
}

export interface ArtifactManifest {
  task_id: string | null;
  generated_at: string;
  artifacts: ArtifactManifestEntry[];
}

export async function buildArtifactManifest(
  changedFiles: ChangedFile[],
  repoPath: string,
  taskId?: string
): Promise<ArtifactManifest> {
  const entries: ArtifactManifestEntry[] = [];
  for (const file of changedFiles) {
    if (file.kind !== "build_artifact") continue;
    const absolutePath = resolve(repoPath, file.path);
    let size = 0;
    let sha256 = file.after_sha256 || "unknown";
    try {
      const stat = lstatSync(absolutePath);
      if (stat.isFile()) {
        size = stat.size;
        if (size <= MAX_HASH_BYTES) {
          sha256 = await hashFileAsync(absolutePath);
        }
      }
    } catch {
      // File may have been deleted
    }
    entries.push({
      path: file.path,
      type: classifyArtifactType(file.path),
      size,
      sha256,
      generated_by: "task_execution",
      created_at: new Date().toISOString(),
    });
  }
  return {
    task_id: taskId || null,
    generated_at: new Date().toISOString(),
    artifacts: entries,
  };
}

function classifyArtifactType(path: string): string {
  const normalized = normalizePath(path).toLowerCase();
  const basename = normalized.split("/").pop() || "";
  if (basename.endsWith(".exe")) return "windows_exe";
  if (basename.endsWith(".apk")) return "android_apk";
  if (basename.endsWith(".zip")) return "zip";
  if (basename.endsWith(".asar")) return "asar";
  if (basename.endsWith(".dll")) return "dll";
  if (basename.endsWith(".pak")) return "pak";
  return "release_directory_file";
}

// ── Phase 6: Changed file grouping ────────────────────────────────

export interface ChangedFileGroups {
  source_changes: ChangedFile[];
  docs_changes: ChangedFile[];
  config_changes: ChangedFile[];
  test_changes: ChangedFile[];
  release_artifacts: ChangedFile[];
  runtime_generated_files: ChangedFile[];
}

export function groupChangedFiles(changedFiles: ChangedFile[]): ChangedFileGroups {
  const groups: ChangedFileGroups = {
    source_changes: [],
    docs_changes: [],
    config_changes: [],
    test_changes: [],
    release_artifacts: [],
    runtime_generated_files: [],
  };
  for (const file of changedFiles) {
    const normalized = normalizePath(file.path).toLowerCase();
    const parts = normalized.split("/");
    const basename = parts[parts.length - 1] || "";
    // Check for docs
    if (parts.some((p) => p === "docs") || /\.(md|rst|txt)$/.test(basename)) {
      groups.docs_changes.push(file);
      continue;
    }
    // Check for config
    if (basename === "package.json" || basename === "tsconfig.json" || basename === ".gitignore" ||
        basename.startsWith(".config") || basename.endsWith(".config.js") || basename.endsWith(".config.ts")) {
      groups.config_changes.push(file);
      continue;
    }
    // Check for test files
    if (basename.includes(".test.") || basename.includes(".spec.") || parts.some((p) => p === "test" || p === "tests" || p === "__tests__")) {
      groups.test_changes.push(file);
      continue;
    }
    // Check for build artifacts / release
    if (file.kind === "build_artifact") {
      groups.release_artifacts.push(file);
      continue;
    }
    // Check for runtime generated
    if (file.kind === "runtime_generated") {
      groups.runtime_generated_files.push(file);
      continue;
    }
    // Default: source changes
    groups.source_changes.push(file);
  }
  return groups;
}

function classifyChangedFile(
  path: string,
  change: ChangedFile["change"],
  before: FileFingerprint | null,
  after: FileFingerprint | null
): ChangedFile {
  return {
    path,
    change,
    before_sha256: before?.sha256 || null,
    after_sha256: after?.sha256 || null,
    tracked: Boolean(after?.tracked || before?.tracked),
    ignored: Boolean(after?.ignored ?? before?.ignored),
    kind: classifyPathKind(path),
  };
}

function classifyArtifactHygiene(changes: ChangedFile[]): ArtifactHygiene {
  const hygiene = emptyArtifactHygiene();
  const entries = changes.map((change): ClassifiedChange => ({
    path: change.path,
    change: change.change,
    tracked: change.tracked,
    ignored: change.ignored,
    kind: change.kind,
    reason: classificationReason(change),
  }));
  hygiene.source_changes = entries.filter((entry) => entry.kind === "source" && !entry.ignored);
  hygiene.tracked_build_artifacts = entries.filter((entry) => entry.kind === "build_artifact" && entry.tracked);
  hygiene.ignored_untracked_artifacts = entries.filter((entry) => entry.ignored && !entry.tracked);
  hygiene.runtime_generated_files = entries.filter((entry) => entry.kind === "runtime_generated");
  hygiene.suspicious_changes = entries.filter((entry) =>
    (entry.kind === "build_artifact" || entry.kind === "runtime_generated") && !entry.ignored
  );
  hygiene.counts = {
    source_changes: hygiene.source_changes.length,
    tracked_build_artifacts: hygiene.tracked_build_artifacts.length,
    ignored_untracked_artifacts: hygiene.ignored_untracked_artifacts.length,
    runtime_generated_files: hygiene.runtime_generated_files.length,
    suspicious_changes: hygiene.suspicious_changes.length,
  };
  return hygiene;
}

function classifyPathKind(path: string): ChangedFile["kind"] {
  const normalized = normalizePath(path).toLowerCase();
  const parts = normalized.split("/");
  const basename = parts[parts.length - 1] || "";
  if (basename === "sync-store.json" || /\.(log|tmp|temp|pid)$/.test(basename)) return "runtime_generated";
  if (parts.some((part) => ["dist", "release", "build", "out", "coverage", ".next"].includes(part))) return "build_artifact";
  if (/\.(exe|dll|pak|bin|zip|tgz|tar\.gz)$/.test(basename)) return "build_artifact";
  return "source";
}

function classificationReason(change: ChangedFile): string {
  if (change.ignored) return "untracked path is ignored by repository Git rules";
  if (change.kind === "build_artifact" && change.tracked) return "artifact-like path is tracked by Git and requires review";
  if (change.kind === "build_artifact") return "artifact-like path is not ignored and requires review";
  if (change.kind === "runtime_generated") return "runtime-generated path is not ignored and requires review";
  return change.tracked ? "tracked source change" : "untracked source change";
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function comparableSnapshotPath(value: string, platform: NodeJS.Platform = process.platform): string {
  const normalized = normalizePath(value);
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function addSnapshotPath(
  index: Map<string, Set<string>>,
  value: string,
  platform: NodeJS.Platform = process.platform,
): void {
  const normalized = normalizePath(value);
  const key = comparableSnapshotPath(normalized, platform);
  const exactPaths = index.get(key) ?? new Set<string>();
  exactPaths.add(normalized);
  index.set(key, exactPaths);
}

function hasSnapshotPath(
  index: Map<string, Set<string>>,
  value: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const normalized = normalizePath(value);
  const exactPaths = index.get(comparableSnapshotPath(normalized, platform));
  if (!exactPaths) return false;
  return platform !== "win32" || exactPaths.size <= 1 || exactPaths.has(normalized);
}

interface SnapshotFileEntry {
  path: string;
  fingerprint: FileFingerprint;
}

function pairSnapshotFiles(
  before: Record<string, FileFingerprint>,
  after: Record<string, FileFingerprint>,
  platform: NodeJS.Platform,
): Array<{ path: string; leftPath?: string; rightPath?: string; left?: FileFingerprint; right?: FileFingerprint }> {
  const beforeGroups = groupSnapshotFiles(before, platform);
  const afterGroups = groupSnapshotFiles(after, platform);
  const pairs: Array<{ path: string; leftPath?: string; rightPath?: string; left?: FileFingerprint; right?: FileFingerprint }> = [];
  const comparablePaths = [...new Set([...beforeGroups.keys(), ...afterGroups.keys()])].sort();

  for (const comparablePath of comparablePaths) {
    const beforeEntries = beforeGroups.get(comparablePath) ?? [];
    const afterEntries = afterGroups.get(comparablePath) ?? [];
    if (platform !== "win32" || (beforeEntries.length <= 1 && afterEntries.length <= 1)) {
      pairs.push({
        path: afterEntries[0]?.path ?? beforeEntries[0].path,
        leftPath: beforeEntries[0]?.path,
        rightPath: afterEntries[0]?.path,
        left: beforeEntries[0]?.fingerprint,
        right: afterEntries[0]?.fingerprint,
      });
      continue;
    }

    // NTFS can opt individual directories into case-sensitive mode. If either
    // snapshot contains a case collision, preserve every exact path instead of
    // silently dropping one entry from the evidence.
    const beforeExact = new Map(beforeEntries.map((entry) => [normalizePath(entry.path), entry]));
    const afterExact = new Map(afterEntries.map((entry) => [normalizePath(entry.path), entry]));
    const exactPaths = [...new Set([...beforeExact.keys(), ...afterExact.keys()])].sort();
    for (const exactPath of exactPaths) {
      pairs.push({
        path: afterExact.get(exactPath)?.path ?? beforeExact.get(exactPath)!.path,
        leftPath: beforeExact.get(exactPath)?.path,
        rightPath: afterExact.get(exactPath)?.path,
        left: beforeExact.get(exactPath)?.fingerprint,
        right: afterExact.get(exactPath)?.fingerprint,
      });
    }
  }
  return pairs;
}

function groupSnapshotFiles(
  files: Record<string, FileFingerprint>,
  platform: NodeJS.Platform,
): Map<string, SnapshotFileEntry[]> {
  const grouped = new Map<string, SnapshotFileEntry[]>();
  for (const [path, fingerprint] of Object.entries(files)) {
    const key = comparableSnapshotPath(path, platform);
    grouped.set(key, [...(grouped.get(key) ?? []), { path, fingerprint }]);
  }
  return grouped;
}

function walkWorkspace(root: string, signal?: AbortSignal): string[] {
  const result: string[] = [];
  const visit = (directory: string) => {
    throwIfAborted(signal);
    if (result.length >= MAX_SNAPSHOT_FILES) return;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      throwIfAborted(signal);
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

function runGit(repoPath: string, args: string[], signal?: AbortSignal): Promise<{
  status: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
}> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const env = buildGitEnvironment(repoPath);
    const git = resolveTrustedExecutable("git", repoPath, { pathValue: env.PATH });
    execFile(git, args, {
      cwd: repoPath,
      encoding: "utf-8",
      timeout: 30_000,
      maxBuffer: MAX_DIFF_BYTES,
      windowsHide: true,
      env,
      signal,
    }, (err, stdout, stderr) => {
      if (signal?.aborted) {
        reject(abortReason(signal));
        return;
      }
      let status: number | null;
      if (err) {
        // err.code is the exit code (number) when the process exited with a non-zero status;
        // it is a string (e.g. "ENOENT") when spawning failed or the buffer limit was hit.
        status = typeof err.code === "number" ? err.code : null;
      } else {
        status = 0;
      }
      const truncated = Boolean(
        err
        && typeof err.code === "string"
        && err.code.includes("MAXBUFFER"),
      );
      resolve({ status, stdout: stdout || "", stderr: stderr || "", truncated });
    });
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Operation aborted");
}

function utf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const encoded = Buffer.from(value, "utf-8");
  if (encoded.length <= maxBytes) return value;
  let prefix = encoded.subarray(0, maxBytes).toString("utf-8").replace(/\uFFFD$/u, "");
  while (Buffer.byteLength(prefix, "utf-8") > maxBytes) prefix = prefix.slice(0, -1);
  return prefix;
}

function hashFileAsync(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    hash.on("error", reject);
    hash.on("finish", () => resolve(hash.digest("hex")));
    stream.pipe(hash);
  });
}
