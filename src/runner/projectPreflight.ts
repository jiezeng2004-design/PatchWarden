import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { PatchWardenConfig } from "../config.js";
import { buildGitEnvironment, resolveTrustedExecutable } from "./processSecurity.js";

export type PreflightState = "passed" | "warning" | "missing" | "invalid" | "not_applicable" | "occupied";

export interface ProjectPreflightReport {
  schema_version: "patchwarden-project-preflight-v1";
  checked_at: string;
  repo_boundary: PreflightState;
  git_status: PreflightState;
  manifest: PreflightState;
  lockfile: PreflightState;
  runtime: PreflightState;
  dependencies: PreflightState;
  verification_scripts: PreflightState;
  gitignore: PreflightState;
  ports: PreflightState;
  missing_scripts: string[];
  detected_lockfiles: string[];
  details: string[];
  blocking: boolean;
  recommended_action: "bootstrap_dependencies" | "fix_verification_scripts" | "choose_free_runtime_port" | "continue";
}

export async function runProjectPreflight(input: {
  repoPath: string;
  verifyCommands: string[];
  config: PatchWardenConfig;
}): Promise<ProjectPreflightReport> {
  const report: ProjectPreflightReport = {
    schema_version: "patchwarden-project-preflight-v1",
    checked_at: new Date().toISOString(),
    repo_boundary: "passed",
    git_status: "not_applicable",
    manifest: "not_applicable",
    lockfile: "not_applicable",
    runtime: "passed",
    dependencies: "not_applicable",
    verification_scripts: "passed",
    gitignore: "warning",
    ports: "not_applicable",
    missing_scripts: [],
    detected_lockfiles: [],
    details: [],
    blocking: false,
    recommended_action: "continue",
  };

  inspectGit(input.repoPath, report);
  const manifest = readPackageManifest(input.repoPath, report);
  if (manifest) inspectNodeProject(input.repoPath, manifest, input.verifyCommands, report);
  report.gitignore = safeRegularFile(join(input.repoPath, ".gitignore")) ? "passed" : "warning";

  if (input.config.runtimeValidation?.enabled) {
    report.ports = await loopbackReachable(input.config.runtimeValidation.baseUrl) ? "occupied" : "passed";
    if (report.ports === "occupied") report.details.push("Configured runtimeValidation.baseUrl is already occupied by an unowned service.");
  }

  if (report.manifest === "invalid" || report.missing_scripts.length > 0) {
    report.blocking = true;
    report.recommended_action = "fix_verification_scripts";
  } else if (report.dependencies === "missing") {
    report.blocking = true;
    report.recommended_action = "bootstrap_dependencies";
  } else if (report.ports === "occupied") {
    report.blocking = true;
    report.recommended_action = "choose_free_runtime_port";
  }
  return report;
}

function inspectGit(repoPath: string, report: ProjectPreflightReport): void {
  try {
    const env = buildGitEnvironment(repoPath);
    const git = resolveTrustedExecutable("git", repoPath, { pathValue: env.PATH });
    const inside = execFileSync(git, ["rev-parse", "--is-inside-work-tree"], { cwd: repoPath, encoding: "utf-8", windowsHide: true, env, timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim() === "true";
    if (!inside) return;
    const status = execFileSync(git, ["status", "--porcelain", "--untracked-files=no"], { cwd: repoPath, encoding: "utf-8", windowsHide: true, env, timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
    report.git_status = status.trim() ? "warning" : "passed";
    if (status.trim()) report.details.push("Repository contains pre-existing tracked changes; they are retained as baseline evidence.");
  } catch {
    report.git_status = "not_applicable";
  }
}

function readPackageManifest(repoPath: string, report: ProjectPreflightReport): Record<string, unknown> | null {
  const path = join(repoPath, "package.json");
  if (!existsSync(path)) return null;
  if (!safeRegularFile(path)) {
    report.manifest = "invalid";
    report.details.push("package.json is linked, non-regular, unreadable, or too large.");
    report.blocking = true;
    return null;
  }
  try {
    const value = JSON.parse(readFileSync(path, "utf-8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object required");
    report.manifest = "passed";
    return value as Record<string, unknown>;
  } catch {
    report.manifest = "invalid";
    report.details.push("package.json is invalid JSON.");
    report.blocking = true;
    return null;
  }
}

function inspectNodeProject(repoPath: string, manifest: Record<string, unknown>, verifyCommands: string[], report: ProjectPreflightReport): void {
  const lockfiles = ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb"]
    .filter((name) => safeRegularFile(join(repoPath, name)));
  report.detected_lockfiles = lockfiles;
  report.lockfile = lockfiles.length > 0 ? "passed" : "missing";
  if (lockfiles.length === 0) report.details.push("Node project has no recognized lockfile.");

  const dependencies = [manifest.dependencies, manifest.devDependencies, manifest.optionalDependencies]
    .some((value) => Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value as object).length > 0));
  report.dependencies = dependencies
    ? safeDependencyDirectory(join(repoPath, "node_modules")) ? "passed" : "missing"
    : "not_applicable";
  if (report.dependencies === "missing") report.details.push("package.json declares dependencies but node_modules is missing or unsafe.");

  const scripts = manifest.scripts && typeof manifest.scripts === "object" && !Array.isArray(manifest.scripts)
    ? manifest.scripts as Record<string, unknown>
    : {};
  report.missing_scripts = verifyCommands.flatMap((command) => {
    const match = command.match(/^(?:npm|npm\.cmd|pnpm|pnpm\.cmd|yarn)\s+run\s+([A-Za-z0-9:_-]+)(?:\s|$)/i);
    return match && typeof scripts[match[1]] !== "string" ? [match[1]] : [];
  });
  report.missing_scripts = [...new Set(report.missing_scripts)];
  report.verification_scripts = report.missing_scripts.length > 0 ? "missing" : "passed";
  if (report.missing_scripts.length > 0) report.details.push(`Missing package scripts: ${report.missing_scripts.join(", ")}.`);
}

function safeRegularFile(path: string): boolean {
  try {
    const metadata = lstatSync(path);
    return metadata.isFile() && !metadata.isSymbolicLink() && metadata.size <= 1024 * 1024;
  } catch {
    return false;
  }
}

function safeDirectory(path: string): boolean {
  try {
    const metadata = lstatSync(path);
    return metadata.isDirectory() && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
}

function safeDependencyDirectory(path: string): boolean {
  return safeDirectory(path) && readdirSync(path).length > 0;
}

async function loopbackReachable(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 500);
  try {
    await fetch(url, { signal: controller.signal, redirect: "manual", cache: "no-store" });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
