import { createHash } from "node:crypto";
import {
  createReadStream,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
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
import { getConfig, getRepoGeneratedPaths } from "../config.js";

const MAX_HASH_BYTES = 5 * 1024 * 1024;
const MAX_SNAPSHOT_FILES = 5000;
const MAX_DIFF_BYTES = 20 * 1024 * 1024;
const MAX_FINGERPRINT_CONCURRENCY = 8;
const MAX_IGNORED_ARTIFACT_FILES = 50;
const DIFF_TRUNCATION_MARKER = "\n[PATCHWARDEN DIFF TRUNCATED]\n";
const SKIP_DIRECTORIES = new Set([
  ".git", ".patchwarden", ".stage", ".local", "node_modules", ".npm-cache", ".pnpm-store", ".yarn",
  "coverage", "release", "build", "out", ".next",
]);
const DEFAULT_GENERATED_PATHS = [
  ".next/**",
  "dist/**",
  "build/**",
  "out/**",
  "coverage/**",
  ".cache/**",
  "target/**",
  "__pycache__/**",
  "*.tsbuildinfo",
  "*.pyc",
];
const ARTIFACT_PATTERN_HINT = /(^|\/)(?:\.next|dist|build|out|coverage|\.cache|cache|target|__pycache__|generated|release)(?:\/|$)|\.(?:tsbuildinfo|pyc|log|tmp|temp|map)(?:$|[*?])/i;
const MAX_IGNORE_FILE_BYTES = 128 * 1024;
const MAX_IMPORTED_IGNORE_PATTERNS = 128;

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
  integrity?: {
    complete: boolean;
    truncated: boolean;
    failure_codes: string[];
  };
  sensitive_files?: Record<string, SensitiveFileMetadata>;
}

export interface SensitiveFileMetadata {
  size: number;
  mtime_ms: number;
  file_type: "file" | "directory" | "other";
}

export interface ChangedFile {
  path: string;
  change: "added" | "modified" | "deleted" | "renamed";
  old_path?: string;
  old_kind?: "source" | "dependency" | "build_artifact" | "runtime_generated";
  before_sha256: string | null;
  after_sha256: string | null;
  tracked: boolean;
  ignored: boolean;
  kind: "source" | "dependency" | "build_artifact" | "runtime_generated";
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
    dependency_changes?: number;
    generated_changes?: number;
    runtime_changes?: number;
    unexpected_changes?: number;
    tracked_build_artifacts: number;
    ignored_untracked_artifacts: number;
    runtime_generated_files: number;
    suspicious_changes: number;
  };
  source_changes: ClassifiedChange[];
  dependency_changes?: ClassifiedChange[];
  generated_changes?: ClassifiedChange[];
  runtime_changes?: ClassifiedChange[];
  unexpected_changes?: ClassifiedChange[];
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
  const failureCodes = new Set<string>();
  const isGitResult = await runGit(repoPath, ["rev-parse", "--is-inside-work-tree"], signal);
  if (isGitResult.truncated) {
    throw new Error("snapshot_git_probe_truncated");
  }
  const probeText = `${isGitResult.stdout}\n${isGitResult.stderr}`;
  const isNotGitRepository = isGitResult.status === 128 && /not a git repository|not a git work tree/i.test(probeText);
  if (isGitResult.status !== 0 && !isNotGitRepository) {
    throw new Error(`snapshot_git_probe_failed: ${boundedGitError(isGitResult)}`);
  }
  const isGit = isGitResult.status === 0 && isGitResult.stdout.trim() === "true";
  let head: string | null = null;
  let status = "";
  let paths: string[] = [];
  const trackedPaths = new Map<string, Set<string>>();
  const ignoredPaths = new Map<string, Set<string>>();

  const dirtyPaths = new Set<string>();
  if (isGit) {
    // These four Git reads are independent. The authoritative listed result
    // replaces the former unconditional full-tree union, which followed large
    // ignored cache trees and made snapshots both slow and noisy.
    const [headResult, statusResult, trackedResult, listedResult] = await Promise.all([
      runGit(repoPath, ["rev-parse", "--verify", "HEAD"], signal),
      runGit(repoPath, ["status", "--porcelain=v1", "-uall"], signal),
      runGit(repoPath, ["ls-files", "-z"], signal),
      runGit(repoPath, ["ls-files", "-co", "--exclude-standard", "-z"], signal),
    ]);

    assertGitSnapshotResult("status", statusResult);
    assertGitSnapshotResult("tracked_files", trackedResult);
    assertGitSnapshotResult("listed_files", listedResult);
    if (headResult.status === 0 && !headResult.truncated) {
      head = headResult.stdout.trim() || null;
    } else if (headResult.status === 128 && !headResult.truncated) {
      // A newly initialized repository has no HEAD commit yet. Successful
      // status/list operations still prove Git is functioning correctly.
      head = null;
      warnings.push("Git repository has no commits yet; HEAD is unavailable");
    } else {
      assertGitSnapshotResult("head", headResult);
    }
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
    if ([...dirtyPaths].some((path) => isSensitivePath(path))) {
      failureCodes.add("sensitive_path_dirty");
      warnings.push("Git reported a dirty sensitive path; execution is blocked until it is resolved locally");
    }
    for (const path of trackedResult.stdout.split("\0").filter(Boolean)) addSnapshotPath(trackedPaths, path);
    const listedPaths = listedResult.stdout.split("\0").filter(Boolean);
    const listedPathIndex = new Map<string, Set<string>>();
    for (const path of listedPaths) addSnapshotPath(listedPathIndex, path);
    // Recover a bounded sample of ignored artifact/runtime evidence without
    // asking Git to enumerate every ignored cache entry. The authoritative
    // listed result already contains tracked and non-ignored untracked paths;
    // an on-disk artifact candidate absent from it is ignored.
    const artifactWalk = walkWorkspace(repoPath, signal);
    if (artifactWalk.truncated) warnings.push("ignored artifact candidate walk reached its file budget");
    const walkedArtifacts = artifactWalk.paths
      .filter((path) => classifyPathKind(path) !== "source")
      .filter((path) => !hasSnapshotPath(listedPathIndex, path))
      .sort();
    const allIgnoredArtifactPaths = walkedArtifacts;
    const ignoredArtifactPaths = allIgnoredArtifactPaths.slice(0, MAX_IGNORED_ARTIFACT_FILES);
    if (allIgnoredArtifactPaths.length > ignoredArtifactPaths.length) {
      warnings.push(`ignored artifact evidence limited to ${MAX_IGNORED_ARTIFACT_FILES} files`);
    }
    for (const path of ignoredArtifactPaths) addSnapshotPath(ignoredPaths, path);
    paths = [...new Set([...listedPaths, ...ignoredArtifactPaths])];
  } else {
    warnings.push("repository is not a Git worktree; diff will contain file-change evidence only");
    const walked = walkWorkspace(repoPath, signal);
    paths = walked.paths;
    if (walked.truncated) failureCodes.add("snapshot_file_limit_exceeded");
  }

  if (paths.length > MAX_SNAPSHOT_FILES) {
    warnings.push(`snapshot limited to ${MAX_SNAPSHOT_FILES} files`);
    failureCodes.add("snapshot_file_limit_exceeded");
    paths = paths.slice(0, MAX_SNAPSHOT_FILES);
  }

  const files: Record<string, FileFingerprint> = {};
  const fingerprinted = await mapWithConcurrency(paths.sort(), MAX_FINGERPRINT_CONCURRENCY, async (inputPath) => {
    throwIfAborted(signal);
    const normalized = normalizePath(inputPath);
    if (!normalized || normalized.startsWith(".patchwarden/") || isSensitivePath(normalized)) return null;
    const absolutePath = resolve(repoPath, inputPath);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(absolutePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // git ls-files intentionally retains a tracked path after its working
      // tree file is deleted. The dirty deletion is authoritative evidence,
      // not a fingerprint I/O failure.
      if (code === "ENOENT" && hasSnapshotPath(trackedPaths, normalized) && hasSnapshotPathSet(dirtyPaths, normalized)) {
        return null;
      }
      failureCodes.add("snapshot_fingerprint_failed");
      warnings.push(`could not fingerprint: ${normalized}`);
      return null;
    }
    try {
      if (stat.isSymbolicLink() || !stat.isFile()) return null;
      const sha256 = stat.size <= MAX_HASH_BYTES
        ? await hashFileAsync(absolutePath)
        : `large-file:${stat.size}:${Math.trunc(stat.mtimeMs)}`;
      const after = lstatSync(absolutePath);
      if (!after.isFile() || after.isSymbolicLink() || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) {
        failureCodes.add("snapshot_fingerprint_raced");
        warnings.push(`fingerprint changed during read: ${normalized}`);
        return null;
      }
      return [normalized, {
        size: stat.size,
        sha256,
        tracked: hasSnapshotPath(trackedPaths, normalized),
        ignored: hasSnapshotPath(ignoredPaths, normalized),
      }] as const;
    } catch {
      failureCodes.add("snapshot_fingerprint_failed");
      warnings.push(`could not fingerprint: ${normalized}`);
      return null;
    }
  });
  for (const entry of fingerprinted) {
    if (entry) files[entry[0]] = entry[1];
  }

  const sensitiveScan = walkSensitiveMetadata(repoPath, signal);
  for (const code of sensitiveScan.failure_codes) failureCodes.add(code);
  warnings.push(...sensitiveScan.warnings);
  const complete = failureCodes.size === 0;

  return {
    captured_at: new Date().toISOString(),
    is_git: isGit,
    head,
    status,
    workspace_dirty: status.trim().length > 0,
    files,
    dirty_paths: [...dirtyPaths],
    warnings,
    integrity: {
      complete,
      truncated: failureCodes.has("snapshot_file_limit_exceeded"),
      failure_codes: [...failureCodes].sort(),
    },
    sensitive_files: sensitiveScan.files,
  };
}

export function writeSnapshot(taskDir: string, filename: string, snapshot: RepoSnapshot): void {
  atomicWriteJsonFileSync(join(taskDir, filename), snapshot);
}

export function assertSnapshotComplete(snapshot: RepoSnapshot): void {
  if (snapshot.integrity?.complete === false) {
    throw new Error(`snapshot_incomplete: ${snapshot.integrity.failure_codes.join(",") || "unknown"}`);
  }
}

export function compareSensitiveSnapshots(before: RepoSnapshot, after: RepoSnapshot): string[] {
  const left = before.sensitive_files ?? {};
  const right = after.sensitive_files ?? {};
  const paths = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...paths].filter((path) => {
    const a = left[path];
    const b = right[path];
    return !a || !b || a.size !== b.size || a.mtime_ms !== b.mtime_ms || a.file_type !== b.file_type;
  }).sort();
}

export async function buildChangeArtifacts(
  repoPath: string,
  before: RepoSnapshot,
  after: RepoSnapshot,
  signal?: AbortSignal,
): Promise<ChangeArtifacts> {
  throwIfAborted(signal);
  const generatedPaths = resolveGeneratedPathPatterns(repoPath, getRepoGeneratedPaths(getConfig(), repoPath));
  const changedFiles = compareSnapshots(before, after, process.platform, generatedPaths);
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
  const results = await mapWithConcurrency(changedFiles, 4, async (file) => {
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
  });
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
  generatedPaths: string[] = DEFAULT_GENERATED_PATHS,
): ChangedFile[] {
  const changed: ChangedFile[] = [];
  for (const { path, leftPath, rightPath, left, right } of pairSnapshotFiles(before.files, after.files, platform)) {
    if (!left && right) {
      changed.push(classifyChangedFile(path, "added", null, right, generatedPaths));
    } else if (left && !right) {
      changed.push(classifyChangedFile(path, "deleted", left, null, generatedPaths));
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
        ignored: right.ignored && !["source", "dependency"].includes(classifyPathKind(leftPath!, generatedPaths)),
        kind: mergeRenameKind(
          classifyPathKind(leftPath!, generatedPaths),
          classifyPathKind(rightPath!, generatedPaths),
        ),
        old_kind: classifyPathKind(leftPath!, generatedPaths),
      });
    } else if (left && right && left.sha256 !== right.sha256) {
      changed.push(classifyChangedFile(path, "modified", left, right, generatedPaths));
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
      ignored: file.ignored && !["source", "dependency"].includes(classifyPathKind(source.path, generatedPaths)),
      kind: mergeRenameKind(
        classifyPathKind(source.path, generatedPaths),
        classifyPathKind(file.path, generatedPaths),
      ),
      old_kind: classifyPathKind(source.path, generatedPaths),
    });
  }

  return [...changed.filter((item) => !consumed.has(item)), ...renamed]
    .sort((left, right) => left.path.localeCompare(right.path));
}

export function emptyArtifactHygiene(): ArtifactHygiene {
  return {
    counts: {
      source_changes: 0,
      dependency_changes: 0,
      generated_changes: 0,
      runtime_changes: 0,
      unexpected_changes: 0,
      tracked_build_artifacts: 0,
      ignored_untracked_artifacts: 0,
      runtime_generated_files: 0,
      suspicious_changes: 0,
    },
    source_changes: [],
    dependency_changes: [],
    generated_changes: [],
    runtime_changes: [],
    unexpected_changes: [],
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
  after: FileFingerprint | null,
  generatedPaths: string[] = DEFAULT_GENERATED_PATHS,
): ChangedFile {
  return {
    path,
    change,
    before_sha256: before?.sha256 || null,
    after_sha256: after?.sha256 || null,
    tracked: Boolean(after?.tracked || before?.tracked),
    ignored: Boolean(after?.ignored ?? before?.ignored),
    kind: classifyPathKind(path, generatedPaths),
  };
}

export function classifyArtifactHygiene(changes: ChangedFile[]): ArtifactHygiene {
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
  hygiene.dependency_changes = entries.filter((entry) => entry.kind === "dependency" && !entry.ignored);
  hygiene.generated_changes = entries.filter((entry) => entry.kind === "build_artifact");
  hygiene.runtime_changes = entries.filter((entry) => entry.kind === "runtime_generated");
  hygiene.unexpected_changes = entries.filter((entry) =>
    (entry.kind === "build_artifact" || entry.kind === "runtime_generated") && !entry.ignored
  );
  hygiene.tracked_build_artifacts = entries.filter((entry) => entry.kind === "build_artifact" && entry.tracked);
  hygiene.ignored_untracked_artifacts = entries.filter((entry) => entry.ignored && !entry.tracked);
  hygiene.runtime_generated_files = entries.filter((entry) => entry.kind === "runtime_generated");
  hygiene.suspicious_changes = entries.filter((entry) =>
    (entry.kind === "build_artifact" || entry.kind === "runtime_generated") && !entry.ignored
  );
  hygiene.counts = {
    source_changes: hygiene.source_changes.length,
    dependency_changes: hygiene.dependency_changes.length,
    generated_changes: hygiene.generated_changes.length,
    runtime_changes: hygiene.runtime_changes.length,
    unexpected_changes: hygiene.unexpected_changes.length,
    tracked_build_artifacts: hygiene.tracked_build_artifacts.length,
    ignored_untracked_artifacts: hygiene.ignored_untracked_artifacts.length,
    runtime_generated_files: hygiene.runtime_generated_files.length,
    suspicious_changes: hygiene.suspicious_changes.length,
  };
  return hygiene;
}

function classifyPathKind(path: string, generatedPaths: string[] = DEFAULT_GENERATED_PATHS): ChangedFile["kind"] {
  const normalized = normalizePath(path).toLowerCase();
  const parts = normalized.split("/");
  const basename = parts[parts.length - 1] || "";
  if (basename === "sync-store.json" || /\.(log|tmp|temp|pid)$/.test(basename)) return "runtime_generated";
  if ([
    "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb",
    "poetry.lock", "pipfile.lock", "cargo.lock", "go.sum", "composer.lock",
  ].includes(basename)) return "dependency";
  if (generatedPaths.some((pattern) => matchesGeneratedPath(normalized, pattern))) return "build_artifact";
  if (parts.some((part) => ["dist", "release", "build", "out", "coverage", ".next"].includes(part))) return "build_artifact";
  if (/\.(exe|dll|pak|bin|zip|tgz|tar\.gz|tsbuildinfo|pyc)$/.test(basename)) return "build_artifact";
  return "source";
}

function classificationReason(change: ChangedFile): string {
  if (change.ignored) return "untracked path is ignored by repository Git rules";
  if (change.kind === "build_artifact" && change.tracked) return "artifact-like path is tracked by Git and requires review";
  if (change.kind === "build_artifact") return "artifact-like path is not ignored and requires review";
  if (change.kind === "runtime_generated") return "runtime-generated path is not ignored and requires review";
  if (change.kind === "dependency") return change.tracked ? "tracked dependency lockfile change" : "untracked dependency lockfile change";
  return change.tracked ? "tracked source change" : "untracked source change";
}

export function resolveGeneratedPathPatterns(repoPath: string, configuredPatterns: string[] = []): string[] {
  const patterns = [...DEFAULT_GENERATED_PATHS, ...configuredPatterns];
  for (const filename of [".gitignore", ".npmignore"] as const) {
    const content = readBoundedIgnoreFile(repoPath, filename);
    if (content === null) continue;
    for (const rawLine of content.split(/\r?\n/)) {
      let pattern = rawLine.trim();
      if (!pattern || pattern.startsWith("#") || pattern.startsWith("!")) continue;
      const anchored = pattern.startsWith("/");
      const directoryOnly = pattern.endsWith("/");
      pattern = pattern.replace(/\\ /g, " ").replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\//, "");
      if (directoryOnly) {
        pattern = pattern.replace(/\/$/, "");
        if (!anchored && !pattern.includes("/")) pattern = `**/${pattern}`;
        pattern += "/**";
      }
      if (pattern && pattern.length <= 256 && !pattern.split("/").includes("..") && ARTIFACT_PATTERN_HINT.test(pattern)) {
        patterns.push(pattern);
        if (patterns.length >= DEFAULT_GENERATED_PATHS.length + configuredPatterns.length + MAX_IMPORTED_IGNORE_PATTERNS) break;
      }
    }
  }
  return [...new Set(patterns.map((pattern) => normalizePath(pattern.trim()).replace(/^\.\//, "")).filter(Boolean))];
}

function readBoundedIgnoreFile(repoPath: string, filename: ".gitignore" | ".npmignore"): string | null {
  const repoRoot = resolve(repoPath);
  const ignorePath = join(repoRoot, filename);
  if (!existsSync(ignorePath)) return null;
  try {
    const before = lstatSync(ignorePath);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_IGNORE_FILE_BYTES) return null;
    const realPath = realpathSync(ignorePath);
    const rel = relative(repoRoot, realPath);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith("..")) return null;
    const fd = openSync(realPath, "r");
    let content = "";
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.size > MAX_IGNORE_FILE_BYTES) return null;
      const bytes = Buffer.alloc(opened.size);
      const read = readSync(fd, bytes, 0, bytes.length, 0);
      content = bytes.subarray(0, read).toString("utf-8");
    } finally {
      closeSync(fd);
    }
    const after = lstatSync(ignorePath);
    if (!after.isFile() || after.isSymbolicLink() || after.size !== before.size || after.mtimeMs !== before.mtimeMs) return null;
    return content;
  } catch {
    return null;
  }
}

function mergeRenameKind(
  oldKind: ChangedFile["kind"],
  newKind: ChangedFile["kind"],
): ChangedFile["kind"] {
  if (oldKind === "source" || newKind === "source") return "source";
  if (oldKind === "dependency" || newKind === "dependency") return "dependency";
  if (oldKind === "runtime_generated" || newKind === "runtime_generated") return "runtime_generated";
  return "build_artifact";
}

function matchesGeneratedPath(path: string, rawPattern: string): boolean {
  let pattern = normalizePath(rawPattern.trim()).replace(/^\.\//, "").replace(/^\//, "").toLowerCase();
  if (!pattern) return false;
  if (pattern.endsWith("/")) pattern += "**";
  if (!pattern.includes("/")) {
    const segment = globToRegExp(pattern);
    return path.split("/").some((part) => segment.test(part));
  }
  return globToRegExp(pattern).test(path);
}

function globToRegExp(pattern: string): RegExp {
  let expression = "^";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === "*" && pattern[index + 1] === "*") {
      if (pattern[index + 2] === "/") {
        expression += "(?:.*/)?";
        index += 2;
      } else {
        expression += ".*";
        index += 1;
      }
    } else if (char === "*") {
      expression += "[^/]*";
    } else if (char === "?") {
      expression += "[^/]";
    } else {
      expression += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`${expression}$`, "i");
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

function walkWorkspace(root: string, signal?: AbortSignal): { paths: string[]; truncated: boolean } {
  const result: string[] = [];
  let truncated = false;
  const visit = (directory: string) => {
    throwIfAborted(signal);
    if (result.length >= MAX_SNAPSHOT_FILES) {
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      throw new Error(`snapshot_directory_read_failed: ${relative(root, directory).replace(/\\/g, "/") || "."}`);
    }
    for (const entry of entries) {
      throwIfAborted(signal);
      if (result.length >= MAX_SNAPSHOT_FILES) {
        truncated = true;
        break;
      }
      if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) result.push(relative(root, absolute).replace(/\\/g, "/"));
      else if (entry.isSymbolicLink()) {
        // Links are intentionally omitted from content hashing. Path guards
        // validate them at use time and the snapshot remains content-confined.
        continue;
      }
    }
  };
  visit(root);
  return { paths: result, truncated };
}

function hasSnapshotPathSet(
  values: Set<string>,
  value: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const comparable = comparableSnapshotPath(value, platform);
  return [...values].some((candidate) => comparableSnapshotPath(candidate, platform) === comparable);
}

function walkSensitiveMetadata(root: string, signal?: AbortSignal): {
  files: Record<string, SensitiveFileMetadata>;
  warnings: string[];
  failure_codes: string[];
} {
  const files: Record<string, SensitiveFileMetadata> = {};
  const warnings: string[] = [];
  const failureCodes = new Set<string>();
  let visited = 0;
  const visit = (directory: string) => {
    throwIfAborted(signal);
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      failureCodes.add("sensitive_path_scan_failed");
      warnings.push(`could not scan sensitive paths under: ${relative(root, directory).replace(/\\/g, "/") || "."}`);
      return;
    }
    for (const entry of entries) {
      throwIfAborted(signal);
      if (++visited > MAX_SNAPSHOT_FILES * 4) {
        failureCodes.add("sensitive_path_scan_truncated");
        return;
      }
      if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) continue;
      const absolute = join(directory, entry.name);
      const normalized = relative(root, absolute).replace(/\\/g, "/");
      if (isSensitivePath(normalized)) {
        try {
          const metadata = lstatSync(absolute);
          files[normalized] = {
            size: metadata.size,
            mtime_ms: Math.trunc(metadata.mtimeMs),
            file_type: metadata.isFile() ? "file" : metadata.isDirectory() ? "directory" : "other",
          };
        } catch {
          failureCodes.add("sensitive_path_metadata_failed");
          warnings.push(`could not inspect sensitive path metadata: ${normalized}`);
        }
        // A sensitive directory such as .ssh is represented by directory
        // metadata only. Never descend and enumerate credential filenames.
        if (entry.isDirectory()) continue;
      }
      if (entry.isDirectory()) visit(absolute);
    }
  };
  visit(root);
  return { files, warnings, failure_codes: [...failureCodes] };
}

function assertGitSnapshotResult(
  operation: string,
  result: { status: number | null; stdout: string; stderr: string; truncated: boolean },
): void {
  if (result.truncated) throw new Error(`snapshot_git_${operation}_truncated`);
  if (result.status !== 0) throw new Error(`snapshot_git_${operation}_failed: ${boundedGitError(result)}`);
}

function boundedGitError(result: { status: number | null; stderr: string }): string {
  const message = result.stderr.replace(/[\r\n]+/g, " ").trim().slice(0, 300);
  return `exit=${result.status ?? "spawn_error"}${message ? ` ${message}` : ""}`;
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= values.length) return;
      results[index] = await mapper(values[index]);
    }
  });
  await Promise.all(workers);
  return results;
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
