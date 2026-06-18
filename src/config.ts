import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// ── Type definitions ──────────────────────────────────────────────

export interface AgentConfig {
  command: string;
  args: string[];
}

export interface SafeBifrostConfig {
  workspaceRoot: string;
  plansDir: string;
  tasksDir: string;
  agents: Record<string, AgentConfig>;
  allowedTestCommands: string[];
  maxReadFileBytes: number;
}

// ── Defaults ──────────────────────────────────────────────────────

const DEFAULT_CONFIG: SafeBifrostConfig = {
  workspaceRoot: process.cwd(),
  plansDir: ".safe-bifrost/plans",
  tasksDir: ".safe-bifrost/tasks",
  agents: {
    codex: {
      command: "codex",
      args: ["exec", "--cd", "{repo}", "{prompt}"],
    },
    opencode: {
      command: "opencode",
      args: ["run", "{prompt}"],
    },
  },
  allowedTestCommands: ["npm test", "pnpm test", "pytest", "cargo test"],
  maxReadFileBytes: 200_000,
};

// ── Load config ───────────────────────────────────────────────────

let _config: SafeBifrostConfig | null = null;

export function loadConfig(configPath?: string): SafeBifrostConfig {
  if (_config) return _config;

  const explicitPath = configPath || process.env.SAFE_BIFROST_CONFIG;
  const candidatePaths = explicitPath
    ? [explicitPath]
    : [
        resolve(process.cwd(), "safe-bifrost.config.json"),
        resolve(process.cwd(), ".safe-bifrost.json"),
      ];

  for (const p of candidatePaths) {
    if (existsSync(p)) {
      try {
        const rawText = stripBom(readFileSync(p, "utf-8"));
        const raw = JSON.parse(rawText);
        _config = normalizeConfig({ ...DEFAULT_CONFIG, ...raw } as SafeBifrostConfig);
        return _config;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to load Safe-Bifrost config "${p}": ${message}`);
      }
    }
  }

  if (explicitPath) {
    throw new Error(`Safe-Bifrost config not found: "${explicitPath}"`);
  }

  _config = normalizeConfig({ ...DEFAULT_CONFIG });
  return _config;
}

export function getConfig(): SafeBifrostConfig {
  if (!_config) return loadConfig();
  return _config;
}

/** Resolve workspaceRoot: expand relative paths */
export function resolveWorkspaceRoot(config: SafeBifrostConfig): string {
  return resolve(config.workspaceRoot);
}

/** Resolve plans/tasks dirs relative to workspaceRoot */
export function getPlansDir(config: SafeBifrostConfig): string {
  return resolve(config.workspaceRoot, config.plansDir);
}

export function getTasksDir(config: SafeBifrostConfig): string {
  return resolve(config.workspaceRoot, config.tasksDir);
}

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function normalizeConfig(config: SafeBifrostConfig): SafeBifrostConfig {
  if (!config.workspaceRoot || typeof config.workspaceRoot !== "string") {
    throw new Error("workspaceRoot must be a non-empty string");
  }
  if (!config.plansDir || typeof config.plansDir !== "string") {
    throw new Error("plansDir must be a non-empty string");
  }
  if (!config.tasksDir || typeof config.tasksDir !== "string") {
    throw new Error("tasksDir must be a non-empty string");
  }
  if (!config.agents || typeof config.agents !== "object") {
    throw new Error("agents must be an object");
  }
  if (!Array.isArray(config.allowedTestCommands)) {
    throw new Error("allowedTestCommands must be an array");
  }
  if (!Number.isFinite(config.maxReadFileBytes) || config.maxReadFileBytes <= 0) {
    throw new Error("maxReadFileBytes must be a positive number");
  }

  return {
    ...config,
    workspaceRoot: resolve(config.workspaceRoot),
  };
}
