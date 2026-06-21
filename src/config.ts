import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// ── Type definitions ──────────────────────────────────────────────

export interface AgentConfig {
  command: string;
  args: string[];
}

export interface PatchWardenConfig {
  workspaceRoot: string;
  plansDir: string;
  tasksDir: string;
  agents: Record<string, AgentConfig>;
  allowedTestCommands: string[];
  maxReadFileBytes: number;
  defaultTaskTimeoutSeconds: number;
  maxTaskTimeoutSeconds: number;
  watcherStaleSeconds: number;
  toolProfile?: "full" | "chatgpt_core";
  repoAliases?: Record<string, string>;
}

// ── Defaults ──────────────────────────────────────────────────────

const DEFAULT_CONFIG: PatchWardenConfig = {
  workspaceRoot: process.cwd(),
  plansDir: ".patchwarden/plans",
  tasksDir: ".patchwarden/tasks",
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
  allowedTestCommands: [
    "npm test",
    "npm run test",
    "npm run lint",
    "npm run format:check",
    "npm run build",
    "npm run dist",
    "npm run doctor",
    "pnpm test",
    "pnpm run test",
    "pnpm run lint",
    "pnpm run format:check",
    "pnpm run build",
    "pnpm run dist",
    "pnpm run doctor",
    "pytest",
    "cargo test",
  ],
  maxReadFileBytes: 200_000,
  defaultTaskTimeoutSeconds: 900,
  maxTaskTimeoutSeconds: 3600,
  watcherStaleSeconds: 30,
  toolProfile: "full",
};

// ── Load config ───────────────────────────────────────────────────

let _config: PatchWardenConfig | null = null;

export function loadConfig(configPath?: string): PatchWardenConfig {
  if (_config) return _config;

  const explicitPath = configPath || process.env.PATCHWARDEN_CONFIG;
  const candidatePaths = explicitPath
    ? [explicitPath]
    : [
        resolve(process.cwd(), "patchwarden.config.json"),
        resolve(process.cwd(), ".patchwarden.json"),
      ];

  for (const p of candidatePaths) {
    if (existsSync(p)) {
      try {
        const rawText = stripBom(readFileSync(p, "utf-8"));
        const raw = JSON.parse(rawText);
        _config = normalizeConfig({ ...DEFAULT_CONFIG, ...raw } as PatchWardenConfig);
        return _config;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to load PatchWarden config "${p}": ${message}`);
      }
    }
  }

  if (explicitPath) {
    throw new Error(`PatchWarden config not found: "${explicitPath}"`);
  }

  _config = normalizeConfig({ ...DEFAULT_CONFIG });
  return _config;
}

export function getConfig(): PatchWardenConfig {
  if (!_config) return loadConfig();
  return _config;
}

/** Resolve workspaceRoot: expand relative paths */
export function resolveWorkspaceRoot(config: PatchWardenConfig): string {
  return resolve(config.workspaceRoot);
}

/** Resolve plans/tasks dirs relative to workspaceRoot */
export function getPlansDir(config: PatchWardenConfig): string {
  return resolve(config.workspaceRoot, config.plansDir);
}

export function getTasksDir(config: PatchWardenConfig): string {
  return resolve(config.workspaceRoot, config.tasksDir);
}

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function normalizeConfig(config: PatchWardenConfig): PatchWardenConfig {
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
  if (!Number.isInteger(config.defaultTaskTimeoutSeconds) || config.defaultTaskTimeoutSeconds <= 0) {
    throw new Error("defaultTaskTimeoutSeconds must be a positive integer");
  }
  if (!Number.isInteger(config.maxTaskTimeoutSeconds) || config.maxTaskTimeoutSeconds <= 0) {
    throw new Error("maxTaskTimeoutSeconds must be a positive integer");
  }
  if (config.defaultTaskTimeoutSeconds > config.maxTaskTimeoutSeconds) {
    throw new Error("defaultTaskTimeoutSeconds cannot exceed maxTaskTimeoutSeconds");
  }
  if (!Number.isInteger(config.watcherStaleSeconds) || config.watcherStaleSeconds < 5 || config.watcherStaleSeconds > 3600) {
    throw new Error("watcherStaleSeconds must be an integer from 5 to 3600");
  }
  if (config.toolProfile !== undefined && config.toolProfile !== "full" && config.toolProfile !== "chatgpt_core") {
    throw new Error('toolProfile must be "full" or "chatgpt_core"');
  }

  return {
    ...config,
    workspaceRoot: resolve(config.workspaceRoot),
  };
}
