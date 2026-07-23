import { existsSync } from "node:fs";
import { win32 } from "node:path";

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
  "TMP",
  "TEMP",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
] as const;

const PROXY_ENVIRONMENT = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
] as const;

const ALWAYS_BLOCKED_ENVIRONMENT = new Set([
  "CONTROL_PLANE_API_KEY",
  "PATCHWARDEN_OWNER_TOKEN",
]);

export interface DesktopChildEnvironmentOptions {
  readonly sourceEnvironment?: NodeJS.ProcessEnv;
  readonly allowedNames?: readonly string[];
  readonly blockedNames?: readonly string[];
  readonly overrides?: Readonly<NodeJS.ProcessEnv>;
  readonly platform?: NodeJS.Platform;
}

export interface TrustedWindowsExecutableOptions {
  readonly sourceEnvironment?: NodeJS.ProcessEnv;
  readonly fileExists?: (path: string) => boolean;
  readonly platform?: NodeJS.Platform;
}

/** Build a least-privilege environment for Desktop-owned child processes. */
export function buildDesktopChildEnvironment(
  options: DesktopChildEnvironmentOptions = {},
): NodeJS.ProcessEnv {
  const source = options.sourceEnvironment ?? process.env;
  const platform = options.platform ?? process.platform;
  const blocked = new Set([
    ...ALWAYS_BLOCKED_ENVIRONMENT,
    ...(options.blockedNames ?? []).map(normalizeEnvironmentName),
  ]);
  const requested = [
    ...(platform === "win32" ? WINDOWS_BASE_ENVIRONMENT : POSIX_BASE_ENVIRONMENT),
    ...PROXY_ENVIRONMENT,
    ...(options.allowedNames ?? []),
  ];
  const environment: NodeJS.ProcessEnv = {};

  for (const name of requested) {
    validateEnvironmentName(name);
    if (blocked.has(normalizeEnvironmentName(name))) continue;
    const entry = findEnvironmentEntry(source, name, platform);
    if (entry?.[1] !== undefined) setEnvironmentValue(environment, entry[0], entry[1], platform);
  }

  for (const [name, value] of Object.entries(options.overrides ?? {})) {
    validateEnvironmentName(name);
    if (value === undefined || blocked.has(normalizeEnvironmentName(name))) continue;
    setEnvironmentValue(environment, name, value, platform);
  }

  return environment;
}

/** Resolve Windows PowerShell without allowing cwd or PATH executable search. */
export function resolveTrustedPowerShell(
  cwd: string,
  options: TrustedWindowsExecutableOptions = {},
): string {
  return resolveTrustedWindowsSystemExecutable(
    cwd,
    ["System32", "WindowsPowerShell", "v1.0", "powershell.exe"],
    "Windows PowerShell",
    options,
  );
}

/** Resolve where.exe from System32 so agent detection cannot search cwd. */
export function resolveTrustedWhere(
  cwd: string,
  options: TrustedWindowsExecutableOptions = {},
): string {
  return resolveTrustedWindowsSystemExecutable(cwd, ["System32", "where.exe"], "where.exe", options);
}

function resolveTrustedWindowsSystemExecutable(
  cwd: string,
  segments: readonly string[],
  displayName: string,
  options: TrustedWindowsExecutableOptions,
): string {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") throw new Error(`${displayName} is only available on Windows`);
  const source = options.sourceEnvironment ?? process.env;
  const systemRoot = findEnvironmentEntry(source, "SystemRoot", "win32")?.[1]
    || findEnvironmentEntry(source, "WINDIR", "win32")?.[1]
    || "";
  if (!win32.isAbsolute(systemRoot)) throw new Error("SystemRoot is unavailable or invalid");
  const command = win32.resolve(systemRoot, ...segments);
  if (isWindowsPathInside(command, cwd)) {
    throw new Error(`Trusted ${displayName} must not resolve inside the project directory`);
  }
  if (!(options.fileExists ?? existsSync)(command)) throw new Error(`Trusted ${displayName} was not found`);
  return command;
}

function validateEnvironmentName(name: string): void {
  if (name === "ProgramFiles(x86)") return;
  if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid child environment variable name: "${String(name)}"`);
  }
}

function normalizeEnvironmentName(name: string): string {
  validateEnvironmentName(name);
  return name.toUpperCase();
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

function setEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
  value: string,
  platform: NodeJS.Platform,
): void {
  const existing = findEnvironmentEntry(environment, name, platform)?.[0];
  environment[existing ?? name] = value;
}

function isWindowsPathInside(candidate: string, parent: string): boolean {
  const relative = win32.relative(parent, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith("..\\") && !win32.isAbsolute(relative));
}
