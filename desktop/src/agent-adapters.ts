import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import {
  buildDesktopChildEnvironment,
  resolveTrustedWhere,
} from "./child-environment.js";

const execFileAsync = promisify(execFile);
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;

/** Function that builds CLI args for an agent given an optional model override. */
type BuildArgsFn = (model: string | null) => string[];

/** Static descriptor for a supported agent CLI adapter. */
export interface AgentAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly npmPackage?: string;
  readonly nativePackage?: string;
  readonly buildArgs: BuildArgsFn;
  readonly refreshArgs?: readonly string[];
}

/** Result of selecting a launch executable for an agent. */
export interface AgentLaunch {
  readonly command: string;
  readonly prefixArgs: readonly string[];
  readonly source: "native" | "npm-native" | "npm-package";
}

/** Detection result for a single agent adapter. */
export interface AgentDetection {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
  readonly available: boolean;
  readonly command: string | null;
  readonly prefixArgs: readonly string[];
  readonly executablePath: string | null;
  readonly source: AgentLaunch["source"] | null;
  readonly supportsModelOverride: boolean;
  readonly supportsModelRefresh: boolean;
  readonly reason: string | null;
}

/** Loose input shape accepted by buildConfig (tests pass partial objects). */
export interface AgentDetectionInput {
  readonly id?: string;
  readonly name?: string;
  readonly available?: boolean;
  readonly command?: string | null;
  readonly executablePath?: string | null;
  readonly prefixArgs?: readonly string[];
}

/** Registration entry written into the PatchWarden config. */
export interface AgentRegistration {
  readonly command: string;
  readonly args: readonly string[];
  readonly adapter?: string;
  readonly model?: string;
  readonly envAllowlist?: readonly string[];
}

/** A model discovered from local agent config files. */
export interface DiscoveredModel {
  readonly id: string;
  readonly label: string;
  readonly source: string;
}

export type FileExistsFn = (path: string) => boolean;
export type ReadTextFn = (path: string) => string;

export interface SelectAgentLaunchOptions {
  readonly fileExists?: FileExistsFn;
  readonly nodeOutput?: string;
  readonly readText?: ReadTextFn;
}

export interface RefreshAgentModelsOptions {
  readonly cwd?: string;
  readonly envAllowlist?: readonly string[];
  readonly blockedEnvNames?: readonly string[];
  readonly sourceEnvironment?: NodeJS.ProcessEnv;
}

function withModel(args: readonly string[], model: string | null): string[] {
  return model ? [...args, "--model", model] : [...args];
}

export const AGENT_ADAPTERS: readonly AgentAdapter[] = Object.freeze([
  { id: "codex", displayName: "Codex CLI", npmPackage: "@openai/codex", buildArgs: (model) => [...withModel(["exec", "--cd", "{repo}"], model), "{prompt}"] },
  { id: "opencode", displayName: "OpenCode", nativePackage: "opencode-ai", buildArgs: (model) => ["run", ...withModel([], model), "{prompt}"], refreshArgs: ["models"] },
  { id: "claude", displayName: "Claude Code", npmPackage: "@anthropic-ai/claude-code", buildArgs: (model) => [...withModel(["--print", "--permission-mode", "acceptEdits"], model), "{prompt}"] },
  { id: "gemini", displayName: "Gemini CLI", npmPackage: "@google/gemini-cli", buildArgs: (model) => [...withModel(["--prompt", "{prompt}", "--approval-mode", "auto_edit"], model)] },
  { id: "copilot", displayName: "GitHub Copilot CLI", npmPackage: "@github/copilot", buildArgs: (model) => [...withModel(["-p", "{prompt}", "--allow-tool", "write", "--deny-tool", "shell"], model)], refreshArgs: ["help"] },
  { id: "qwen", displayName: "Qwen Code", npmPackage: "@qwen-code/qwen-code", buildArgs: (model) => [...withModel(["--prompt", "{prompt}", "--approval-mode", "auto-edit"], model)] },
  { id: "kimi", displayName: "Kimi Code", buildArgs: (model) => [...withModel(["--prompt", "{prompt}", "--work-dir", "{repo}"], model)] },
  { id: "aider", displayName: "Aider", buildArgs: (model) => [...withModel(["--message", "{prompt}"], model)], refreshArgs: ["--list-models", ""] },
]);

const ADAPTER_BY_ID = new Map<string, AgentAdapter>(AGENT_ADAPTERS.map((adapter) => [adapter.id, adapter]));

export function getAgentAdapter(id: string | undefined | null): AgentAdapter | null {
  if (!id) return null;
  return ADAPTER_BY_ID.get(id) || null;
}

export function validateModelId(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const model = String(value).trim();
  if (!MODEL_PATTERN.test(model)) throw new Error("模型 ID 格式无效");
  return model;
}

function isFile(path: string, fileExists: FileExistsFn = existsSync): boolean {
  try { return fileExists(path); } catch { return false; }
}

function safeNativeCandidate(candidate: string, platform: string, fileExists: FileExistsFn): string | null {
  if (!candidate || !isFile(candidate, fileExists)) return null;
  if (platform === "win32") {
    if (/\\WindowsApps\\/i.test(candidate)) return null;
    if (![".exe", ".com"].includes(extname(candidate).toLowerCase())) return null;
  }
  return candidate;
}

function resolveNpmEntry(
  adapter: AgentAdapter,
  shimDir: string,
  nodePath: string | null,
  fileExists: FileExistsFn = existsSync,
  readText: ReadTextFn = (path) => readFileSync(path, "utf8"),
): AgentLaunch | null {
  if (!adapter.npmPackage || !nodePath) return null;
  const packageRoot = resolve(shimDir, "node_modules", ...adapter.npmPackage.split("/"));
  const manifestPath = resolve(packageRoot, "package.json");
  if (!isFile(manifestPath, fileExists)) return null;
  try {
    const manifest = JSON.parse(readText(manifestPath));
    if (manifest.name !== adapter.npmPackage) return null;
    const binField = typeof manifest.bin === "string" ? manifest.bin : manifest.bin && (manifest.bin[adapter.id] || Object.values(manifest.bin)[0]);
    if (typeof binField !== "string") return null;
    const entry = resolve(packageRoot, binField);
    const rel = relative(packageRoot, entry);
    if (!rel || rel.startsWith("..") || isAbsolute(rel) || !isFile(entry, fileExists)) return null;
    return { command: nodePath, prefixArgs: [entry], source: "npm-package" };
  } catch {
    return null;
  }
}

export function selectAgentLaunch(
  id: string,
  output: string,
  platform: string = process.platform,
  options: SelectAgentLaunchOptions = {},
): AgentLaunch | null {
  const adapter = getAgentAdapter(id);
  if (!adapter) return null;
  const fileExists = options.fileExists || existsSync;
  const candidates = String(output || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const candidate of candidates) {
    const native = safeNativeCandidate(candidate, platform, fileExists);
    if (native) return { command: native, prefixArgs: [], source: "native" };
    if (platform === "win32" && adapter.nativePackage) {
      const nativeExecutable = resolve(dirname(candidate), "node_modules", adapter.nativePackage, "bin", `${id}.exe`);
      if (isFile(nativeExecutable, fileExists)) return { command: nativeExecutable, prefixArgs: [], source: "npm-native" };
    }
  }
  if (platform !== "win32") return null;
  const nodeCandidates = String(options.nodeOutput || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const nodePath = nodeCandidates.map((candidate) => safeNativeCandidate(candidate, platform, fileExists)).find(Boolean) || null;
  for (const candidate of candidates) {
    if (!/\.(?:cmd|ps1|bat)$/i.test(candidate)) continue;
    const launch = resolveNpmEntry(adapter, dirname(candidate), nodePath, fileExists, options.readText);
    if (launch) return launch;
  }
  return null;
}

export function buildAgentRegistration(
  id: string,
  detection: { available?: boolean; command?: string | null; prefixArgs?: readonly string[] } | null | undefined,
  modelValue: unknown,
): AgentRegistration {
  const adapter = getAgentAdapter(id);
  if (!adapter || !detection?.available || !detection.command) throw new Error(`Agent ${id} 不可用`);
  const model = validateModelId(modelValue);
  return {
    command: detection.command,
    args: [...(detection.prefixArgs || []), ...adapter.buildArgs(model)],
    adapter: id,
    ...(model ? { model } : {}),
  };
}

async function detectOne(adapter: AgentAdapter, platform: NodeJS.Platform): Promise<AgentDetection> {
  const env = buildDesktopChildEnvironment({ platform });
  try {
    const lookup = platform === "win32"
      ? resolveTrustedWhere(process.cwd(), { platform, sourceEnvironment: env })
      : "which";
    const [{ stdout }, nodeResult] = await Promise.all([
      execFileAsync(lookup, [adapter.id], { timeout: 5000, windowsHide: true, maxBuffer: 256 * 1024, env }),
      platform === "win32" && adapter.npmPackage
        ? execFileAsync(lookup, ["node"], { timeout: 5000, windowsHide: true, maxBuffer: 64 * 1024, env }).catch(() => ({ stdout: "" }))
        : Promise.resolve({ stdout: "" }),
    ]);
    const launch = selectAgentLaunch(adapter.id, stdout, platform, { nodeOutput: nodeResult.stdout });
    return {
      id: adapter.id,
      name: adapter.id,
      displayName: adapter.displayName,
      available: Boolean(launch),
      command: launch?.command || null,
      prefixArgs: launch?.prefixArgs || [],
      executablePath: launch?.command || null,
      source: launch?.source || null,
      supportsModelOverride: true,
      supportsModelRefresh: Boolean(adapter.refreshArgs),
      reason: launch ? null : platform === "win32" ? "未找到可安全启动的原生 CLI 或已验证 npm 入口" : "Command not found",
    };
  } catch {
    return {
      id: adapter.id,
      name: adapter.id,
      displayName: adapter.displayName,
      available: false,
      command: null,
      prefixArgs: [],
      executablePath: null,
      source: null,
      supportsModelOverride: true,
      supportsModelRefresh: Boolean(adapter.refreshArgs),
      reason: "Command not found",
    };
  }
}

export async function detectAgents(platform: NodeJS.Platform = process.platform): Promise<AgentDetection[]> {
  return Promise.all(AGENT_ADAPTERS.map((adapter) => detectOne(adapter, platform)));
}

export async function refreshAgentModels(
  id: string,
  detection: { available?: boolean; command?: string | null; prefixArgs?: readonly string[] } | null | undefined,
  options: RefreshAgentModelsOptions = {},
): Promise<DiscoveredModel[]> {
  const adapter = getAgentAdapter(id);
  if (!adapter?.refreshArgs) throw new Error("此 Agent 不支持安全的模型列表刷新");
  if (!detection?.available || !detection.command) throw new Error("Agent 当前不可用");
  const { stdout } = await execFileAsync(detection.command, [...(detection.prefixArgs || []), ...adapter.refreshArgs], {
    cwd: options.cwd,
    env: buildDesktopChildEnvironment({
      sourceEnvironment: options.sourceEnvironment,
      allowedNames: options.envAllowlist,
      blockedNames: options.blockedEnvNames,
    }),
    timeout: 15000,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
    shell: false,
  });
  const values = String(stdout || "").split(/\r?\n/).flatMap((line) => {
    const matches = line.match(/[A-Za-z0-9][A-Za-z0-9._:/@+-]{1,199}/g) || [];
    return matches.filter((value) => MODEL_PATTERN.test(value) && (value.includes("/") || /^gpt-|^claude-|^gemini-|^qwen|^kimi|^deepseek/i.test(value)));
  });
  return [...new Set(values)].sort().map((model) => ({ id: model, label: model, source: "agent-refresh" }));
}
