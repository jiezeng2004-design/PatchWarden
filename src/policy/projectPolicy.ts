import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  getAllConfiguredDirectCommands,
  getAllConfiguredTestCommands,
  getConfig,
  type PatchWardenConfig,
} from "../config.js";
import { guardTestCommand } from "../security/commandGuard.js";
import { guardWorkspacePath } from "../security/pathGuard.js";
import { isSensitivePath } from "../security/sensitiveGuard.js";

export interface ProjectPolicy {
  allowed_commands: string[];
  auto_cleanup: {
    enabled: boolean;
    patterns: string[];
    exclude: string[];
  };
  high_risk_commands: string[];
  protected_paths: string[];
  release_mode: {
    version_source: string;
    required_commands: string[];
  };
}

export interface ProjectPolicyIssue {
  code: string;
  severity: "error" | "warn";
  field: string;
  message: string;
}

export interface ReleaseReadinessSummary {
  version_source: string;
  version: string | null;
  package_json_version: string | null;
  package_name: string | null;
  version_consistent: boolean | null;
  required_commands: Array<{
    command: string;
    allowed: boolean;
    reason: string | null;
  }>;
}

export interface ProjectPolicySummary {
  repo_path: string;
  resolved_repo_path: string;
  policy_path: string;
  exists: boolean;
  valid: boolean;
  effective_policy: ProjectPolicy;
  issues: ProjectPolicyIssue[];
  release_readiness: ReleaseReadinessSummary;
}

const DEFAULT_POLICY: ProjectPolicy = {
  allowed_commands: [],
  auto_cleanup: {
    enabled: true,
    patterns: ["release-artifact-manifest.json", "frontend/dist", "release_packages"],
    exclude: [".git", ".patchwarden", "node_modules", "docs", "samples"],
  },
  high_risk_commands: ["npm publish", "git push", "git tag", "gh release create"],
  protected_paths: [".env", ".env.*", ".ssh", ".npmrc", ".pypirc", "patchwarden.config.json"],
  release_mode: {
    version_source: "package.json",
    required_commands: ["npm run build", "npm test"],
  },
};

const DANGEROUS_COMMAND_RE = /\b(?:publish|push|tag|release\s+create|deploy)\b/i;
const DANGEROUS_PATTERN_RE = /(^|[\\/])(?:\.git|node_modules)([\\/]|$)|^\*\*$|^\/|^[A-Za-z]:[\\/]/i;

export function getProjectPolicySummary(repoPathInput: string): ProjectPolicySummary {
  const config = getConfig();
  const repoPath = guardWorkspacePath(repoPathInput, config.workspaceRoot);
  const policyPath = join(repoPath, ".patchwarden", "project-policy.json");
  const issues: ProjectPolicyIssue[] = [];
  let rawPolicy: Partial<ProjectPolicy> = {};
  let exists = false;

  if (existsSync(policyPath)) {
    exists = true;
    try {
      const raw = readFileSync(policyPath, "utf-8").replace(/^\uFEFF/, "");
      rawPolicy = JSON.parse(raw) as Partial<ProjectPolicy>;
    } catch (err) {
      issues.push({
        code: "policy_json_invalid",
        severity: "error",
        field: ".patchwarden/project-policy.json",
        message: `Project policy is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  const effective = normalizePolicy(rawPolicy, issues);
  validateProjectPolicy(repoPath, effective, issues, config);

  return {
    repo_path: repoPathInput,
    resolved_repo_path: repoPath,
    policy_path: ".patchwarden/project-policy.json",
    exists,
    valid: !issues.some((issue) => issue.severity === "error"),
    effective_policy: effective,
    issues,
    release_readiness: buildReleaseReadiness(repoPath, effective, config),
  };
}

export function getDefaultProjectPolicy(): ProjectPolicy {
  return clonePolicy(DEFAULT_POLICY);
}

export function commandAllowedByProjectPolicy(command: string, summary: ProjectPolicySummary): { allowed: boolean; reason: string | null } {
  const trimmed = command.trim();
  if (!trimmed) return { allowed: false, reason: "empty_command" };
  if (summary.effective_policy.high_risk_commands.includes(trimmed) || DANGEROUS_COMMAND_RE.test(trimmed)) {
    return { allowed: false, reason: "high_risk_command" };
  }
  if (
    summary.effective_policy.allowed_commands.length > 0 &&
    !summary.effective_policy.allowed_commands.includes(trimmed)
  ) {
    return { allowed: false, reason: "not_in_project_policy_allowed_commands" };
  }
  const readiness = summary.release_readiness.required_commands.find((entry) => entry.command === trimmed);
  if (readiness && !readiness.allowed) {
    return { allowed: false, reason: readiness.reason || "not_allowlisted_by_patchwarden_config" };
  }
  return { allowed: true, reason: null };
}

export function isProtectedByProjectPolicy(relPath: string, policy: ProjectPolicy): boolean {
  const normalized = normalizeRelPath(relPath);
  if (!normalized) return true;
  if (isSensitivePath(normalized)) return true;
  return policy.protected_paths.some((pattern) => pathMatchesPattern(normalized, pattern));
}

export function resolveVersionFromPolicy(repoPath: string, policy: ProjectPolicy): string | null {
  const source = policy.release_mode.version_source || "package.json";
  if (source === "package.json") return readPackageJson(repoPath).version;
  if (source === "src/version.ts") {
    const versionFile = safeRepoFile(repoPath, "src/version.ts");
    if (!versionFile) return null;
    const text = readFileSync(versionFile, "utf-8");
    const match = text.match(/PATCHWARDEN_VERSION\s*=\s*["']([^"']+)["']/);
    return match ? match[1] : null;
  }
  const file = safeRepoFile(repoPath, source);
  if (!file) return null;
  const text = readFileSync(file, "utf-8").replace(/^\uFEFF/, "").trim();
  return text.split(/\r?\n/)[0]?.trim() || null;
}

export function readPackageJson(repoPath: string): { name: string | null; version: string | null; githubRepo: string | null } {
  const packagePath = join(repoPath, "package.json");
  if (!existsSync(packagePath)) return { name: null, version: null, githubRepo: null };
  try {
    const data = JSON.parse(readFileSync(packagePath, "utf-8").replace(/^\uFEFF/, ""));
    return {
      name: typeof data.name === "string" ? data.name : null,
      version: typeof data.version === "string" ? data.version : null,
      githubRepo: parseGithubRepo(data.repository),
    };
  } catch {
    return { name: null, version: null, githubRepo: null };
  }
}

function normalizePolicy(raw: Partial<ProjectPolicy>, issues: ProjectPolicyIssue[]): ProjectPolicy {
  const policy = clonePolicy(DEFAULT_POLICY);
  const object = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  policy.allowed_commands = stringArrayOrDefault(object.allowed_commands, policy.allowed_commands, "allowed_commands", issues);
  policy.high_risk_commands = stringArrayOrDefault(object.high_risk_commands, policy.high_risk_commands, "high_risk_commands", issues);
  policy.protected_paths = stringArrayOrDefault(object.protected_paths, policy.protected_paths, "protected_paths", issues);

  if (object.auto_cleanup && typeof object.auto_cleanup === "object" && !Array.isArray(object.auto_cleanup)) {
    const cleanup = object.auto_cleanup as Partial<ProjectPolicy["auto_cleanup"]>;
    if (cleanup.enabled !== undefined && typeof cleanup.enabled !== "boolean") {
      issues.push({ code: "invalid_type", severity: "error", field: "auto_cleanup.enabled", message: "auto_cleanup.enabled must be a boolean." });
    } else if (cleanup.enabled !== undefined) {
      policy.auto_cleanup.enabled = cleanup.enabled;
    }
    policy.auto_cleanup.patterns = stringArrayOrDefault(cleanup.patterns, policy.auto_cleanup.patterns, "auto_cleanup.patterns", issues);
    policy.auto_cleanup.exclude = stringArrayOrDefault(cleanup.exclude, policy.auto_cleanup.exclude, "auto_cleanup.exclude", issues);
  }

  if (object.release_mode && typeof object.release_mode === "object" && !Array.isArray(object.release_mode)) {
    const releaseMode = object.release_mode as Partial<ProjectPolicy["release_mode"]>;
    if (releaseMode.version_source !== undefined && typeof releaseMode.version_source !== "string") {
      issues.push({ code: "invalid_type", severity: "error", field: "release_mode.version_source", message: "release_mode.version_source must be a string." });
    } else if (releaseMode.version_source) {
      policy.release_mode.version_source = releaseMode.version_source.trim();
    }
    policy.release_mode.required_commands = stringArrayOrDefault(releaseMode.required_commands, policy.release_mode.required_commands, "release_mode.required_commands", issues);
  }

  return policy;
}

function validateProjectPolicy(repoPath: string, policy: ProjectPolicy, issues: ProjectPolicyIssue[], config: PatchWardenConfig): void {
  for (const [field, commands] of [
    ["allowed_commands", policy.allowed_commands],
    ["high_risk_commands", policy.high_risk_commands],
    ["release_mode.required_commands", policy.release_mode.required_commands],
  ] as const) {
    for (const command of commands) {
      if (field !== "high_risk_commands" && DANGEROUS_COMMAND_RE.test(command)) {
        issues.push({ code: "high_risk_command", severity: "error", field, message: `Command is release/destructive risk and cannot be auto-executed: ${command}` });
      }
      if (field !== "high_risk_commands") {
        try {
          guardTestCommand(command, config, repoPath);
        } catch {
          issues.push({ code: "command_not_allowlisted", severity: "warn", field, message: `Command is not allowed by existing PatchWarden config: ${command}` });
        }
      }
    }
  }

  for (const field of ["auto_cleanup.patterns", "auto_cleanup.exclude", "protected_paths"] as const) {
    const values = field === "auto_cleanup.patterns"
      ? policy.auto_cleanup.patterns
      : field === "auto_cleanup.exclude"
        ? policy.auto_cleanup.exclude
        : policy.protected_paths;
    for (const value of values) {
      if (!value.trim()) {
        issues.push({ code: "empty_path_pattern", severity: "error", field, message: "Path patterns must be non-empty." });
        continue;
      }
      const blocksCriticalDirectory = field === "auto_cleanup.patterns" && DANGEROUS_PATTERN_RE.test(value);
      if (value.includes("\0") || value.includes("..") || isAbsolute(value) || blocksCriticalDirectory) {
        issues.push({ code: "unsafe_path_pattern", severity: "error", field, message: `Unsafe path pattern rejected: ${value}` });
      }
    }
  }

  const versionSource = policy.release_mode.version_source;
  if (versionSource && versionSource !== "package.json" && versionSource !== "src/version.ts") {
    const resolved = safeRepoFile(repoPath, versionSource);
    if (!resolved) {
      issues.push({ code: "version_source_invalid", severity: "error", field: "release_mode.version_source", message: `Version source is outside repo, sensitive, or missing: ${versionSource}` });
    }
  }
}

function buildReleaseReadiness(repoPath: string, policy: ProjectPolicy, config: PatchWardenConfig): ReleaseReadinessSummary {
  const packageJson = readPackageJson(repoPath);
  let version: string | null = null;
  try {
    version = resolveVersionFromPolicy(repoPath, policy);
  } catch {
    version = null;
  }
  return {
    version_source: policy.release_mode.version_source,
    version,
    package_json_version: packageJson.version,
    package_name: packageJson.name,
    version_consistent: version && packageJson.version ? version === packageJson.version : null,
    required_commands: policy.release_mode.required_commands.map((command) => {
      try {
        guardTestCommand(command, config, repoPath);
        return { command, allowed: true, reason: null };
      } catch (err) {
        return { command, allowed: false, reason: err instanceof Error ? err.message : String(err) };
      }
    }),
  };
}

function safeRepoFile(repoPath: string, relPath: string): string | null {
  const normalized = normalizeRelPath(relPath);
  if (!normalized || isSensitivePath(normalized)) return null;
  const candidate = resolve(repoPath, normalized);
  const rel = relative(repoPath, candidate);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) return null;
  if (!existsSync(candidate) || !statSync(candidate).isFile()) return null;
  const parent = dirname(candidate);
  const parentRel = relative(repoPath, parent);
  if (parentRel === ".." || parentRel.startsWith(`..${sep}`)) return null;
  return candidate;
}

function stringArrayOrDefault(value: unknown, fallback: string[], field: string, issues: ProjectPolicyIssue[]): string[] {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    issues.push({ code: "invalid_type", severity: "error", field, message: `${field} must be an array of strings.` });
    return [...fallback];
  }
  return [...new Set(value.map((entry) => entry.trim()).filter(Boolean))];
}

function clonePolicy(policy: ProjectPolicy): ProjectPolicy {
  return {
    allowed_commands: [...policy.allowed_commands],
    auto_cleanup: {
      enabled: policy.auto_cleanup.enabled,
      patterns: [...policy.auto_cleanup.patterns],
      exclude: [...policy.auto_cleanup.exclude],
    },
    high_risk_commands: [...policy.high_risk_commands],
    protected_paths: [...policy.protected_paths],
    release_mode: {
      version_source: policy.release_mode.version_source,
      required_commands: [...policy.release_mode.required_commands],
    },
  };
}

function normalizeRelPath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function pathMatchesPattern(relPath: string, pattern: string): boolean {
  const normalizedPattern = normalizeRelPath(pattern);
  if (!normalizedPattern) return false;
  if (normalizedPattern.includes("*")) {
    const escaped = normalizedPattern
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join("[^/]*");
    return new RegExp(`^${escaped}$`, "i").test(relPath);
  }
  return relPath.toLowerCase() === normalizedPattern.toLowerCase() ||
    relPath.toLowerCase().startsWith(`${normalizedPattern.toLowerCase()}/`);
}

function parseGithubRepo(repository: unknown): string | null {
  const raw = typeof repository === "string"
    ? repository
    : repository && typeof repository === "object" && typeof (repository as any).url === "string"
      ? (repository as any).url
      : "";
  const match = raw.match(/github\.com[:/](.+?\/.+?)(?:\.git)?(?:[#?].*)?$/i);
  return match ? match[1] : null;
}
