import { appendFileSync, existsSync, statSync } from "node:fs";
import { delimiter, isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { redactSensitiveContent } from "../security/contentRedaction.js";

const WINDOWS_BASE_ENVIRONMENT = [
  "SystemRoot",
  "WINDIR",
  "ComSpec",
  "PATHEXT",
  "PATH",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "HOME",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "JAVA_HOME",
  "ANDROID_HOME",
  "ANDROID_SDK_ROOT",
  "CARGO_HOME",
  "RUSTUP_HOME",
  "GOPATH",
  "GOROOT",
  "PYTHONHOME",
  "VIRTUAL_ENV",
] as const;

const POSIX_BASE_ENVIRONMENT = [
  "PATH",
  "HOME",
  "TMPDIR",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
] as const;

const ALWAYS_BLOCKED_ENVIRONMENT = new Set([
  "CONTROL_PLANE_API_KEY",
  "PATCHWARDEN_OWNER_TOKEN",
]);

const WINDOWS_EXECUTABLE_EXTENSIONS = [".COM", ".EXE", ".BAT", ".CMD"];
const LOG_TRUNCATION_MARKER = "\n[PATCHWARDEN LOG TRUNCATED]\n";
export const DEFAULT_MAX_PROCESS_LOG_BYTES = 2 * 1024 * 1024;

export interface ChildEnvironmentOptions {
  cwd: string;
  allowedNames?: readonly string[];
  blockedNames?: readonly string[];
  sourceEnvironment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

export interface ExecutableResolutionOptions {
  platform?: NodeJS.Platform;
  pathValue?: string;
  pathExtValue?: string;
  fileExists?: (path: string) => boolean;
}

export interface ResolvedProcessCommand {
  command: string;
  argsPrefix: string[];
}

export interface PreparedProcessCommand {
  command: string;
  args: string[];
}

/**
 * Build the environment for a task-owned child. Provider credentials are not
 * ambient capability: an agent receives them only when their variable names
 * are explicitly allow-listed in trusted local configuration.
 */
export function buildChildEnvironment(options: ChildEnvironmentOptions): NodeJS.ProcessEnv {
  const source = options.sourceEnvironment ?? process.env;
  const platform = options.platform ?? process.platform;
  const blocked = new Set([
    ...ALWAYS_BLOCKED_ENVIRONMENT,
    ...(options.blockedNames ?? []).map((name) => name.toUpperCase()),
  ]);
  const requested = [
    ...(platform === "win32" ? WINDOWS_BASE_ENVIRONMENT : POSIX_BASE_ENVIRONMENT),
    ...(options.allowedNames ?? []),
  ];
  const environment: NodeJS.ProcessEnv = {};

  for (const name of requested) {
    if (!isEnvironmentVariableName(name)) {
      throw new Error(`Invalid child environment variable name: "${name}"`);
    }
    if (blocked.has(name.toUpperCase())) continue;
    const entry = findEnvironmentEntry(source, name, platform);
    if (entry && entry[1] !== undefined) environment[entry[0]] = entry[1];
  }

  const pathEntry = findEnvironmentEntry(environment, "PATH", platform);
  if (pathEntry) {
    environment[pathEntry[0]] = sanitizeTrustedPath(pathEntry[1] || "", options.cwd, platform);
  }
  return environment;
}

/** Build a non-interactive Git environment that disables repo-defined hooks and fsmonitor. */
export function buildGitEnvironment(cwd: string): NodeJS.ProcessEnv {
  const environment = buildChildEnvironment({ cwd });
  environment.GIT_OPTIONAL_LOCKS = "0";
  environment.GIT_TERMINAL_PROMPT = "0";
  environment.GCM_INTERACTIVE = "Never";
  environment.GIT_CONFIG_COUNT = "2";
  environment.GIT_CONFIG_KEY_0 = "core.fsmonitor";
  environment.GIT_CONFIG_VALUE_0 = "false";
  environment.GIT_CONFIG_KEY_1 = "core.hooksPath";
  environment.GIT_CONFIG_VALUE_1 = "/dev/null";
  return environment;
}

/** Resolve a Windows bare command before spawn so CreateProcess never searches cwd. */
export function resolveTrustedExecutable(
  command: string,
  cwd: string,
  options: ExecutableResolutionOptions = {},
): string {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32" || win32.isAbsolute(command)) return command;
  if (!command || /[\\/]/.test(command)) {
    throw new Error(`Executable must be an absolute path or bare command name: "${command}"`);
  }

  const trustedPath = sanitizeTrustedPath(
    options.pathValue ?? process.env.PATH ?? "",
    cwd,
    platform,
  );
  const roots = trustedPath.split(win32.delimiter).filter(Boolean);
  const extension = win32.extname(command);
  const configuredExtensions = (options.pathExtValue ?? process.env.PATHEXT ?? "")
    .split(win32.delimiter)
    .map((value) => value.trim().toUpperCase())
    .filter((value) => WINDOWS_EXECUTABLE_EXTENSIONS.includes(value));
  const extensions = extension
    ? [""]
    : [...new Set([...configuredExtensions, ...WINDOWS_EXECUTABLE_EXTENSIONS])];
  const fileExists = options.fileExists ?? existsSync;

  for (const root of roots) {
    for (const suffix of extensions) {
      const candidate = win32.resolve(root, `${command}${suffix}`);
      if (isPathInside(candidate, cwd, "win32")) continue;
      if (fileExists(candidate)) return candidate;
    }
  }
  throw new Error(`Executable not found in trusted PATH: "${command}"`);
}

/**
 * Resolve Windows package-manager shims to their JavaScript CLI entry point.
 * This keeps npm/npx/pnpm execution shell-free while still supporting their
 * normal .cmd installations.
 */
export function resolvePackageManagerInvocation(
  managerCommand: string,
  cwd: string,
  options: ExecutableResolutionOptions = {},
): ResolvedProcessCommand {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return { command: managerCommand, argsPrefix: [] };
  const manager = win32.basename(managerCommand).replace(/\.(?:cmd|bat|exe|com)$/i, "").toLowerCase();
  if (!new Set(["npm", "npx", "pnpm"]).has(manager)) {
    throw new Error(`Unsupported package manager command: "${managerCommand}"`);
  }
  const resolved = resolveTrustedExecutable(managerCommand, cwd, options);
  if (/\.(?:exe|com)$/i.test(resolved)) return { command: resolved, argsPrefix: [] };

  const fileExists = options.fileExists ?? existsSync;
  const roots: string[] = [];
  let current = win32.dirname(resolved);
  for (let depth = 0; depth < 5; depth++) {
    roots.push(current);
    const parent = win32.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const relativeCliPaths = manager === "npm"
    ? ["node_modules\\npm\\bin\\npm-cli.js"]
    : manager === "npx"
      ? ["node_modules\\npm\\bin\\npx-cli.js"]
      : [
          "node_modules\\pnpm\\bin\\pnpm.cjs",
          "node_modules\\pnpm\\bin\\pnpm.mjs",
          "node\\node_modules\\pnpm\\bin\\pnpm.cjs",
          "node\\node_modules\\pnpm\\bin\\pnpm.mjs",
        ];
  for (const root of roots) {
    for (const relativeCli of relativeCliPaths) {
      const cliPath = win32.join(root, relativeCli);
      if (fileExists(cliPath)) return { command: process.execPath, argsPrefix: [cliPath] };
    }
  }
  throw new Error(`Native CLI entry point not found for trusted package-manager shim: "${resolved}"`);
}

/** Replace the one supported Windows cmd wrapper with a native Node CLI. */
export function prepareShellFreeCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  options: ExecutableResolutionOptions = {},
): PreparedProcessCommand {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return { command, args: [...args] };
  }
  // Node cannot reliably execute a .cmd shim with shell:false on Windows.
  // Resolve direct package-manager invocations to their JavaScript CLI too,
  // so callers do not need to manufacture a cmd.exe /c wrapper.
  if (/^(?:npm|npx|pnpm)(?:\.cmd)?$/i.test(win32.basename(command))) {
    const resolved = resolvePackageManagerInvocation(command, cwd, options);
    return { command: resolved.command, args: [...resolved.argsPrefix, ...args] };
  }
  if (!/^cmd(?:\.exe)?$/i.test(win32.basename(command))) {
    return { command, args: [...args] };
  }
  const commandIndex = args.findIndex((arg) => /^\/c$/i.test(arg));
  const prefix = commandIndex >= 0 ? args.slice(0, commandIndex) : [];
  const manager = commandIndex >= 0 ? args[commandIndex + 1] : undefined;
  if (
    commandIndex < 0
    || prefix.some((arg) => !/^\/(?:d|s)$/i.test(arg))
    || !manager
    || !/^(?:npm|npx|pnpm)(?:\.cmd)?$/i.test(manager)
  ) {
    throw new Error("Windows command shells are not allowed for task-owned child processes");
  }
  const resolved = resolvePackageManagerInvocation(manager, cwd, options);
  return {
    command: resolved.command,
    args: [...resolved.argsPrefix, ...args.slice(commandIndex + 2)],
  };
}

/** Parse the intentionally simple allow-listed command grammar without a shell. */
export function resolveTrustedCommandLine(
  commandLine: string,
  cwd: string,
  options: ExecutableResolutionOptions = {},
): ResolvedProcessCommand {
  const parts = commandLine.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) throw new Error("Command must not be empty");
  if (parts.some((part) => /[\x00-\x1f"'|&;<>()`$]/.test(part))) {
    throw new Error(`Command contains unsupported shell syntax: "${commandLine}"`);
  }
  if (/^(?:npm|npx|pnpm)(?:\.cmd)?$/i.test(parts[0])) {
    const manager = resolvePackageManagerInvocation(parts[0], cwd, options);
    return { command: manager.command, argsPrefix: [...manager.argsPrefix, ...parts.slice(1)] };
  }
  return {
    command: resolveTrustedExecutable(parts[0], cwd, options),
    argsPrefix: parts.slice(1),
  };
}

export function sanitizeTrustedPath(
  pathValue: string,
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const pathApi = platform === "win32" ? win32 : { delimiter, isAbsolute, relative, resolve, sep };
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const rawEntry of pathValue.split(pathApi.delimiter)) {
    const unquoted = rawEntry.trim().replace(/^"|"$/g, "");
    if (!unquoted || !pathApi.isAbsolute(unquoted)) continue;
    const absolute = pathApi.resolve(unquoted);
    if (isPathInside(absolute, cwd, platform)) continue;
    const comparable = platform === "win32" ? absolute.toLowerCase() : absolute;
    if (seen.has(comparable)) continue;
    seen.add(comparable);
    entries.push(absolute);
  }
  return entries.join(pathApi.delimiter);
}

export function allowedEnvironmentValues(
  names: readonly string[] | undefined,
  sourceEnvironment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const values = new Set<string>();
  for (const name of names ?? []) {
    if (ALWAYS_BLOCKED_ENVIRONMENT.has(name.toUpperCase())) continue;
    const value = findEnvironmentEntry(sourceEnvironment, name, platform)?.[1];
    if (value && Buffer.byteLength(value, "utf-8") >= 8) values.add(value);
  }
  return [...values].sort((left, right) => right.length - left.length);
}

export function redactProcessOutput(input: string, exactValues: readonly string[] = []): string {
  let content = redactSensitiveContent(input).content;
  for (const value of exactValues) {
    if (value) content = content.split(value).join("[REDACTED ENV VALUE]");
  }
  return content;
}

/** Captures complete process logs up to one auditable, redacted byte budget. */
export class SecureProcessLogCapture {
  private readonly chunks = new Map<string, Buffer[]>();
  private readonly maxBytes: number;
  private readonly existingBytes: number;
  private capturedBytes = 0;
  private truncatedPath: string | null = null;

  constructor(paths: Array<string | undefined>, maxBytes = DEFAULT_MAX_PROCESS_LOG_BYTES) {
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
      throw new Error("maxLogBytes must be a positive integer");
    }
    this.maxBytes = maxBytes;
    const uniquePaths = [...new Set(paths.filter((path): path is string => Boolean(path)))];
    this.existingBytes = uniquePaths.reduce((total, path) => total + fileSize(path), 0);
  }

  append(path: string | undefined, chunk: Buffer | string): void {
    if (!path) return;
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf-8");
    const remaining = Math.max(0, this.maxBytes - this.existingBytes - this.capturedBytes);
    const accepted = data.subarray(0, remaining);
    if (accepted.length > 0) {
      const chunks = this.chunks.get(path) ?? [];
      chunks.push(accepted);
      this.chunks.set(path, chunks);
      this.capturedBytes += accepted.length;
    }
    if (accepted.length < data.length) this.truncatedPath = path;
  }

  flush(exactValues: readonly string[] = []): void {
    if (this.chunks.size === 0 && !this.truncatedPath) return;
    const remaining = Math.max(0, this.maxBytes - this.existingBytes);
    const entries = [...this.chunks.entries()];
    if (this.truncatedPath && !this.chunks.has(this.truncatedPath)) {
      entries.push([this.truncatedPath, []]);
    }

    const markerBudget = this.truncatedPath
      ? Math.min(remaining, Buffer.byteLength(LOG_TRUNCATION_MARKER, "utf-8"))
      : 0;
    let contentRemaining = remaining - markerBudget;
    for (const [path, chunks] of entries) {
      const redacted = redactProcessOutput(Buffer.concat(chunks).toString("utf-8"), exactValues);
      const content = utf8Prefix(redacted, contentRemaining);
      contentRemaining -= Buffer.byteLength(content, "utf-8");
      const marker = path === this.truncatedPath
        ? utf8Prefix(LOG_TRUNCATION_MARKER, markerBudget)
        : "";
      const output = content + marker;
      if (output) {
        try { appendFileSync(path, output, "utf-8"); } catch { /* evidence logging is best effort */ }
      }
    }
  }
}

function findEnvironmentEntry(
  environment: NodeJS.ProcessEnv,
  name: string,
  platform: NodeJS.Platform,
): [string, string | undefined] | undefined {
  if (platform !== "win32") {
    return Object.prototype.hasOwnProperty.call(environment, name) ? [name, environment[name]] : undefined;
  }
  const match = Object.keys(environment).find((key) => key.toUpperCase() === name.toUpperCase());
  return match ? [match, environment[match]] : undefined;
}

function isEnvironmentVariableName(name: string): boolean {
  return typeof name === "string" && name.length > 0 && !/[=\x00]/.test(name);
}

function isPathInside(candidate: string, parent: string, platform: NodeJS.Platform): boolean {
  const pathApi = platform === "win32" ? win32 : { relative, isAbsolute, sep };
  const rel = pathApi.relative(parent, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(rel));
}

function fileSize(path: string): number {
  try { return statSync(path).size; } catch { return 0; }
}

function utf8Prefix(value: string, maxBytes: number): string {
  const encoded = Buffer.from(value, "utf-8");
  if (encoded.length <= maxBytes) return value;
  let prefix = encoded.subarray(0, maxBytes).toString("utf-8").replace(/\uFFFD$/u, "");
  while (Buffer.byteLength(prefix, "utf-8") > maxBytes) prefix = prefix.slice(0, -1);
  return prefix;
}
