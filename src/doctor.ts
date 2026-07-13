#!/usr/bin/env node
/**
 * PatchWarden Doctor — read-only diagnostic checks
 *
 * Usage: node dist/doctor.js  or  npm run doctor
 *
 * Checks 15 aspects of the environment and configuration.
 * Never modifies files, installs dependencies, or starts services.
 */

import { existsSync, statSync, readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { isAbsolute, resolve, normalize, join } from "node:path";
import { execSync } from "node:child_process";
import { createServer } from "node:net";
import { getConfig, type PatchWardenConfig } from "./config.js";
import { guardPath, guardWorkspacePath } from "./security/pathGuard.js";
import { isSensitivePath } from "./security/sensitiveGuard.js";
import { guardPlanContent } from "./security/planGuard.js";
import { TASK_READ_ONLY_FILES } from "./tools/getTaskFile.js";
import { getToolDefs } from "./tools/registry.js";
import { CHATGPT_CORE_TOOL_NAMES, CHATGPT_DIRECT_TOOL_NAMES, selectToolsForProfile } from "./tools/toolCatalog.js";
import { buildToolRegistry } from "./tools/toolRegistry.js";
import { runAllSchemaDriftChecks } from "./tools/schemaDriftCheck.js";
import { runReleaseGateCheck } from "./release/releaseGate.js";
import { PATCHWARDEN_VERSION } from "./version.js";
import { logger } from "./logging.js";

// ── Types ──────────────────────────────────────────────────────────

export type DoctorCheckLevel = "OK" | "WARN" | "FAIL";

export interface DoctorCheckResult {
  level: DoctorCheckLevel;
  message: string;
  details?: string;
}

export interface DoctorCheck {
  id: string;
  description: string;
  run(context: DoctorContext): DoctorCheckResult[] | Promise<DoctorCheckResult[]>;
}

export interface DoctorContext {
  config: PatchWardenConfig | null;
  configError: string | null;
  allowDefaultConfig: boolean;
  configPathUsed: string;
}

// ── Helpers ────────────────────────────────────────────────────────

function cmd(cmdStr: string): string {
  try {
    return execSync(cmdStr, {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"], // suppress stdin and stderr
    }).trim();
  } catch {
    return "";
  }
}

function okResult(message: string, details?: string): DoctorCheckResult {
  return { level: "OK", message, details };
}

function warnResult(message: string, details?: string): DoctorCheckResult {
  return { level: "WARN", message, details };
}

function failResult(message: string, details?: string): DoctorCheckResult {
  return { level: "FAIL", message, details };
}

/** Mirrors original check(): OK if condition true, FAIL otherwise. */
function checkResult(name: string, condition: boolean, detail?: string): DoctorCheckResult {
  return condition ? okResult(name, detail) : failResult(name, detail);
}

/** Mirrors original warnCheck(): OK if condition true, WARN otherwise. */
function warnCheckResult(name: string, condition: boolean, detail?: string): DoctorCheckResult {
  return condition ? okResult(name, detail) : warnResult(name, detail);
}

function formatResult(result: DoctorCheckResult): string {
  const tag = result.level === "OK" ? "[OK]   " : result.level === "WARN" ? "[WARN] " : "[FAIL] ";
  if (result.level !== "OK" && result.details) {
    return `${tag}${result.message} — ${result.details}`;
  }
  return `${tag}${result.message}`;
}

// ── Checks ─────────────────────────────────────────────────────────

const checkNodeVersion: DoctorCheck = {
  id: "node-version",
  description: "Node.js version",
  run() {
    const nodeVer = process.version;
    const nodeMajor = parseInt(nodeVer.slice(1).split(".")[0]);
    const detail = nodeMajor < 18 ? `v${nodeVer} — need >=18.0.0` : `v${nodeVer}`;
    return [checkResult("Node.js version", nodeMajor >= 18, detail)];
  },
};

const checkNpmAvailable: DoctorCheck = {
  id: "npm-available",
  description: "npm available",
  run() {
    const npmVer = cmd("npm --version");
    return [checkResult("npm available", npmVer !== "", npmVer || "npm not found in PATH")];
  },
};

// Local-only medium-risk confirmation entrypoint. It must exist as a package
// binary but must not be exposed as an MCP tool.
const checkConfirmPackage: DoctorCheck = {
  id: "confirm-package",
  description: "patchwarden-confirm package",
  run() {
    try {
      const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf-8"));
      return [
        checkResult(
          "patchwarden-confirm package binary",
          packageJson.bin?.["patchwarden-confirm"] === "dist/assessments/confirmCli.js",
          packageJson.bin?.["patchwarden-confirm"] || "missing",
        ),
        checkResult(
          "patchwarden-confirm compiled entrypoint",
          existsSync(resolve(process.cwd(), "dist/assessments/confirmCli.js")),
          "run npm.cmd run build",
        ),
      ];
    } catch (error) {
      return [checkResult("patchwarden-confirm package binary", false, error instanceof Error ? error.message : String(error))];
    }
  },
};

const checkGitAvailable: DoctorCheck = {
  id: "git-available",
  description: "Git available",
  run() {
    const gitVer = cmd("git --version");
    return [warnCheckResult("Git available", gitVer !== "", gitVer || "git not found — runner git.diff will not work")];
  },
};

const checkConfigFile: DoctorCheck = {
  id: "config-file",
  description: "Config file exists",
  run(context) {
    const configDetail = context.configPathUsed
      ? context.configPathUsed
      : 'Create one: cp examples/config.example.json patchwarden.config.json';
    if (context.allowDefaultConfig) {
      return [warnCheckResult("Config file exists", context.configPathUsed !== "", configDetail)];
    }
    return [checkResult("Config file exists", context.configPathUsed !== "", configDetail)];
  },
};

const checkPatchwardenConfigEnv: DoctorCheck = {
  id: "patchwarden-config-env",
  description: "PATCHWARDEN_CONFIG env",
  run() {
    if (process.env.PATCHWARDEN_CONFIG) {
      return [okResult(`PATCHWARDEN_CONFIG = ${process.env.PATCHWARDEN_CONFIG}`)];
    }
    return [okResult("PATCHWARDEN_CONFIG not set (using default: patchwarden.config.json)")];
  },
};

const checkConfigParseable: DoctorCheck = {
  id: "config-parseable",
  description: "Config parseable",
  run(context) {
    if (context.config) {
      return [checkResult("Config parseable", true, `workspaceRoot: ${context.config.workspaceRoot}`)];
    }
    return [checkResult("Config parseable", false, context.configError || "unknown error")];
  },
};

const checkWorkspaceRoot: DoctorCheck = {
  id: "workspace-root",
  description: "workspaceRoot checks",
  run(context) {
    if (!context.config) return [];
    const results: DoctorCheckResult[] = [];
    const ws = normalize(resolve(context.config.workspaceRoot));
    const exists = existsSync(ws);
    results.push(checkResult("workspaceRoot exists", exists, ws));

    let isDir = false;
    try { isDir = statSync(ws).isDirectory(); } catch {}
    results.push(checkResult("workspaceRoot is directory", isDir, ws));

    const dangerousRoots = [
      { pattern: /^[A-Za-z]:\\?$/, label: "drive root" },
      { pattern: /\\Users\\[^\\]+$/, label: "user home directory" },
      { pattern: /\\Desktop$/, label: "Desktop" },
      { pattern: /\\Downloads$/, label: "Downloads" },
      { pattern: /\\Documents$/, label: "Documents" },
    ];

    for (const { pattern, label } of dangerousRoots) {
      if (pattern.test(ws)) {
        results.push(warnResult(`workspaceRoot is ${label}: ${ws} — consider narrowing to a project directory`));
      }
    }
    return results;
  },
};

const checkPathGuard: DoctorCheck = {
  id: "path-guard",
  description: "Path guard test",
  run(context) {
    if (!context.config) return [];
    const results: DoctorCheckResult[] = [];
    try {
      guardPath("test-file.txt", context.config.workspaceRoot);
      results.push(okResult("pathGuard allows workspace-internal path"));
    } catch (err) {
      results.push(failResult(`pathGuard rejects internal path: ${err instanceof Error ? err.message : String(err)}`));
    }

    try {
      guardPath("../outside", context.config.workspaceRoot);
      results.push(failResult("pathGuard should have blocked ../escape"));
    } catch {
      results.push(okResult("pathGuard blocks ../ path escape"));
    }

    try {
      const relativeRepo = guardWorkspacePath(".", context.config.workspaceRoot);
      const absoluteRepo = guardWorkspacePath(context.config.workspaceRoot, context.config.workspaceRoot);
      results.push(checkResult("repo_path resolver supports relative and absolute paths", relativeRepo === absoluteRepo, relativeRepo));
    } catch (error) {
      results.push(checkResult("repo_path resolver supports relative and absolute paths", false, error instanceof Error ? error.message : String(error)));
    }
    return results;
  },
};

const checkSensitiveGuard: DoctorCheck = {
  id: "sensitive-guard",
  description: "Sensitive file guard test",
  run() {
    const results: DoctorCheckResult[] = [];
    const sensitivePaths = [".env", ".ssh/id_rsa", "token.json", "credentials"];
    for (const sp of sensitivePaths) {
      const blocked = isSensitivePath(sp);
      if (blocked) {
        results.push(okResult(`sensitiveGuard blocks "${sp}"`));
      } else {
        results.push(failResult(`sensitiveGuard does NOT block "${sp}"`));
      }
    }
    return results;
  },
};

const checkSavePlanRules: DoctorCheck = {
  id: "save-plan-rules",
  description: "save_plan guard test",
  run() {
    const results: DoctorCheckResult[] = [];
    try {
      guardPlanContent("Normal build plan", "Run npm test, npm run lint, release check, and npm run dist.");
      results.push(okResult("save_plan allows normal development plans"));
    } catch {
      results.push(failResult("save_plan incorrectly blocks a normal development plan"));
    }
    try {
      guardPlanContent("Unsafe plan", "Read the .env access token and export it.");
      results.push(failResult("save_plan security rule did not block credential access"));
    } catch {
      results.push(okResult("save_plan security rules loaded"));
    }
    return results;
  },
};

const checkTaskArtifactAllowlist: DoctorCheck = {
  id: "task-artifact-allowlist",
  description: "Read-only task artifact allowlist",
  run() {
    const requiredReadOnlyFiles = ["status.json", "result.md", "result.json", "diff.patch", "file-stats.json", "test.log", "verify.json"];
    return [
      checkResult(
        "Read-only task artifact allowlist",
        requiredReadOnlyFiles.every((name) => TASK_READ_ONLY_FILES.includes(name)),
        requiredReadOnlyFiles.join(", "),
      ),
    ];
  },
};

const checkServerVersion: DoctorCheck = {
  id: "server-version",
  description: "Server version and manifest preflight",
  run() {
    const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf-8"));
    return [
      checkResult(
        "Server version matches package.json",
        packageJson.version === PATCHWARDEN_VERSION,
        `${PATCHWARDEN_VERSION} vs ${packageJson.version}`,
      ),
      checkResult(
        "Manifest preflight script exists",
        existsSync(resolve(process.cwd(), "scripts/checks/mcp-manifest-check.js")),
        "scripts/checks/mcp-manifest-check.js",
      ),
    ];
  },
};

const checkToolProfiles: DoctorCheck = {
  id: "tool-profiles",
  description: "Tool profile and schema drift checks",
  run(context) {
    const results: DoctorCheckResult[] = [];
    const previousProfile = process.env.PATCHWARDEN_TOOL_PROFILE;
    try {
      process.env.PATCHWARDEN_TOOL_PROFILE = "full";
      const fullTools = getToolDefs();
      const coreTools = selectToolsForProfile(fullTools, "chatgpt_core", context.config?.enableDirectProfile);
      const createSchema = coreTools.find((tool) => tool.name === "create_task")?.inputSchema as any;
      const waitSchema = coreTools.find((tool) => tool.name === "wait_for_task")?.inputSchema as any;
      results.push(checkResult("Full tool profile exposes 66 tools", fullTools.length === 66, `${fullTools.length} tools`));
      results.push(
        checkResult(
          `chatgpt_core profile exposes the exact ${CHATGPT_CORE_TOOL_NAMES.length}-tool manifest`,
          JSON.stringify(coreTools.map((tool) => tool.name)) === JSON.stringify(CHATGPT_CORE_TOOL_NAMES),
          coreTools.map((tool) => tool.name).join(", "),
        ),
      );
      results.push(
        checkResult(
          "Core task schemas expose inline_plan, verify_commands, and wait aliases",
          Boolean(
            createSchema?.properties?.inline_plan &&
            createSchema?.properties?.verify_commands &&
            waitSchema?.properties?.timeout_seconds &&
            waitSchema?.properties?.wait_seconds,
          ),
        ),
      );

      // chatgpt_direct profile checks
      const directDisabledTools = selectToolsForProfile(fullTools, "chatgpt_direct", false);
      results.push(
        checkResult(
          "chatgpt_direct disabled exposes only health_check (degraded mode)",
          directDisabledTools.length === 1 && directDisabledTools[0].name === "health_check",
          `${directDisabledTools.map((t) => t.name).join(", ")}`,
        ),
      );

      if (context.config?.enableDirectProfile) {
        const directEnabledTools = selectToolsForProfile(fullTools, "chatgpt_direct", true);
        results.push(
          checkResult(
            `chatgpt_direct enabled exposes the exact ${CHATGPT_DIRECT_TOOL_NAMES.length}-tool manifest`,
            JSON.stringify(directEnabledTools.map((tool) => tool.name)) === JSON.stringify(CHATGPT_DIRECT_TOOL_NAMES),
            directEnabledTools.map((tool) => tool.name).join(", "),
          ),
        );
      } else {
        results.push(okResult("chatgpt_direct enabled check skipped (enableDirectProfile=false)"));
      }

      // Schema drift 检查（v0.9.0）—— warn 级别，不阻断 doctor:ci
      const driftRegistry = buildToolRegistry(fullTools);
      const driftToolDefs = new Map<string, { inputSchema: unknown }>();
      for (const tool of fullTools) {
        driftToolDefs.set(tool.name, { inputSchema: tool.inputSchema });
      }
      const driftResult = runAllSchemaDriftChecks(driftRegistry, driftToolDefs);
      if (driftResult.ok) {
        results.push(okResult("Schema drift check — no drift detected"));
      } else {
        for (const w of driftResult.warnings) {
          results.push(warnResult(`Schema drift: ${w}`));
        }
      }
    } finally {
      if (previousProfile === undefined) delete process.env.PATCHWARDEN_TOOL_PROFILE;
      else process.env.PATCHWARDEN_TOOL_PROFILE = previousProfile;
    }
    return results;
  },
};

// Release gate module loadable (v1.0.0) — module integrity only.
// Does NOT execute local_ready (would recurse into doctor:ci).
const checkReleaseGate: DoctorCheck = {
  id: "release-gate",
  description: "Release gate module loadable",
  run() {
    try {
      const releaseGateReady = typeof runReleaseGateCheck === "function";
      return [
        checkResult(
          "Release gate module loadable",
          releaseGateReady,
          releaseGateReady ? "runReleaseGateCheck exported" : "runReleaseGateCheck missing or invalid",
        ),
      ];
    } catch (error) {
      return [checkResult("Release gate module loadable", false, error instanceof Error ? error.message : String(error))];
    }
  },
};

const checkHttpPort: DoctorCheck = {
  id: "http-port",
  description: "HTTP port check",
  async run(context) {
    const httpPort = context.config?.http?.port || context.config?.httpPort || 7331;
    try {
      const server = createServer();
      await new Promise<void>((resolvePort, rejectPort) => {
        server.once("error", rejectPort);
        server.listen(httpPort, "127.0.0.1", () => {
          server.close();
          resolvePort();
        });
      });
      return [okResult(`HTTP port ${httpPort} is free`)];
    } catch {
      return [warnResult(`HTTP port ${httpPort} is in use — change http.port in config`)];
    }
  },
};

const checkDistFiles: DoctorCheck = {
  id: "dist-files",
  description: "dist file checks",
  run() {
    const distChecks = [
      { file: "dist/index.js", label: "stdio MCP entry", cmd: "npm run build" },
      { file: "dist/httpServer.js", label: "HTTP MCP entry", cmd: "npm run build" },
      { file: "dist/runner/watch.js", label: "watcher entry (npm run watch)", cmd: "npm run build" },
    ];
    const results: DoctorCheckResult[] = [];
    for (const { file, label, cmd: buildCmd } of distChecks) {
      const exists = existsSync(resolve(process.cwd(), file));
      results.push(checkResult(`${label} exists`, exists, exists ? file : `Missing — run: ${buildCmd}`));
    }
    return results;
  },
};

const checkToolModules: DoctorCheck = {
  id: "tool-modules",
  description: "Tool module checks",
  run() {
    const newTools = [
      "listTasks",
      "listAgents",
      "cancelTask",
      "killTask",
      "retryTask",
      "getTaskProgress",
      "getTaskSummary",
      "waitForTask",
      "getTaskStdoutTail",
      "healthCheck",
      "auditTask",
    ];
    const results: DoctorCheckResult[] = [];
    for (const t of newTools) {
      const compiled = resolve(process.cwd(), "dist/tools", `${t}.js`);
      const exists = existsSync(compiled);
      results.push(checkResult(`Tool module: ${t}`, exists, exists ? "compiled" : "missing"));
    }
    return results;
  },
};

const checkDirectToolModules: DoctorCheck = {
  id: "direct-tool-modules",
  description: "Direct tool module checks",
  run() {
    const directToolModules = [
      "createDirectSession",
      "searchWorkspace",
      "applyPatch",
      "runVerification",
      "finalizeDirectSession",
      "auditSession",
    ];
    const results: DoctorCheckResult[] = [];
    for (const t of directToolModules) {
      const compiled = resolve(process.cwd(), "dist/tools", `${t}.js`);
      const exists = existsSync(compiled);
      results.push(checkResult(`Direct tool module: ${t}`, exists, exists ? "compiled" : "missing"));
    }
    return results;
  },
};

const checkDirectSupportModules: DoctorCheck = {
  id: "direct-support-modules",
  description: "Direct support module checks",
  run() {
    const directSupportModules = [
      "directSessionStore",
      "directGuards",
      "directPatch",
      "directVerification",
      "directAudit",
    ];
    const results: DoctorCheckResult[] = [];
    for (const t of directSupportModules) {
      const compiled = resolve(process.cwd(), "dist/direct", `${t}.js`);
      const exists = existsSync(compiled);
      results.push(checkResult(`Direct support module: ${t}`, exists, exists ? "compiled" : "missing"));
    }
    return results;
  },
};

const checkTaskDirectoryWritable: DoctorCheck = {
  id: "task-directory-writable",
  description: "Task directory and workspaceRoot writable",
  run(context) {
    if (!context.config) return [];
    const results: DoctorCheckResult[] = [];
    const tasksDir = resolve(context.config.workspaceRoot, context.config.tasksDir);
    try {
      mkdirSync(tasksDir, { recursive: true });
      const testFile = join(tasksDir, ".doctor-write-test");
      writeFileSync(testFile, "ok", "utf-8");
      rmSync(testFile);
      results.push(checkResult("Task directory writable", true, tasksDir));

      const sampleTaskDir = join(tasksDir, ".doctor-sample-task");
      mkdirSync(sampleTaskDir, { recursive: true });
      const sampleStatus = join(sampleTaskDir, "status.json");
      writeFileSync(sampleStatus, JSON.stringify({ status: "doctor" }), "utf-8");
      const sampleReadable = JSON.parse(readFileSync(sampleStatus, "utf-8")).status === "doctor";
      rmSync(sampleTaskDir, { recursive: true, force: true });
      results.push(checkResult("Example task directory read/write", sampleReadable, sampleTaskDir));
    } catch {
      results.push(warnCheckResult("Task directory writable", false, tasksDir));
    }

    // workspaceRoot writable
    try {
      const testFile = resolve(context.config.workspaceRoot, ".doctor-write-test");
      writeFileSync(testFile, "ok", "utf-8");
      rmSync(testFile);
      results.push(checkResult("workspaceRoot writable", true, context.config.workspaceRoot));
    } catch {
      results.push(warnCheckResult("workspaceRoot writable", false, context.config.workspaceRoot));
    }
    return results;
  },
};

const checkWatcherStaleThreshold: DoctorCheck = {
  id: "watcher-stale-threshold",
  description: "Watcher stale threshold is valid",
  run(context) {
    if (!context.config) return [];
    return [
      checkResult(
        "Watcher stale threshold is valid",
        context.config.watcherStaleSeconds >= 5 && context.config.watcherStaleSeconds <= 3600,
        `${context.config.watcherStaleSeconds}s`,
      ),
    ];
  },
};

const checkAllowedTestCommandsIncludesNpmTest: DoctorCheck = {
  id: "allowed-test-commands-npm-test",
  description: "allowedTestCommands includes npm test",
  run(context) {
    if (!context.config) return [];
    const hasNpmTest = context.config.allowedTestCommands.some((c: string) => c === "npm test" || c === "npm run test");
    return [warnCheckResult("allowedTestCommands includes npm test", hasNpmTest, hasNpmTest ? "present" : "npm test is missing — add it to allowedTestCommands")];
  },
};

const checkTaskTimeoutDefaults: DoctorCheck = {
  id: "task-timeout-defaults",
  description: "Task timeout defaults are valid",
  run(context) {
    if (!context.config) return [];
    return [
      checkResult(
        "Task timeout defaults are valid",
        context.config.defaultTaskTimeoutSeconds > 0 && context.config.defaultTaskTimeoutSeconds <= context.config.maxTaskTimeoutSeconds,
        `default ${context.config.defaultTaskTimeoutSeconds}s, max ${context.config.maxTaskTimeoutSeconds}s`,
      ),
    ];
  },
};

const checkAgentCommands: DoctorCheck = {
  id: "agent-commands",
  description: "Agent command check",
  run(context) {
    if (!context.config) return [];
    const results: DoctorCheckResult[] = [];
    const agents = context.config.agents || {};
    for (const [name, agentCfg] of Object.entries(agents) as [string, any][]) {
      const cmdName = agentCfg.command;
      const looksLikePath = isAbsolute(cmdName) || cmdName.includes("/") || cmdName.includes("\\");
      if (looksLikePath) {
        const agentExists = existsSync(cmdName);
        results.push(warnCheckResult(`Agent "${name}" command available`, agentExists, agentExists ? `Found: ${cmdName}` : `"${cmdName}" does not exist — agent tasks will fail`));
        continue;
      }
      // Platform-appropriate lookup: 'where' on Windows, 'command -v' on Unix
      const isWin = process.platform === "win32";
      const lookupCmd = isWin ? `where ${cmdName}` : `command -v ${cmdName}`;
      const fallbackCmd = isWin ? `command -v ${cmdName}` : `which ${cmdName}`;
      const found = cmd(lookupCmd) || cmd(fallbackCmd);
      results.push(warnCheckResult(`Agent "${name}" command available`, found !== "", found ? `Found: ${found.split("\n")[0]}` : `"${cmdName}" not in PATH — agent tasks will fail`));
    }
    return results;
  },
};

const checkAllowedTestCommandsSafety: DoctorCheck = {
  id: "allowed-test-commands-safety",
  description: "allowedTestCommands safety check",
  run(context) {
    if (!context.config) return [];
    const results: DoctorCheckResult[] = [];
    const testCmds = context.config.allowedTestCommands || [];
    results.push(checkResult("allowedTestCommands is non-empty", testCmds.length > 0, testCmds.length > 0 ? `${testCmds.length} commands` : "No test commands configured"));

    const dangerous = ["rm -rf", "del /s", "format", "shutdown", "curl |", "wget |"];
    for (const cmdStr of testCmds) {
      for (const danger of dangerous) {
        if (cmdStr.toLowerCase().includes(danger)) {
          results.push(warnResult(`allowedTestCommands contains dangerous pattern: "${cmdStr}"`));
        }
      }
    }
    return results;
  },
};

// Direct profile config checks
const checkDirectProfileConfig: DoctorCheck = {
  id: "direct-profile-config",
  description: "Direct profile config checks",
  run(context) {
    if (!context.config) return [];
    const results: DoctorCheckResult[] = [];
    const directCmds = context.config.directAllowedCommands || [];
    results.push(warnCheckResult("directAllowedCommands is non-empty", directCmds.length > 0, directCmds.length > 0 ? `${directCmds.length} commands` : "No Direct commands configured"));

    // npm run doctor should NOT be in default Direct whitelist
    const hasDoctor = directCmds.some((c: string) => c === "npm run doctor");
    results.push(checkResult("directAllowedCommands does not include npm run doctor", !hasDoctor, hasDoctor ? "npm run doctor found in Direct whitelist — remove it for tighter security" : "not present"));

    results.push(checkResult("directSessionTtlSeconds is valid", context.config.directSessionTtlSeconds >= 60 && context.config.directSessionTtlSeconds <= 86400, `${context.config.directSessionTtlSeconds}s`));

    results.push(checkResult("directMaxPatchBytes is positive", context.config.directMaxPatchBytes > 0, `${context.config.directMaxPatchBytes}`));

    results.push(checkResult("directMaxFileBytes is positive", context.config.directMaxFileBytes > 0, `${context.config.directMaxFileBytes}`));
    return results;
  },
};

// Tunnel example files check
const checkTunnelExamples: DoctorCheck = {
  id: "tunnel-examples",
  description: "Tunnel example files check",
  run() {
    const tunnelFiles = [
      "examples/openai-tunnel/README.md",
      "examples/openai-tunnel/tunnel-client.example.yaml",
      "examples/openai-tunnel/chatgpt-test-prompt.md",
      "scripts/mcp/patchwarden-mcp-direct.cmd",
      "PatchWarden.cmd",
      "scripts/control/manage-patchwarden.ps1",
      "scripts/launchers/Start-PatchWarden-Direct-Tunnel.cmd",
    ];
    const results: DoctorCheckResult[] = [];
    for (const tf of tunnelFiles) {
      const full = resolve(process.cwd(), tf);
      const exists = existsSync(full);
      results.push(checkResult(`Tunnel example: ${tf}`, exists, exists ? "present" : "missing"));

      // Check for leaked secrets in example files
      if (exists) {
        const content = readFileSync(full, "utf-8");
        // Only flag actual key-value assignments, not comments/mentions
        const leaked = /(?:api_key|sk-[a-zA-Z0-9]{10,}|token\s*[:=]\s*\S{4,}|secret\s*[:=]\s*\S{4,}|password\s*[:=]\s*\S{4,})/gi.test(
          // Strip comment lines first
          content.split("\n").filter(l => !l.trim().startsWith("#") && !l.trim().startsWith("//")).join("\n"),
        );
        if (leaked) {
          results.push(warnResult(`${tf} may contain secrets`));
        } else {
          results.push(okResult(`${tf} — no real secrets`));
        }
      }
    }
    return results;
  },
};

// ── Check registry ─────────────────────────────────────────────────

const checks: DoctorCheck[] = [
  checkNodeVersion,
  checkNpmAvailable,
  checkConfirmPackage,
  checkGitAvailable,
  checkConfigFile,
  checkPatchwardenConfigEnv,
  checkConfigParseable,
  checkWorkspaceRoot,
  checkPathGuard,
  checkSensitiveGuard,
  checkSavePlanRules,
  checkTaskArtifactAllowlist,
  checkServerVersion,
  checkToolProfiles,
  checkReleaseGate,
  checkHttpPort,
  checkDistFiles,
  checkToolModules,
  checkDirectToolModules,
  checkDirectSupportModules,
  checkTaskDirectoryWritable,
  checkWatcherStaleThreshold,
  checkAllowedTestCommandsIncludesNpmTest,
  checkTaskTimeoutDefaults,
  checkAgentCommands,
  checkAllowedTestCommandsSafety,
  checkDirectProfileConfig,
  checkTunnelExamples,
];

// ── Context preparation ────────────────────────────────────────────

function prepareContext(): DoctorContext {
  const allowDefaultConfig = process.argv.includes("--allow-default-config");

  const configPaths = [
    resolve(process.cwd(), "patchwarden.config.json"),
    process.env.PATCHWARDEN_CONFIG || "",
  ].filter(Boolean);

  let configPathUsed = "";
  for (const p of configPaths) {
    if (existsSync(p)) { configPathUsed = p; break; }
  }

  // Load config (may fail)
  let config: PatchWardenConfig | null = null;
  let configError: string | null = null;
  try {
    config = getConfig();
  } catch (err) {
    configError = err instanceof Error ? err.message : String(err);
  }

  return { config, configError, allowDefaultConfig, configPathUsed };
}

// ══════════════════════════════════════════════════════════════════
// Main
// ══════════════════════════════════════════════════════════════════

async function main() {
  console.log("PatchWarden Doctor\n");
  const context = prepareContext();

  const allResults: DoctorCheckResult[] = [];
  for (const check of checks) {
    try {
      const results = await check.run(context);
      allResults.push(...results);
    } catch (err) {
      allResults.push(failResult(check.description, err instanceof Error ? err.message : String(err)));
    }
  }

  console.log(allResults.map(formatResult).join("\n"));

  let ok = 0;
  let warn = 0;
  let fail = 0;
  for (const r of allResults) {
    if (r.level === "OK") ok++;
    else if (r.level === "WARN") warn++;
    else fail++;
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log(`OK: ${ok}  WARN: ${warn}  FAIL: ${fail}`);
  console.log(`${"=".repeat(50)}`);

  if (fail > 0) {
    console.log("\n❌ Doctor found issues that need attention.");
    console.log("   Fix FAIL items before using PatchWarden.");
    process.exit(1);
  } else if (warn > 0) {
    console.log("\n⚠️  Doctor found warnings — review before production use.");
    process.exit(0);
  } else {
    console.log("\n✅ All checks passed.");
    process.exit(0);
  }
}

main().catch((err) => {
  logger.fatal("Doctor crashed", {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
