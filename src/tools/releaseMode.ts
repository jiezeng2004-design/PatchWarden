import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep, isAbsolute } from "node:path";
import { getConfig } from "../config.js";
import {
  checkCiVerified,
  checkGitHubReleaseVerified,
  checkPublishedVerified,
  runReleaseGateCheck,
  type ReleaseStage,
  type ReleaseStageStatus,
} from "../release/releaseGate.js";
import { guardTestCommand } from "../security/commandGuard.js";
import { guardWorkspacePath } from "../security/pathGuard.js";
import {
  commandAllowedByProjectPolicy,
  getProjectPolicySummary,
  isProtectedByProjectPolicy,
  readPackageJson,
  resolveVersionFromPolicy,
  type ProjectPolicySummary,
} from "../policy/projectPolicy.js";

export interface ReleaseCheckInput {
  repo_path: string;
  target_stage?: ReleaseStage;
  package_name?: string;
  version?: string;
  github_repo?: string;
  branch?: string;
}

export interface ReleasePrepareInput {
  repo_path: string;
  required_commands?: string[];
  timeout_seconds?: number;
}

export interface ReleaseVerifyInput {
  repo_path: string;
  package_name?: string;
  version?: string;
  github_repo?: string;
  branch?: string;
}

export interface ReleaseCleanupInput {
  repo_path: string;
  dry_run?: boolean;
  patterns?: string[];
}

export interface ReleaseCommandResult {
  command: string;
  status: "passed" | "failed" | "blocked";
  exit_code: number | null;
  reason: string | null;
}

export interface ReleaseModeResult {
  ok: boolean;
  mode: "release_check" | "release_prepare" | "release_verify" | "release_cleanup";
  repo_path: string;
  resolved_repo_path: string;
  policy: {
    valid: boolean;
    issue_count: number;
    issues: ProjectPolicySummary["issues"];
  };
  summary: Record<string, unknown>;
}

const LOCAL_TIMEOUT_MS = 300000;
const CLEANUP_REPORT_DIR = ".patchwarden/release-cleanup";

export function getProjectPolicyTool(repoPath: string): ProjectPolicySummary {
  return getProjectPolicySummary(repoPath);
}

export async function releaseCheck(input: ReleaseCheckInput): Promise<ReleaseModeResult> {
  const config = getConfig();
  const repoPath = guardWorkspacePath(input.repo_path, config.workspaceRoot);
  const policy = getProjectPolicySummary(input.repo_path);
  const packageJson = readPackageJson(repoPath);
  const version = input.version || safeResolveVersion(repoPath, policy) || packageJson.version || undefined;
  const packageName = input.package_name || packageJson.name || undefined;
  const githubRepo = input.github_repo || packageJson.githubRepo || undefined;
  const branch = input.branch || "main";
  const targetStage = input.target_stage || "local_ready";
  const result = await runReleaseGateCheck(repoPath, targetStage, {
    packageName,
    version,
    githubRepo,
    branch,
  });
  return {
    ok: !result.blocked_reason,
    mode: "release_check",
    repo_path: input.repo_path,
    resolved_repo_path: repoPath,
    policy: summarizePolicy(policy),
    summary: {
      target_stage: targetStage,
      stages: result.stages,
      blocked_reason: result.blocked_reason || null,
      package_name: packageName || null,
      version: version || null,
      github_repo: githubRepo || null,
      branch,
    },
  };
}

export function releasePrepare(input: ReleasePrepareInput): ReleaseModeResult {
  const config = getConfig();
  const repoPath = guardWorkspacePath(input.repo_path, config.workspaceRoot);
  const policy = getProjectPolicySummary(input.repo_path);
  const commands = (input.required_commands && input.required_commands.length > 0)
    ? input.required_commands.map((command) => command.trim()).filter(Boolean)
    : policy.effective_policy.release_mode.required_commands;
  const timeoutMs = Math.min(
    Math.max(Number(input.timeout_seconds || 300) * 1000, 1000),
    LOCAL_TIMEOUT_MS,
  );
  const results: ReleaseCommandResult[] = [];

  if (policy.release_readiness.version_consistent === false) {
    return buildPrepareResult(input.repo_path, repoPath, policy, results, "version_mismatch");
  }

  for (const command of commands) {
    try {
      guardTestCommand(command, config, repoPath);
    } catch (err) {
      results.push({
        command,
        status: "blocked",
        exit_code: null,
        reason: `not_allowlisted: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }
    const projectAllowed = commandAllowedByProjectPolicy(command, policy);
    if (!projectAllowed.allowed) {
      results.push({ command, status: "blocked", exit_code: null, reason: projectAllowed.reason });
      continue;
    }
    try {
      execSync(command, {
        cwd: repoPath,
        encoding: "utf-8",
        timeout: timeoutMs,
        stdio: ["ignore", "pipe", "pipe"],
      });
      results.push({ command, status: "passed", exit_code: 0, reason: null });
    } catch (err) {
      const code = err && typeof err === "object" && "status" in err
        ? Number((err as { status: unknown }).status)
        : null;
      results.push({
        command,
        status: "failed",
        exit_code: Number.isFinite(code) ? code : null,
        reason: err instanceof Error ? err.message.split(/\r?\n/)[0] : String(err),
      });
    }
  }

  return buildPrepareResult(input.repo_path, repoPath, policy, results, null);
}

export async function releaseVerify(input: ReleaseVerifyInput): Promise<ReleaseModeResult> {
  const config = getConfig();
  const repoPath = guardWorkspacePath(input.repo_path, config.workspaceRoot);
  const policy = getProjectPolicySummary(input.repo_path);
  const packageJson = readPackageJson(repoPath);
  const version = input.version || safeResolveVersion(repoPath, policy) || packageJson.version || "";
  const packageName = input.package_name || packageJson.name || "";
  const githubRepo = input.github_repo || packageJson.githubRepo || "";
  const branch = input.branch || "main";
  const stages: Record<"published_verified" | "github_release_verified" | "ci_verified", ReleaseStageStatus> = {
    published_verified: "not_checked",
    github_release_verified: "not_checked",
    ci_verified: "not_checked",
  };
  const reasons: Record<string, string | null> = {};

  if (!packageName || !version) {
    stages.published_verified = "failed";
    reasons.published_verified = "package_name and version are required";
  } else {
    const published = await checkPublishedVerified(packageName, version);
    stages.published_verified = published.status;
    reasons.published_verified = published.reason || null;
  }

  if (!githubRepo || !version) {
    stages.github_release_verified = "failed";
    reasons.github_release_verified = "github_repo and version are required";
  } else {
    const github = await checkGitHubReleaseVerified(githubRepo, `v${version}`);
    stages.github_release_verified = github.status;
    reasons.github_release_verified = github.reason || null;
  }

  if (!githubRepo || !branch) {
    stages.ci_verified = "failed";
    reasons.ci_verified = "github_repo and branch are required";
  } else {
    const ci = await checkCiVerified(githubRepo, branch);
    stages.ci_verified = ci.status;
    reasons.ci_verified = ci.reason || null;
  }

  return {
    ok: Object.values(stages).every((status) => status === "passed" || status === "not_checked"),
    mode: "release_verify",
    repo_path: input.repo_path,
    resolved_repo_path: repoPath,
    policy: summarizePolicy(policy),
    summary: {
      stages,
      reasons,
      package_name: packageName || null,
      version: version || null,
      github_repo: githubRepo || null,
      branch,
      remote_write_performed: false,
    },
  };
}

export function releaseCleanup(input: ReleaseCleanupInput): ReleaseModeResult {
  const config = getConfig();
  const repoPath = guardWorkspacePath(input.repo_path, config.workspaceRoot);
  const policy = getProjectPolicySummary(input.repo_path);
  const dryRun = input.dry_run !== false;
  const cleanupEnabled = policy.effective_policy.auto_cleanup.enabled !== false;
  const patterns = cleanupEnabled && input.patterns && input.patterns.length > 0
    ? input.patterns.map((pattern) => pattern.trim()).filter(Boolean)
    : cleanupEnabled
      ? policy.effective_policy.auto_cleanup.patterns
      : [];
  const candidates = collectCleanupCandidates(repoPath, patterns);
  const removed: string[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];

  for (const candidate of candidates) {
    if (isProtectedByProjectPolicy(candidate.relPath, policy.effective_policy)) {
      skipped.push({ path: candidate.relPath, reason: "protected_or_sensitive" });
      continue;
    }
    if (policy.effective_policy.auto_cleanup.exclude.some((pattern) => matchesPattern(candidate.relPath, pattern))) {
      skipped.push({ path: candidate.relPath, reason: "excluded_by_policy" });
      continue;
    }
    if (isTrackedByGit(repoPath, candidate.relPath)) {
      skipped.push({ path: candidate.relPath, reason: "tracked_by_git" });
      continue;
    }
    if (!isIgnoredOrUntracked(repoPath, candidate.relPath)) {
      skipped.push({ path: candidate.relPath, reason: "not_ignored_or_untracked" });
      continue;
    }
    if (!dryRun) {
      rmSync(candidate.path, { recursive: true, force: true });
    }
    removed.push(candidate.relPath);
  }

  const report = {
    generated_at: new Date().toISOString(),
    dry_run: dryRun,
    patterns,
    cleanup_disabled_by_policy: !cleanupEnabled,
    removed,
    skipped,
    candidate_count: candidates.length,
  };
  const reportDir = join(repoPath, CLEANUP_REPORT_DIR);
  mkdirSync(reportDir, { recursive: true });
  const reportPath = join(reportDir, `${report.generated_at.replace(/[-:.TZ]/g, "").slice(0, 14)}.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", "utf-8");

  return {
    ok: skipped.length === 0 || dryRun,
    mode: "release_cleanup",
    repo_path: input.repo_path,
    resolved_repo_path: repoPath,
    policy: summarizePolicy(policy),
    summary: {
      ...report,
      report_path: relative(repoPath, reportPath).replace(/\\/g, "/"),
    },
  };
}

function buildPrepareResult(
  repoPathInput: string,
  repoPath: string,
  policy: ProjectPolicySummary,
  commands: ReleaseCommandResult[],
  blockedReason: string | null,
): ReleaseModeResult {
  const blocked = commands.some((entry) => entry.status === "blocked");
  const failed = commands.some((entry) => entry.status === "failed");
  return {
    ok: !blockedReason && !blocked && !failed,
    mode: "release_prepare",
    repo_path: repoPathInput,
    resolved_repo_path: repoPath,
    policy: summarizePolicy(policy),
    summary: {
      blocked_reason: blockedReason,
      version_source: policy.release_readiness.version_source,
      version: policy.release_readiness.version,
      package_json_version: policy.release_readiness.package_json_version,
      version_consistent: policy.release_readiness.version_consistent,
      commands,
      remote_write_performed: false,
    },
  };
}

function summarizePolicy(policy: ProjectPolicySummary): ReleaseModeResult["policy"] {
  return {
    valid: policy.valid,
    issue_count: policy.issues.length,
    issues: policy.issues.slice(0, 20),
  };
}

function safeResolveVersion(repoPath: string, policy: ProjectPolicySummary): string | null {
  try {
    return resolveVersionFromPolicy(repoPath, policy.effective_policy);
  } catch {
    return null;
  }
}

function collectCleanupCandidates(repoPath: string, patterns: string[]): Array<{ path: string; relPath: string }> {
  const candidates = new Map<string, string>();
  for (const pattern of patterns) {
    const normalized = normalizeRel(pattern);
    if (!normalized || normalized.includes("..") || isAbsolute(normalized)) continue;
    if (normalized.includes("*")) {
      walk(repoPath, (fullPath, relPath) => {
        if (matchesPattern(relPath, normalized)) candidates.set(relPath, fullPath);
      });
      continue;
    }
    const fullPath = resolve(repoPath, normalized);
    const relPath = toRepoRelative(repoPath, fullPath);
    if (relPath && existsSync(fullPath)) candidates.set(relPath, fullPath);
  }
  return [...candidates].map(([relPath, path]) => ({ path, relPath }));
}

function walk(root: string, visit: (path: string, relPath: string) => void): void {
  walkFrom(root, root, visit);
}

function walkFrom(base: string, dir: string, visit: (path: string, relPath: string) => void): void {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    const repoRel = toRepoRelative(base, fullPath);
    if (!repoRel || repoRel.startsWith(".git/") || repoRel.startsWith("node_modules/")) continue;
    visit(fullPath, repoRel);
    if (entry.isDirectory()) walkFrom(base, fullPath, visit);
  }
}

function isTrackedByGit(root: string, relPath: string): boolean {
  if (!isGitWorktree(root)) return false;
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", "--", relPath], {
      cwd: root,
      stdio: "ignore",
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

function isIgnoredOrUntracked(root: string, relPath: string): boolean {
  if (!isGitWorktree(root)) return true;
  try {
    execFileSync("git", ["check-ignore", "-q", "--", relPath], {
      cwd: root,
      stdio: "ignore",
      windowsHide: true,
    });
    return true;
  } catch {
    try {
      const output = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "--", relPath], {
        cwd: root,
        encoding: "utf-8",
        windowsHide: true,
      });
      return output.trim().split(/\r?\n/).filter(Boolean).includes(relPath);
    } catch {
      return false;
    }
  }
}

function isGitWorktree(root: string): boolean {
  try {
    return execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: root,
      encoding: "utf-8",
      windowsHide: true,
    }).trim() === "true";
  } catch {
    return false;
  }
}

function toRepoRelative(root: string, target: string): string {
  const rel = relative(resolve(root), resolve(target));
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) return "";
  return rel.replace(/\\/g, "/");
}

function normalizeRel(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function matchesPattern(relPath: string, pattern: string): boolean {
  const normalized = normalizeRel(pattern);
  if (!normalized) return false;
  if (!normalized.includes("*")) {
    return relPath.toLowerCase() === normalized.toLowerCase() ||
      relPath.toLowerCase().startsWith(`${normalized.toLowerCase()}/`);
  }
  const escaped = normalized
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]*");
  return new RegExp(`^${escaped}$`, "i").test(relPath);
}
