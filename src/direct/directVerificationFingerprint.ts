import { createHash } from "node:crypto";
import {
  lstatSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { captureRepoSnapshot, type RepoSnapshot } from "../runner/changeCapture.js";
import { PatchWardenError } from "../errors.js";
import { isSensitivePath } from "../security/sensitiveGuard.js";
import { stableJsonStringify } from "../utils/stableJson.js";
import { hashStableRegularFileSync } from "../utils/stableFileRead.js";

const FINGERPRINT_VERSION = "direct-verification-workspace-v2";
const DEPENDENCY_FINGERPRINT_VERSION = "direct-verification-dependencies-v1";
const MAX_DEPENDENCY_ENTRIES = 150_000;
const MAX_DEPENDENCY_FILE_BYTES = 64 * 1024 * 1024;
const MAX_DEPENDENCY_HASH_BYTES = 512 * 1024 * 1024;
const ABSENT_DEPENDENCY_TREE_SHA256 = createHash("sha256")
  .update(stableJsonStringify({ version: DEPENDENCY_FINGERPRINT_VERSION, state: "absent" }))
  .digest("hex");

export interface DirectVerificationFingerprintDependencies {
  /** Test-only hook used to prove that a changed second sample is rejected. */
  afterFirstSample?: () => void | Promise<void>;
}

export async function captureDirectVerificationWorkspaceSha256(
  repoPath: string,
  dependencies: DirectVerificationFingerprintDependencies = {},
): Promise<string> {
  const first = await captureDirectVerificationWorkspaceSampleSha256(repoPath);
  await dependencies.afterFirstSample?.();
  const second = await captureDirectVerificationWorkspaceSampleSha256(repoPath);
  if (first !== second) {
    throw dependencySnapshotError("workspace_changed_during_snapshot");
  }
  return second;
}

async function captureDirectVerificationWorkspaceSampleSha256(
  repoPath: string,
): Promise<string> {
  const snapshot = await captureRepoSnapshot(repoPath);
  assertDirectVerificationSnapshotComplete(snapshot);
  const dependencyTreeSha256 = captureDirectVerificationDependencyTreeSha256(repoPath);
  return computeDirectVerificationWorkspaceSha256(snapshot, dependencyTreeSha256);
}

export function assertDirectVerificationSnapshotComplete(
  snapshot: RepoSnapshot,
): void {
  const incompleteWarnings = snapshot.warnings.filter((warning) =>
    warning.startsWith("snapshot limited to ")
    || warning.startsWith("could not fingerprint:")
    || warning.startsWith("snapshot incomplete:"),
  );
  const approximateFiles = Object.values(snapshot.files).filter((fingerprint) =>
    fingerprint.sha256.startsWith("large-file:")
    || fingerprint.resolved_target_sha256?.startsWith("large-file:"),
  );
  if (incompleteWarnings.length > 0 || approximateFiles.length > 0) {
    throw new PatchWardenError(
      "direct_review_workspace_snapshot_incomplete",
      "The repository snapshot is incomplete, so verification semantics cannot be bound to a review grant.",
      "Reduce the repository snapshot scope or fix unreadable files, then request a new Direct review.",
      true,
      { warning_count: incompleteWarnings.length, approximate_file_count: approximateFiles.length },
    );
  }
}

export function computeDirectVerificationWorkspaceSha256(
  snapshot: RepoSnapshot,
  dependencyTreeSha256 = ABSENT_DEPENDENCY_TREE_SHA256,
): string {
  const files = Object.entries(snapshot.files)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, fingerprint]) => ({
      path,
      size: fingerprint.size,
      sha256: fingerprint.sha256,
      link_target_sha256: fingerprint.link_target_sha256 ?? null,
      resolved_target_sha256: fingerprint.resolved_target_sha256 ?? null,
    }));
  return createHash("sha256").update(stableJsonStringify({
    version: FINGERPRINT_VERSION,
    is_git: snapshot.is_git,
    head: snapshot.head,
    files,
    // The normal repository snapshot intentionally excludes node_modules. A
    // separate, bounded content digest binds installed dependency semantics
    // for Direct verification without retaining dependency contents.
    dependency_tree_sha256: dependencyTreeSha256,
  })).digest("hex");
}

function captureDirectVerificationDependencyTreeSha256(repoPath: string): string {
  const repoRoot = resolve(repoPath);
  const dependencyRoot = join(repoRoot, "node_modules");
  let rootInfo: Stats;
  try {
    rootInfo = lstatSync(dependencyRoot);
  } catch (error) {
    if (isNotFound(error)) {
      return ABSENT_DEPENDENCY_TREE_SHA256;
    }
    throw dependencySnapshotError("dependency_root_unreadable");
  }

  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || !isCanonicalPath(dependencyRoot)) {
    throw dependencySnapshotError("dependency_root_indirect");
  }

  const digest = createHash("sha256");
  digest.update(`${DEPENDENCY_FINGERPRINT_VERSION}\0`);
  let entries = 0;
  let hashedBytes = 0;

  const addEntry = (entry: Record<string, unknown>) => {
    entries += 1;
    if (entries > MAX_DEPENDENCY_ENTRIES) throw dependencySnapshotError("dependency_entry_limit");
    digest.update(stableJsonStringify(entry));
    digest.update("\n");
  };

  const hashFile = (path: string, logicalPath: string, before: Stats): string => {
    if (!before.isFile() || before.isSymbolicLink()) {
      throw dependencySnapshotError("dependency_file_kind_changed");
    }
    if (before.size > MAX_DEPENDENCY_FILE_BYTES || hashedBytes + before.size > MAX_DEPENDENCY_HASH_BYTES) {
      throw dependencySnapshotError("dependency_hash_limit");
    }
    let sha256: string;
    try {
      sha256 = hashStableRegularFileSync(path, before, MAX_DEPENDENCY_FILE_BYTES);
    } catch {
      throw dependencySnapshotError("dependency_file_changed_during_snapshot");
    }
    hashedBytes += before.size;
    addEntry({ path: logicalPath, kind: "file", size: before.size, sha256 });
    return sha256;
  };

  const visit = (directory: string, expectedDirectory: Stats) => {
    if (!isStableCanonicalDirectory(directory, expectedDirectory)) {
      throw dependencySnapshotError("dependency_directory_changed_during_snapshot");
    }
    let directoryEntries;
    try {
      directoryEntries = readdirSync(directory, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name));
    } catch {
      throw dependencySnapshotError("dependency_directory_unreadable");
    }
    if (!isStableCanonicalDirectory(directory, expectedDirectory)) {
      throw dependencySnapshotError("dependency_directory_changed_during_snapshot");
    }
    for (const directoryEntry of directoryEntries) {
      const absolutePath = join(directory, directoryEntry.name);
      const logicalPath = relativeToRepo(repoRoot, absolutePath);
      if (!logicalPath || isSensitivePath(logicalPath)) {
        throw dependencySnapshotError("dependency_sensitive_or_escaped_path");
      }
      let info: Stats;
      try {
        info = lstatSync(absolutePath);
      } catch {
        throw dependencySnapshotError("dependency_entry_unreadable");
      }
      if (info.isSymbolicLink()) {
        addEntry(fingerprintDependencyLink(repoRoot, absolutePath, logicalPath));
        continue;
      }
      if (!isCanonicalRepositoryPath(repoRoot, absolutePath)) {
        throw dependencySnapshotError("dependency_entry_escaped");
      }
      if (info.isDirectory()) {
        // A junction can present as a directory. Do not recurse through an
        // indirect tree whose target can change outside this fingerprint.
        if (!isCanonicalPath(absolutePath)) throw dependencySnapshotError("dependency_directory_indirect");
        addEntry({ path: logicalPath, kind: "directory" });
        visit(absolutePath, info);
        continue;
      }
      if (info.isFile()) {
        hashFile(absolutePath, logicalPath, info);
        continue;
      }
      throw dependencySnapshotError("dependency_special_file");
    }
    if (!isStableCanonicalDirectory(directory, expectedDirectory)
      || !sameDirectoryEntryNames(directoryEntries, directory)) {
      throw dependencySnapshotError("dependency_directory_changed_during_snapshot");
    }
  };

  addEntry({ path: "node_modules", kind: "directory" });
  visit(dependencyRoot, rootInfo);
  return digest.digest("hex");
}

function fingerprintDependencyLink(
  repoRoot: string,
  linkPath: string,
  logicalPath: string,
): Record<string, unknown> {
  let linkText: string;
  let resolvedTarget: string;
  try {
    linkText = readlinkSync(linkPath);
    resolvedTarget = realpathSync(linkPath);
  } catch {
    throw dependencySnapshotError("dependency_link_unreadable");
  }
  const targetPath = relativeToRepo(repoRoot, resolvedTarget);
  if (!targetPath || isSensitivePath(targetPath) || isInternalPatchWardenPath(targetPath)) {
    throw dependencySnapshotError("dependency_link_target_unbound");
  }
  let targetInfo: Stats;
  try {
    targetInfo = lstatSync(resolvedTarget);
  } catch {
    throw dependencySnapshotError("dependency_link_target_unreadable");
  }
  if (!targetInfo.isFile() && !targetInfo.isDirectory()) {
    throw dependencySnapshotError("dependency_link_target_kind");
  }
  return {
    path: logicalPath,
    kind: "link",
    link_target_sha256: createHash("sha256").update(linkText, "utf-8").digest("hex"),
    resolved_target_path: targetPath,
    resolved_target_kind: targetInfo.isFile() ? "file" : "directory",
  };
}

function relativeToRepo(repoRoot: string, path: string): string | null {
  const resolved = resolve(path);
  const rel = relative(repoRoot, resolved);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    return null;
  }
  return rel.replace(/\\/g, "/");
}

function isCanonicalPath(path: string): boolean {
  try {
    const canonical = realpathSync(path);
    const expected = resolve(path);
    return process.platform === "win32"
      ? canonical.toLowerCase() === expected.toLowerCase()
      : canonical === expected;
  } catch {
    return false;
  }
}

function isCanonicalRepositoryPath(repoRoot: string, path: string): boolean {
  try {
    return relativeToRepo(repoRoot, realpathSync(path)) !== null;
  } catch {
    return false;
  }
}

function isStableCanonicalDirectory(path: string, expected: Stats): boolean {
  try {
    const current = lstatSync(path);
    return current.isDirectory()
      && !current.isSymbolicLink()
      && isCanonicalPath(path)
      && sameFileIdentity(expected, current);
  } catch {
    return false;
  }
}

function sameDirectoryEntryNames(
  expectedEntries: Array<{ name: string }>,
  directory: string,
): boolean {
  try {
    const actual = readdirSync(directory, { withFileTypes: true })
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
    const expected = expectedEntries
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
    return actual.length === expected.length && actual.every((entry, index) => entry === expected[index]);
  } catch {
    return false;
  }
}

function isInternalPatchWardenPath(path: string): boolean {
  const firstSegment = path.replace(/\\/g, "/").split("/")[0]?.toLowerCase();
  return firstSegment === ".patchwarden" || firstSegment === ".git";
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT");
}

function dependencySnapshotError(reason: string): PatchWardenError {
  return new PatchWardenError(
    "direct_review_workspace_snapshot_incomplete",
    "The installed dependency state cannot be fully bound to this Direct verification review.",
    "Use a complete, readable dependency tree without links outside the repository, then request a new Direct review.",
    true,
    { dependency_snapshot_reason: reason },
  );
}

