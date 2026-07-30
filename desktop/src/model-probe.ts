import { createHash, randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { getAgentAdapter, validateModelId } from "./agent-adapters.js";
import type { AgentDetection } from "./agent-adapters.js";
import { buildDesktopChildEnvironment } from "./child-environment.js";
import { atomicWriteJson, readJson } from "./config-store.js";

const execFileAsync = promisify(execFile);
const PROBE_TIMEOUT_MS = 20_000;
const PROBE_TERMINATION_GRACE_MS = 2_250;
const PROBE_FORCE_CLOSE_GRACE_MS = 250;
const MAX_OUTPUT_BYTES = 8 * 1024;
const PROBE_TEMPLATE_VERSION = 1;
const MAX_CACHE_ENTRIES = 128;
export const MODEL_PROBE_TTL_MS = 15 * 60 * 1000;
const MAX_PROBE_FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1000;

export type ModelProbeAgent = "codex" | "opencode" | "claude";
export type ModelProbeStatus = "verified" | "failed" | "unsupported_safe_probe";
export type ModelProbeReason =
  | "ok"
  | "agent_unavailable"
  | "unsupported_safe_probe"
  | "probe_timed_out"
  | "authentication_failed"
  | "model_rejected"
  | "probe_failed"
  | "probe_output_invalid";

export interface ModelProbeRecord {
  readonly agentId: ModelProbeAgent;
  readonly modelId: string;
  readonly executableFingerprint: string;
  readonly templateVersion: number;
  readonly status: ModelProbeStatus;
  readonly reasonCode: ModelProbeReason;
  readonly checkedAt: string;
  readonly durationMs: number;
  readonly exitCode: number | null;
  readonly outputTruncated: boolean;
}

export interface VerifyAgentModelOptions {
  readonly agentId: string;
  readonly modelId: unknown;
  readonly detection: AgentDetection | null | undefined;
  readonly probeRoot: string;
  readonly cachePath: string;
  readonly envAllowlist?: readonly string[];
  readonly blockedEnvNames?: readonly string[];
  readonly sourceEnvironment?: NodeJS.ProcessEnv;
  /** Optional bounded overrides used by narrow tests and callers that need a shorter deadline. */
  readonly probeTimeoutMs?: number;
  readonly terminationGraceMs?: number;
}

const activeProbes = new Map<string, Promise<ModelProbeRecord>>();

export function isModelProbeAgent(id: string): id is ModelProbeAgent {
  return id === "codex" || id === "opencode" || id === "claude";
}

export function findModelProbeRecord(
  cachePath: string,
  agentId: string,
  modelId: string | null | undefined,
  detection: Pick<AgentDetection, "command" | "prefixArgs" | "executablePath">,
  nowMs: number = Date.now(),
): ModelProbeRecord | null {
  if (!isModelProbeAgent(agentId) || !modelId) return null;
  const key = probeKey(agentId, modelId, detection);
  const entry = readProbeCache(cachePath).entries.find((candidate) => cacheKey(candidate) === key) || null;
  if (!entry) return null;
  const ageMs = nowMs - Date.parse(entry.checkedAt);
  return ageMs > MODEL_PROBE_TTL_MS || ageMs < -MAX_PROBE_FUTURE_CLOCK_SKEW_MS ? null : entry;
}

export function buildModelProbeArgs(agentId: Exclude<ModelProbeAgent, "opencode">, modelId: string, nonce: string, mcpConfigPath: string): string[] {
  const prompt = `Reply with exactly ${nonce}. Do not use tools, read files, write files, or run commands.`;
  if (agentId === "codex") {
    return [
      "exec", "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral", "--color", "never",
      "--model", modelId, prompt,
    ];
  }
  return [
    "--print", "--model", modelId, "--permission-mode", "plan", "--no-session-persistence",
    "--output-format", "json", "--strict-mcp-config", "--mcp-config", mcpConfigPath, "--tools", "", prompt,
  ];
}

/** Run an explicit, bounded provider check. OpenCode fails closed until it exposes a no-tools mode. */
export function verifyAgentModel(options: VerifyAgentModelOptions): Promise<ModelProbeRecord> {
  const modelId = validateModelId(options.modelId);
  if (!isModelProbeAgent(options.agentId) || !modelId) throw new Error("Unsupported model probe request");
  const key = probeKey(options.agentId, modelId, options.detection || emptyDetection());
  const existing = activeProbes.get(key);
  if (existing) return existing;
  const probe = runProbe({ ...options, agentId: options.agentId, modelId });
  activeProbes.set(key, probe);
  void probe.finally(() => activeProbes.delete(key));
  return probe;
}

async function runProbe(options: VerifyAgentModelOptions & { agentId: ModelProbeAgent; modelId: string }): Promise<ModelProbeRecord> {
  const startedAt = Date.now();
  const detection = options.detection;
  if (!detection?.available || !detection.command || !getAgentAdapter(options.agentId)) {
    return persist(options, record(options, startedAt, "failed", "agent_unavailable", null, false));
  }
  if (options.agentId === "opencode") {
    return persist(options, record(options, startedAt, "unsupported_safe_probe", "unsupported_safe_probe", null, false));
  }

  let tempDir: string | null = null;
  try {
    tempDir = createProbeDirectory(options.probeRoot);
    const mcpConfigPath = join(tempDir, "empty-mcp.json");
    writeFileSync(mcpConfigPath, "{\"mcpServers\":{}}\n", { encoding: "utf8", flag: "wx" });
    const nonce = `PATCHWARDEN_MODEL_PROBE_${randomBytes(12).toString("hex")}`;
    const args = [
      ...(detection.prefixArgs || []),
      ...buildModelProbeArgs(options.agentId, options.modelId, nonce, mcpConfigPath),
    ];
    const result = await runOwnedProcess(detection.command, args, tempDir, options);
    const outcome = result.timedOut
      ? record(options, startedAt, "failed", "probe_timed_out", null, result.truncated)
      : result.exitCode === 0 && modelProbeOutputMatches(options.agentId, result.stdout, nonce)
        ? record(options, startedAt, "verified", "ok", result.exitCode, result.truncated)
        : record(options, startedAt, "failed", classifyFailure(result.stderr, result.exitCode), result.exitCode, result.truncated);
    return persist(options, outcome);
  } catch {
    return persist(options, record(options, startedAt, "failed", "probe_failed", null, false));
  } finally {
    if (tempDir) removeProbeDirectory(options.probeRoot, tempDir);
  }
}

function record(
  options: VerifyAgentModelOptions & { agentId: ModelProbeAgent; modelId: string },
  startedAt: number,
  status: ModelProbeStatus,
  reasonCode: ModelProbeReason,
  exitCode: number | null,
  outputTruncated: boolean,
): ModelProbeRecord {
  const detection = options.detection || emptyDetection();
  return {
    agentId: options.agentId,
    modelId: options.modelId,
    executableFingerprint: executableFingerprint(detection),
    templateVersion: PROBE_TEMPLATE_VERSION,
    status,
    reasonCode,
    checkedAt: new Date().toISOString(),
    durationMs: Math.max(0, Date.now() - startedAt),
    exitCode,
    outputTruncated,
  };
}

function persist(options: VerifyAgentModelOptions, value: ModelProbeRecord): ModelProbeRecord {
  const cache = readProbeCache(options.cachePath);
  const entries = [value, ...cache.entries.filter((entry) => cacheKey(entry) !== cacheKey(value))].slice(0, MAX_CACHE_ENTRIES);
  atomicWriteJson(options.cachePath, { schemaVersion: 1, entries }, false);
  return value;
}

function createProbeDirectory(root: string): string {
  const resolvedRoot = resolve(root);
  mkdirSync(resolvedRoot, { recursive: true });
  const tempDir = mkdtempSync(join(resolvedRoot, "probe-"));
  if (!inside(resolvedRoot, tempDir)) {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* newly-created path only */ }
    throw new Error("Model probe directory escaped its owner root");
  }
  return tempDir;
}

function removeProbeDirectory(root: string, tempDir: string): void {
  if (!inside(resolve(root), tempDir)) return;
  try { rmSync(tempDir, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 }); } catch { /* next probe start can retry cleanup */ }
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, resolve(candidate));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);
}

async function runOwnedProcess(
  command: string,
  args: readonly string[],
  cwd: string,
  options: VerifyAgentModelOptions,
): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; truncated: boolean }> {
  const isolatedHome = join(cwd, "home");
  const isolatedAppData = join(cwd, "appdata");
  const isolatedLocalAppData = join(cwd, "local-appdata");
  const isolatedXdg = join(cwd, "xdg-config");
  const isolatedCodexHome = join(cwd, "codex-home");
  const isolatedClaudeConfig = join(cwd, "claude-config");
  for (const directory of [
    isolatedHome, isolatedAppData, isolatedLocalAppData, isolatedXdg,
    isolatedCodexHome, isolatedClaudeConfig,
  ]) mkdirSync(directory, { recursive: true });
  const env = buildDesktopChildEnvironment({
    sourceEnvironment: options.sourceEnvironment,
    allowedNames: options.envAllowlist,
    blockedNames: options.blockedEnvNames,
    overrides: {
      TMP: cwd,
      TEMP: cwd,
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      APPDATA: isolatedAppData,
      LOCALAPPDATA: isolatedLocalAppData,
      XDG_CONFIG_HOME: isolatedXdg,
      CODEX_HOME: isolatedCodexHome,
      CLAUDE_CONFIG_DIR: isolatedClaudeConfig,
    },
  });
  return new Promise((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    let terminationFallback: NodeJS.Timeout | undefined;
    let forcedCloseFallback: NodeJS.Timeout | undefined;
    const child = spawn(command, [...args], { cwd, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const append = (current: string, value: Buffer): string => {
      const remaining = MAX_OUTPUT_BYTES - Buffer.byteLength(current, "utf8");
      if (remaining <= 0) { truncated = true; return current; }
      if (value.length <= remaining) return current + value.toString("utf8");
      truncated = true;
      let bounded = value.subarray(0, remaining).toString("utf8");
      while (bounded && Buffer.byteLength(current + bounded, "utf8") > MAX_OUTPUT_BYTES) {
        bounded = bounded.slice(0, -1);
      }
      return current + bounded;
    };
    child.stdout?.on("data", (value: Buffer) => { stdout = append(stdout, value); });
    child.stderr?.on("data", (value: Buffer) => { stderr = append(stderr, value); });
    const finish = (exitCode: number | null, forced = false) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (terminationFallback) clearTimeout(terminationFallback);
      if (forcedCloseFallback) clearTimeout(forcedCloseFallback);
      if (forced) {
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
      }
      resolvePromise({ exitCode, stdout, stderr, timedOut, truncated });
    };
    child.on("error", () => finish(null));
    child.on("close", (exitCode) => finish(exitCode));
    timeout = setTimeout(() => {
      timedOut = true;
      void terminateOwnedProcess(child);
      terminationFallback = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          try { child.kill("SIGKILL"); } catch { /* owned child may already have exited */ }
        }
        forcedCloseFallback = setTimeout(() => finish(null, true), PROBE_FORCE_CLOSE_GRACE_MS);
      }, boundedDuration(options.terminationGraceMs, PROBE_TERMINATION_GRACE_MS));
    }, boundedDuration(options.probeTimeoutMs, PROBE_TIMEOUT_MS));
  });
}

/** Accept only the provider response field, never a CLI echo of the prompt. */
export function modelProbeOutputMatches(
  agentId: Exclude<ModelProbeAgent, "opencode">,
  stdout: string,
  nonce: string,
): boolean {
  if (agentId === "codex") return stdout.trim() === nonce;
  try {
    const value: unknown = JSON.parse(stdout.trim());
    return isRecord(value) && typeof value.result === "string" && value.result.trim() === nonce;
  } catch {
    return false;
  }
}

async function terminateOwnedProcess(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== "win32") {
    try { child.kill("SIGTERM"); } catch { /* already exited */ }
    return;
  }
  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  const taskkill = systemRoot ? join(systemRoot, "System32", "taskkill.exe") : "";
  if (taskkill && existsSync(taskkill)) {
    try {
      await execFileAsync(taskkill, ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 2_000, maxBuffer: 1024, shell: false });
      return;
    } catch { /* fall back to the exact owned child below */ }
  }
  try { child.kill("SIGKILL"); } catch { /* already exited */ }
}

function boundedDuration(value: number | undefined, maximum: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? Math.min(value, maximum)
    : maximum;
}

function classifyFailure(stderr: string, exitCode: number | null): ModelProbeReason {
  const text = stderr.slice(0, MAX_OUTPUT_BYTES);
  if (/auth|login|credential|unauthori[sz]ed|forbidden/i.test(text)) return "authentication_failed";
  if (/model|not[ -]?found|unknown/i.test(text)) return "model_rejected";
  if (exitCode === 0) return "probe_output_invalid";
  return "probe_failed";
}

function probeKey(agentId: ModelProbeAgent, modelId: string, detection: Pick<AgentDetection, "command" | "prefixArgs" | "executablePath">): string {
  return createHash("sha256").update(`${agentId}\0${modelId}\0${executableFingerprint(detection)}\0${PROBE_TEMPLATE_VERSION}`).digest("hex");
}

function executableFingerprint(detection: Pick<AgentDetection, "command" | "prefixArgs" | "executablePath">): string {
  return createHash("sha256").update([detection.executablePath || detection.command || "", ...(detection.prefixArgs || [])].join("\0")).digest("hex");
}

function cacheKey(value: ModelProbeRecord): string {
  return createHash("sha256").update(`${value.agentId}\0${value.modelId}\0${value.executableFingerprint}\0${value.templateVersion}`).digest("hex");
}

function readProbeCache(path: string): { entries: ModelProbeRecord[] } {
  const value = readJson(path);
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.entries)) return { entries: [] };
  return { entries: value.entries.map(normalizeRecord).filter((entry): entry is ModelProbeRecord => entry !== null) };
}

function normalizeRecord(value: unknown): ModelProbeRecord | null {
  if (!isRecord(value) || typeof value.modelId !== "string") return null;
  const agentId = String(value.agentId);
  if (!isModelProbeAgent(agentId)) return null;
  try { if (!validateModelId(value.modelId)) return null; } catch { return null; }
  if (typeof value.executableFingerprint !== "string" || !/^[a-f0-9]{64}$/i.test(value.executableFingerprint)) return null;
  if (value.templateVersion !== PROBE_TEMPLATE_VERSION || typeof value.checkedAt !== "string" || !Number.isFinite(Date.parse(value.checkedAt))) return null;
  if (typeof value.durationMs !== "number" || !Number.isSafeInteger(value.durationMs) || value.durationMs < 0 || typeof value.outputTruncated !== "boolean") return null;
  if (value.exitCode !== null && (typeof value.exitCode !== "number" || !Number.isInteger(value.exitCode))) return null;
  if (value.status !== "verified" && value.status !== "failed" && value.status !== "unsupported_safe_probe") return null;
  const reasonCode = String(value.reasonCode);
  if (!new Set<ModelProbeReason>([
    "ok", "agent_unavailable", "unsupported_safe_probe", "probe_timed_out", "authentication_failed",
    "model_rejected", "probe_failed", "probe_output_invalid",
  ]).has(reasonCode as ModelProbeReason)) return null;
  return {
    agentId,
    modelId: value.modelId,
    executableFingerprint: value.executableFingerprint,
    templateVersion: PROBE_TEMPLATE_VERSION,
    status: value.status,
    reasonCode: reasonCode as ModelProbeReason,
    checkedAt: value.checkedAt,
    durationMs: value.durationMs,
    exitCode: value.exitCode as number | null,
    outputTruncated: value.outputTruncated,
  };
}

function emptyDetection(): Pick<AgentDetection, "command" | "prefixArgs" | "executablePath"> {
  return { command: null, prefixArgs: [], executablePath: null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

