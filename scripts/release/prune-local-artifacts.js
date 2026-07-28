#!/usr/bin/env node
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_RETENTION_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const CORE_VERSION = "[0-9]+\\.[0-9]+\\.[0-9]+";
const VERSION = "[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?";
const ROOT_ARTIFACT_RE = new RegExp(`^PatchWarden-v(${VERSION})(?:\\.zip|\\.tar\\.gz)$`, "i");
const ROOT_CHECKSUM_RE = /^PatchWarden(?:-v[0-9A-Za-z.-]+)?-SHA256SUMS\.txt$/i;
const ROOT_CURRENT_ALIASES = new Set(["patchwarden-release.tar.gz"]);
const DESKTOP_ARTIFACT_RE = new RegExp(`^PatchWarden-(?:Portable|Setup)-(${VERSION})-x64\\.(?:zip|exe)(?:\\.blockmap)?$`, "i");
const RELEASE_BUILD_RE = new RegExp(`^desktop-(?:preflight|cua)-(${CORE_VERSION})(?:-|$)`, "i");
const SEMVER_IN_NAME_RE = new RegExp(`(?:^|[^0-9])(${CORE_VERSION})(?:[^0-9]|$)`, "i");

const LEGACY_RELEASE_ENTRIES = new Set([
  ".gitignore",
  "CONTRIBUTORS.md",
  "LICENSE",
  "PatchWarden-Control-Tray.cmd",
  "PatchWarden-Control.cmd",
  "PatchWarden-Desktop.cmd",
  "PatchWarden.cmd",
  "README.en.md",
  "README.md",
  "Restart-PatchWarden-Control.cmd",
  "Stop-PatchWarden.cmd",
  "dist",
  "docs",
  "examples",
  "package-lock.json",
  "package.json",
  "scripts",
  "src",
  "tsconfig.json",
  "ui",
]);

export function parseArgs(argv) {
  const options = { apply: false, days: DEFAULT_RETENTION_DAYS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") {
      options.apply = true;
      continue;
    }
    if (arg === "--days") {
      if (i + 1 >= argv.length) throw new Error("--days requires a positive integer");
      options.days = parseDays(argv[++i]);
      continue;
    }
    if (arg.startsWith("--days=")) {
      options.days = parseDays(arg.slice("--days=".length));
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

export function pruneLocalArtifacts({
  root,
  days = DEFAULT_RETENTION_DAYS,
  apply = false,
  now = new Date(),
  removePath = defaultRemovePath,
} = {}) {
  const workspaceRoot = resolve(root || resolve(fileURLToPath(new URL("../..", import.meta.url))));
  const retentionDays = parseDays(String(days));
  const nowDate = toValidDate(now, "now");
  const cutoff = new Date(nowDate.getTime() - retentionDays * DAY_MS);
  const currentVersion = readPackageVersion(join(workspaceRoot, "package.json"), true);
  const releaseRoot = join(workspaceRoot, "release");
  const tagDates = readTagDates(workspaceRoot);
  const summary = {
    ok: true,
    mode: apply ? "apply" : "dry-run",
    workspace_root: workspaceRoot,
    current_version: currentVersion,
    retention_days: retentionDays,
    now: nowDate.toISOString(),
    cutoff: cutoff.toISOString(),
    candidates: [],
    protected: [],
    errors: [],
    deleted: [],
    failed: [],
    candidate_bytes: 0,
    deleted_bytes: 0,
  };

  const addArtifact = (path, metadata) => {
    const absolutePath = resolve(path);
    const relativePath = toPosix(relative(workspaceRoot, absolutePath));
    let stats;
    try {
      stats = lstatSync(absolutePath);
    } catch (error) {
      summary.errors.push({ path: relativePath, reason: "unreadable_candidate", error: errorMessage(error) });
      return;
    }

    const reference = chooseReferenceTime({
      name: metadata.name,
      version: metadata.version,
      stats,
      tagDates,
      preferNameTime: metadata.preferNameTime === true,
      fallbackDate: metadata.fallbackDate,
      fallbackSource: metadata.fallbackSource,
    });
    const record = {
      path: relativePath,
      kind: metadata.kind,
      version: metadata.version || null,
      reference_time: reference.date.toISOString(),
      age_source: reference.source,
      reason: metadata.reason || null,
    };

    if (metadata.version === currentVersion) {
      summary.protected.push({ ...record, reason: "current_version" });
      return;
    }
    if (reference.date.getTime() >= cutoff.getTime()) {
      summary.protected.push({ ...record, reason: "within_retention_window" });
      return;
    }

    try {
      const inspected = inspectDeletionTarget(absolutePath, metadata.scopeRoot);
      const candidate = { ...record, bytes: inspected.bytes, absolute_path: absolutePath, scope_root: metadata.scopeRoot };
      summary.candidates.push(candidate);
      summary.candidate_bytes += inspected.bytes;
    } catch (error) {
      summary.errors.push({ path: relativePath, reason: "unsafe_candidate", error: errorMessage(error) });
    }
  };

  discoverRootArtifacts(workspaceRoot, addArtifact, summary);
  if (existsSync(releaseRoot)) {
    try {
      inspectContainerRoot(releaseRoot, workspaceRoot);
      discoverReleaseArtifacts(workspaceRoot, releaseRoot, currentVersion, addArtifact, summary);
    } catch (error) {
      summary.errors.push({
        path: "release",
        reason: "unsafe_container",
        error: errorMessage(error),
      });
    }
  }

  if (summary.errors.length > 0) {
    summary.ok = false;
  } else if (apply) {
    for (const candidate of summary.candidates) {
      try {
        inspectDeletionTarget(candidate.absolute_path, candidate.scope_root);
        removePath(candidate.absolute_path, candidate);
        if (existsSync(candidate.absolute_path)) {
          throw new Error("removal did not remove the candidate path");
        }
        summary.deleted.push(stripInternal(candidate));
        summary.deleted_bytes += candidate.bytes;
      } catch (error) {
        summary.failed.push({ path: candidate.path, reason: "delete_failed", error: errorMessage(error) });
        summary.ok = false;
        break;
      }
    }
  }

  summary.candidates = summary.candidates.map(stripInternal);
  return summary;
}

function discoverRootArtifacts(root, addArtifact, summary) {
  for (const entry of safeReadDir(root)) {
    if (!entry.isFile() && !entry.isSymbolicLink() && !entry.isDirectory()) continue;
    if (ROOT_CURRENT_ALIASES.has(entry.name.toLowerCase())) {
      summary.protected.push(protectedRecord(root, join(root, entry.name), "current_version_alias"));
      continue;
    }
    if (ROOT_CHECKSUM_RE.test(entry.name)) {
      summary.protected.push(protectedRecord(root, join(root, entry.name), "checksum_manifest"));
      continue;
    }
    const match = entry.name.match(ROOT_ARTIFACT_RE);
    if (!match) continue;
    addArtifact(join(root, entry.name), {
      kind: "versioned_release_archive",
      name: entry.name,
      version: match[1],
      scopeRoot: root,
    });
  }
}

function discoverReleaseArtifacts(workspaceRoot, releaseRoot, currentVersion, addArtifact, summary) {
  const legacyPackagePath = join(releaseRoot, "package.json");
  const legacyVersion = readPackageVersion(legacyPackagePath, false);
  const legacyFallbackDate = legacyVersion ? lstatSync(legacyPackagePath).mtime : null;
  const handledLegacyEntries = new Set();
  if (legacyVersion) {
    for (const name of LEGACY_RELEASE_ENTRIES) {
      const path = join(releaseRoot, name);
      if (!existsSync(path)) continue;
      handledLegacyEntries.add(name);
      addArtifact(path, {
        kind: "legacy_release_snapshot",
        name,
        version: legacyVersion,
        fallbackDate: legacyFallbackDate,
        fallbackSource: "legacy_package_modified_time",
        scopeRoot: releaseRoot,
      });
    }
  }

  for (const entry of safeReadDir(releaseRoot)) {
    if (handledLegacyEntries.has(entry.name)) continue;
    const path = join(releaseRoot, entry.name);
    if (entry.name === "package") {
      summary.protected.push(protectedRecord(workspaceRoot, path, "current_package_staging"));
      continue;
    }
    if (entry.name === "desktop") {
      try {
        inspectContainerRoot(path, releaseRoot);
        discoverDesktopArtifacts(workspaceRoot, path, addArtifact, summary);
      } catch (error) {
        summary.errors.push({
          path: toPosix(relative(workspaceRoot, path)),
          reason: "unsafe_container",
          error: errorMessage(error),
        });
      }
      continue;
    }
    const buildMatch = entry.name.match(RELEASE_BUILD_RE);
    if (buildMatch) {
      addArtifact(path, {
        kind: "desktop_intermediate_build",
        name: entry.name,
        version: buildMatch[1],
        preferNameTime: true,
        scopeRoot: releaseRoot,
      });
      continue;
    }
    summary.protected.push(protectedRecord(workspaceRoot, path, "unrecognized_release_entry"));
  }

  if (legacyVersion === currentVersion) {
    summary.protected.push({ path: "release/package.json", kind: "legacy_release_snapshot", version: currentVersion, reason: "current_version" });
  }
}

function discoverDesktopArtifacts(workspaceRoot, desktopRoot, addArtifact, summary) {
  for (const entry of safeReadDir(desktopRoot)) {
    const path = join(desktopRoot, entry.name);
    if (entry.name === "win-unpacked") {
      summary.protected.push(protectedRecord(workspaceRoot, path, "current_desktop_runtime"));
      continue;
    }
    const artifactMatch = entry.name.match(DESKTOP_ARTIFACT_RE);
    if (artifactMatch) {
      addArtifact(path, {
        kind: "desktop_release_artifact",
        name: entry.name,
        version: artifactMatch[1],
        scopeRoot: desktopRoot,
      });
      continue;
    }
    if (entry.name.startsWith("smoke-")) {
      const versionMatch = entry.name.match(SEMVER_IN_NAME_RE);
      addArtifact(path, {
        kind: "desktop_smoke_artifact",
        name: entry.name,
        version: versionMatch ? versionMatch[1] : null,
        preferNameTime: true,
        scopeRoot: desktopRoot,
      });
      continue;
    }
    summary.protected.push(protectedRecord(workspaceRoot, path, "unrecognized_desktop_entry"));
  }
}

function inspectDeletionTarget(path, scopeRoot) {
  const absolutePath = resolve(path);
  const absoluteScope = resolve(scopeRoot);
  if (!isWithin(absoluteScope, absolutePath)) {
    throw new Error(`candidate escapes allowed scope: ${absolutePath}`);
  }
  const stats = lstatSync(absolutePath);
  if (stats.isSymbolicLink()) throw new Error(`candidate is a symbolic link or junction: ${absolutePath}`);
  const realPath = realpathSync.native(absolutePath);
  if (!isWithin(realpathSync.native(absoluteScope), realPath)) {
    throw new Error(`candidate resolves outside allowed scope: ${absolutePath}`);
  }
  return { bytes: inspectTree(absolutePath) };
}

function inspectContainerRoot(path, parentRoot) {
  const absolutePath = resolve(path);
  const absoluteParent = resolve(parentRoot);
  if (!isWithin(absoluteParent, absolutePath)) {
    throw new Error(`container escapes allowed parent: ${absolutePath}`);
  }
  const stats = lstatSync(absolutePath);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`container is not a real directory: ${absolutePath}`);
  }
  const realParent = realpathSync.native(absoluteParent);
  const realPath = realpathSync.native(absolutePath);
  if (!isWithin(realParent, realPath)) {
    throw new Error(`container resolves outside allowed parent: ${absolutePath}`);
  }
}

function inspectTree(path) {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) throw new Error(`candidate tree contains a symbolic link or junction: ${path}`);
  if (!stats.isDirectory()) return stats.size;
  let bytes = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    bytes += inspectTree(join(path, entry.name));
  }
  return bytes;
}

function chooseReferenceTime({ name, version, stats, tagDates, preferNameTime, fallbackDate, fallbackSource }) {
  const nameDate = extractNameDate(name);
  if (preferNameTime) {
    return nameDate
      ? { date: nameDate, source: "artifact_name" }
      : { date: stats.mtime, source: "modified_time" };
  }
  if (version && tagDates.has(version)) return { date: tagDates.get(version), source: "git_tag" };
  if (nameDate) return { date: nameDate, source: "artifact_name" };
  if (fallbackDate) return { date: fallbackDate, source: fallbackSource || "fallback_time" };
  return { date: stats.mtime, source: "modified_time" };
}

function extractNameDate(name) {
  let match = name.match(/(20\d{6})T(\d{6})Z/);
  if (match) {
    const parts = dateParts(match[1], match[2]);
    const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second));
    return Number.isNaN(date.getTime()) ? null : date;
  }
  match = name.match(/(20\d{6})[-T](\d{4,6})(?:\D|$)/);
  if (match) {
    const parts = dateParts(match[1], match[2].padEnd(6, "0"));
    const date = new Date(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  match = name.match(/(20\d{6})(?:\D|$)/);
  if (!match) return null;
  const parts = dateParts(match[1], "235959");
  const date = new Date(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, 999);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dateParts(date, time) {
  return {
    year: Number(date.slice(0, 4)),
    month: Number(date.slice(4, 6)),
    day: Number(date.slice(6, 8)),
    hour: Number(time.slice(0, 2)),
    minute: Number(time.slice(2, 4)),
    second: Number(time.slice(4, 6)),
  };
}

function readTagDates(root) {
  const dates = new Map();
  try {
    const output = execFileSync(
      "git",
      ["for-each-ref", "--format=%(refname:strip=2)%09%(creatordate:iso-strict)", "refs/tags/v*"],
      { cwd: root, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
    );
    for (const line of output.split(/\r?\n/)) {
      const [tag, rawDate] = line.split("\t");
      if (!tag || !rawDate || !tag.startsWith("v")) continue;
      const date = new Date(rawDate);
      if (!Number.isNaN(date.getTime())) dates.set(tag.slice(1), date);
    }
  } catch {
    // Artifact mtimes remain the bounded offline fallback outside a Git checkout.
  }
  return dates;
}

function readPackageVersion(path, required) {
  if (!existsSync(path)) {
    if (required) throw new Error(`Missing package.json: ${path}`);
    return null;
  }
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    if (required) throw new Error(`Unsafe package.json path: ${path}`);
    return null;
  }
  try {
    const value = JSON.parse(readFileSync(path, "utf-8"));
    if (typeof value.version === "string" && new RegExp(`^${VERSION}$`).test(value.version)) return value.version;
  } catch (error) {
    if (required) throw error;
  }
  if (required) throw new Error(`package.json has no valid version: ${path}`);
  return null;
}

function parseDays(value) {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`Retention days must be a positive integer: ${value}`);
  const days = Number(value);
  if (!Number.isSafeInteger(days)) throw new Error(`Retention days are too large: ${value}`);
  return days;
}

function toValidDate(value, label) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${label} must be a valid date`);
  return date;
}

function isWithin(root, path) {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && rel !== ".." && !isAbsolute(rel);
}

function safeReadDir(path) {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

function protectedRecord(workspaceRoot, path, reason) {
  return { path: toPosix(relative(workspaceRoot, path)), kind: "protected", version: null, reason };
}

function stripInternal(candidate) {
  const { absolute_path, scope_root, ...publicRecord } = candidate;
  return publicRecord;
}

function defaultRemovePath(path) {
  rmSync(path, { recursive: true, force: false, maxRetries: 3, retryDelay: 100 });
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function toPosix(path) {
  return path.replace(/\\/g, "/");
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const summary = pruneLocalArtifacts({ ...options });
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    if (!summary.ok) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`[release-prune] ${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
