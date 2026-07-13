/**
 * Control Center routes — project policy + release status.
 *
 * Read-only wrappers around `getProjectPolicySummary` that surface release
 * readiness, blocked commands, and version consistency for the dashboard's
 * release panel. Never performs remote writes (`remote_write_performed` is
 * always false).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type ServerResponse } from "node:http";
import { getProjectPolicySummary } from "../../policy/projectPolicy.js";
import { errorMessage, sendJson } from "../shared.js";

export function handleProjectPolicy(res: ServerResponse, repoPath: string): void {
  try {
    sendJson(res, 200, getProjectPolicySummary(repoPath || "."));
  } catch (err) {
    sendJson(res, 200, {
      repo_path: repoPath || ".",
      valid: false,
      issues: [{ code: "policy_unavailable", severity: "error", field: "repo_path", message: errorMessage(err) }],
    });
  }
}

export function handleReleaseStatus(res: ServerResponse, repoPath: string): void {
  try {
    const policy = getProjectPolicySummary(repoPath || ".");
    const readiness = policy.release_readiness;
    const requiredCommands = readiness.required_commands.map((c) => ({
      command: c.command,
      allowed: c.allowed,
      blocked_reason: c.allowed ? null : (c.reason || "not_allowed"),
    }));
    const commandsBlockedCount = requiredCommands.filter((c) => !c.allowed).length;
    const hasPackageJson = existsSync(join(policy.resolved_repo_path, "package.json"));
    const versionSource = hasPackageJson
      ? "package.json"
      : (repoPath || ".") === "."
        ? "workspace_root"
        : "unknown";

    let readyState: string;
    if (!policy.valid || commandsBlockedCount > 0) {
      readyState = "blocked";
    } else if (readiness.version === null) {
      readyState = "unknown";
    } else if (readiness.version_consistent === true) {
      readyState = "ready";
    } else {
      readyState = "blocked";
    }

    sendJson(res, 200, {
      repo_path: repoPath || ".",
      resolved_repo_path: policy.resolved_repo_path,
      policy_valid: policy.valid,
      policy_issue_count: policy.issues.length,
      policy_issues: policy.issues.slice(0, 10),
      release_readiness: readiness,
      package_name: readiness.package_name,
      version_source: versionSource,
      version_consistent: readiness.version_consistent,
      required_commands: requiredCommands,
      commands_blocked_count: commandsBlockedCount,
      ready_state: readyState,
      next_action: policy.valid && readiness.version_consistent !== false
        ? "Run release_check via create_task template, or run_task_loop with template=release_check."
        : "Fix project-policy or version consistency issues before release preparation.",
      remote_write_performed: false,
    });
  } catch (err) {
    sendJson(res, 200, {
      repo_path: repoPath || ".",
      policy_valid: false,
      error: errorMessage(err),
      remote_write_performed: false,
    });
  }
}
