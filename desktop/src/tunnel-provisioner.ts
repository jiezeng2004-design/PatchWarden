import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  buildDesktopChildEnvironment,
  resolveTrustedPowerShell,
} from "./child-environment.js";
import { atomicWriteJson, readJson } from "./config-store.js";
import { detectTunnelClient } from "./runtime-settings.js";

type TunnelMode = "core" | "direct";

const MODES: Readonly<Record<TunnelMode, { profile: string }>> = Object.freeze({
  core: { profile: "patchwarden" },
  direct: { profile: "patchwarden-direct" },
});

/** Public result of a tunnel provisioning or revalidation operation. */
export interface ProvisionResult {
  readonly ok: boolean;
  readonly reason_code: string;
  readonly next_step: string | null;
}

/** Status snapshot returned to the renderer. */
export interface TunnelSetupStatus {
  readonly mode: TunnelMode;
  readonly program_present: boolean;
  readonly profile_present: boolean;
  readonly credential_configured: boolean;
  readonly tunnel_id_masked: string | null;
  readonly doctor: { readonly ok: boolean; readonly reason_code: string | null; readonly checked_at: string | null } | null;
}

/** Input for provisionTunnelProfile. */
export interface ProvisionTunnelInput {
  readonly mode: TunnelMode;
  readonly tunnelId?: string;
  readonly runtimeKey?: string;
  readonly configPath: string;
  readonly statusPath: string;
  readonly credentialPath: string;
  readonly projectRoot: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly spawnImpl?: typeof spawn;
}

/** Input for revalidateTunnelProfile. */
export interface RevalidateTunnelInput {
  readonly mode: TunnelMode;
  readonly configPath: string;
  readonly statusPath: string;
  readonly credentialPath: string;
  readonly projectRoot: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly spawnImpl?: typeof spawn;
}

/** Input for getTunnelSetupStatus. */
export interface TunnelSetupStatusInput {
  readonly mode: TunnelMode;
  readonly configPath: string;
  readonly statusPath: string;
  readonly credentialPath: string;
  readonly env?: NodeJS.ProcessEnv;
}

/** Result of forgetting a tunnel credential. */
export type ForgetResult =
  | { readonly ok: true; readonly credential_configured: false }
  | { readonly ok: false; readonly reason_code: "credential_forget_failed" };

function assertMode(mode: string): { profile: string } {
  if (!Object.hasOwn(MODES, mode as TunnelMode)) throw new Error("Unsupported tunnel setup mode");
  return MODES[mode as TunnelMode];
}

export function maskTunnelId(value: unknown): string | null {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id) return null;
  if (id.length <= 8) return `${id.slice(0, 2)}...${id.slice(-2)}`;
  return `${id.slice(0, 4)}...${id.slice(-4)}`;
}

function readTunnelId(profilePath: string): string | null {
  try {
    const text = readFileSync(profilePath, "utf8");
    return text.match(/(?:^|\n)\s*tunnel_id:\s*["']?([^"'\r\n#]+)["']?/i)?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

function profilePath(mode: TunnelMode, env: NodeJS.ProcessEnv): string | null {
  const definition = assertMode(mode);
  return env.APPDATA ? join(env.APPDATA, "tunnel-client", `${definition.profile}.yaml`) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function tunnelDetectionConfig(config: Record<string, unknown>): { tunnelClientPath?: string; workspaceRoot?: string } {
  return {
    ...(typeof config.tunnelClientPath === "string" ? { tunnelClientPath: config.tunnelClientPath } : {}),
    ...(typeof config.workspaceRoot === "string" ? { workspaceRoot: config.workspaceRoot } : {}),
  };
}

function proxyEndpoint(
  value: unknown,
  fallback: { mode: string; url?: string } = { mode: "environment" },
): { mode: string; url?: string } {
  if (!isRecord(value)) return fallback;
  return {
    mode: typeof value.mode === "string" ? value.mode : "environment",
    ...(typeof value.url === "string" ? { url: value.url } : {}),
  };
}

export function getTunnelSetupStatus({ mode, configPath, statusPath, credentialPath, env = process.env }: TunnelSetupStatusInput): TunnelSetupStatus {
  assertMode(mode);
  const config = asRecord(readJson(configPath));
  const executable = detectTunnelClient({ config: tunnelDetectionConfig(config), env });
  const profile = profilePath(mode, env);
  const tunnelId = profile ? readTunnelId(profile) : null;
  const statuses = asRecord(readJson(statusPath));
  const recent = isRecord(statuses[mode]) ? statuses[mode] : null;
  return {
    mode,
    program_present: executable.available === true,
    profile_present: Boolean(profile && existsSync(profile)),
    credential_configured: existsSync(credentialPath),
    tunnel_id_masked: maskTunnelId(tunnelId),
    doctor: recent ? {
      ok: recent.ok === true,
      reason_code: typeof recent.reason_code === "string" ? recent.reason_code : null,
      checked_at: typeof recent.checked_at === "string" ? recent.checked_at : null,
    } : null,
  };
}

function parseResult(text: string): Record<string, unknown> | null {
  for (const line of String(text || "").trim().split(/\r?\n/).reverse()) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed) && typeof parsed.ok === "boolean") return parsed;
    } catch { /* ignore non-JSON diagnostics */ }
  }
  return null;
}

function publicResult(result: unknown, fallbackCode: string): ProvisionResult {
  const record = asRecord(result);
  return {
    ok: record.ok === true,
    reason_code: typeof record.reason_code === "string" ? record.reason_code : fallbackCode,
    next_step: typeof record.next_step === "string" ? record.next_step : null,
  };
}

export function provisionTunnelProfile({
  mode,
  tunnelId,
  runtimeKey,
  configPath,
  statusPath,
  credentialPath,
  projectRoot,
  env = process.env,
  spawnImpl = spawn,
}: ProvisionTunnelInput): Promise<ProvisionResult> {
  const definition = assertMode(mode);
  const id = typeof tunnelId === "string" ? tunnelId.trim() : "";
  const key = typeof runtimeKey === "string" ? runtimeKey.trim() : "";
  if (!id) return Promise.resolve({ ok: false, reason_code: "tunnel_id_missing", next_step: "enter_tunnel_id" });
  if (!key) return Promise.resolve({ ok: false, reason_code: "runtime_key_missing", next_step: "enter_runtime_key" });

  const config = asRecord(readJson(configPath));
  const executable = detectTunnelClient({ config: tunnelDetectionConfig(config), env });
  if (!executable.available) return Promise.resolve({ ok: false, reason_code: "tunnel_client_missing", next_step: "choose_tunnel_client" });

  const proxy = asRecord(config.tunnelProxy);
  const coreProxy = proxyEndpoint(proxy.core);
  const endpoint = mode === "direct" && proxy.scope === "separate" ? proxyEndpoint(proxy.direct, coreProxy) : coreProxy;
  const script = join(projectRoot, "scripts", "control", "provision-patchwarden-tunnel.ps1");
  const args: string[] = [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script,
    "-Mode", mode,
    "-TunnelId", id,
    "-TunnelClientExe", executable.path as string,
    "-ConfigPath", configPath,
    "-CredentialPath", credentialPath,
    "-ProxyMode", endpoint.mode || "environment",
  ];
  if (endpoint.mode === "manual" && endpoint.url) args.push("-ProxyUrl", endpoint.url);

  const ownerTokenEnv = asRecord(config.http).ownerTokenEnv;
  if (ownerTokenEnv !== undefined && typeof ownerTokenEnv !== "string") {
    throw new Error("HTTP ownerTokenEnv configuration is invalid");
  }
  const childEnv = buildDesktopChildEnvironment({
    sourceEnvironment: env,
    blockedNames: ownerTokenEnv ? [ownerTokenEnv] : [],
  });
  return new Promise<ProvisionResult>((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: unknown) => {
      if (settled) return;
      settled = true;
      const safe = publicResult(result, "provisioning_failed");
      const statuses = asRecord(readJson(statusPath));
      atomicWriteJson(statusPath, {
        ...statuses,
        [mode]: { ...safe, checked_at: new Date().toISOString(), profile: definition.profile },
      }, false);
      resolvePromise(safe);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawnImpl(resolveTrustedPowerShell(projectRoot, { sourceEnvironment: childEnv }), args, {
        cwd: projectRoot,
        windowsHide: true,
        env: childEnv,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      finish({ ok: false, reason_code: "provisioning_spawn_failed", next_step: "retry" });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already exited */ }
      finish({ ok: false, reason_code: "provisioning_timeout", next_step: "check_proxy" });
    }, 60_000);
    child.stdout?.on("data", (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(-16000); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8000); });
    child.on("error", () => {
      clearTimeout(timer);
      finish({ ok: false, reason_code: "provisioning_spawn_failed", next_step: "retry" });
    });
    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      const combined = `${stdout}\n${stderr}`.split(key).join("[REDACTED]");
      const parsed = parseResult(combined);
      finish(code === 0 && parsed?.ok === true ? parsed : (parsed || { ok: false, reason_code: "provisioning_failed" }));
    });
    child.stdin?.end(`${key}\n`);
  });
}

export function revalidateTunnelProfile({
  mode,
  configPath,
  statusPath,
  credentialPath,
  projectRoot,
  env = process.env,
  spawnImpl = spawn,
}: RevalidateTunnelInput): Promise<ProvisionResult> {
  const definition = assertMode(mode);
  if (!existsSync(credentialPath)) return Promise.resolve({ ok: false, reason_code: "tunnel_credential_missing", next_step: "enter_runtime_key" });
  const profile = profilePath(mode, env);
  if (!profile || !existsSync(profile)) return Promise.resolve({ ok: false, reason_code: "tunnel_profile_missing", next_step: "configure_profile" });
  const config = asRecord(readJson(configPath));
  const executable = detectTunnelClient({ config: tunnelDetectionConfig(config), env });
  if (!executable.available) return Promise.resolve({ ok: false, reason_code: "tunnel_client_missing", next_step: "choose_tunnel_client" });
  const proxy = asRecord(config.tunnelProxy);
  const coreProxy = proxyEndpoint(proxy.core);
  const endpoint = mode === "direct" && proxy.scope === "separate" ? proxyEndpoint(proxy.direct, coreProxy) : coreProxy;
  const script = join(projectRoot, "scripts", "control", "provision-patchwarden-tunnel.ps1");
  const args: string[] = [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script,
    "-Mode", mode, "-UseSavedCredential",
    "-TunnelClientExe", executable.path as string,
    "-ConfigPath", configPath,
    "-CredentialPath", credentialPath,
    "-ProxyMode", endpoint.mode || "environment",
  ];
  if (endpoint.mode === "manual" && endpoint.url) args.push("-ProxyUrl", endpoint.url);
  const ownerTokenEnv = asRecord(config.http).ownerTokenEnv;
  if (ownerTokenEnv !== undefined && typeof ownerTokenEnv !== "string") {
    throw new Error("HTTP ownerTokenEnv configuration is invalid");
  }
  const childEnv = buildDesktopChildEnvironment({
    sourceEnvironment: env,
    blockedNames: ownerTokenEnv ? [ownerTokenEnv] : [],
  });
  return new Promise<ProvisionResult>((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: unknown) => {
      if (settled) return;
      settled = true;
      const safe = publicResult(result, "revalidation_failed");
      const statuses = asRecord(readJson(statusPath));
      atomicWriteJson(statusPath, { ...statuses, [mode]: { ...safe, checked_at: new Date().toISOString(), profile: definition.profile } }, false);
      resolvePromise(safe);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawnImpl(resolveTrustedPowerShell(projectRoot, { sourceEnvironment: childEnv }), args, { cwd: projectRoot, windowsHide: true, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      finish({ ok: false, reason_code: "provisioning_spawn_failed", next_step: "retry" });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already exited */ }
      finish({ ok: false, reason_code: "provisioning_timeout", next_step: "check_proxy" });
    }, 60_000);
    child.stdout?.on("data", (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(-16000); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8000); });
    child.on("error", () => { clearTimeout(timer); finish({ ok: false, reason_code: "provisioning_spawn_failed", next_step: "retry" }); });
    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      const parsed = parseResult(`${stdout}\n${stderr}`);
      finish(code === 0 && parsed?.ok === true ? parsed : (parsed || { ok: false, reason_code: "revalidation_failed" }));
    });
  });
}

export function forgetTunnelCredential(credentialPath: string): ForgetResult {
  try {
    rmSync(credentialPath, { force: true });
    return { ok: true, credential_configured: false };
  } catch {
    return { ok: false, reason_code: "credential_forget_failed" };
  }
}
