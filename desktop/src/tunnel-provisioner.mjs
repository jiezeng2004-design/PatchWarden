import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJson, readJson } from "./config-store.mjs";
import { detectTunnelClient } from "./runtime-settings.mjs";

const MODES = Object.freeze({
  core: { profile: "patchwarden" },
  direct: { profile: "patchwarden-direct" },
});

function assertMode(mode) {
  if (!Object.hasOwn(MODES, mode)) throw new Error("Unsupported tunnel setup mode");
  return MODES[mode];
}

export function maskTunnelId(value) {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id) return null;
  if (id.length <= 8) return `${id.slice(0, 2)}...${id.slice(-2)}`;
  return `${id.slice(0, 4)}...${id.slice(-4)}`;
}

function readTunnelId(profilePath) {
  try {
    const text = readFileSync(profilePath, "utf8");
    return text.match(/(?:^|\n)\s*tunnel_id:\s*["']?([^"'\r\n#]+)["']?/i)?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

function profilePath(mode, env) {
  const definition = assertMode(mode);
  return env.APPDATA ? join(env.APPDATA, "tunnel-client", `${definition.profile}.yaml`) : null;
}

export function getTunnelSetupStatus({ mode, configPath, statusPath, credentialPath, env = process.env }) {
  assertMode(mode);
  const config = readJson(configPath) || {};
  const executable = detectTunnelClient({ config, env });
  const profile = profilePath(mode, env);
  const tunnelId = profile ? readTunnelId(profile) : null;
  const statuses = readJson(statusPath) || {};
  const recent = statuses[mode] && typeof statuses[mode] === "object" ? statuses[mode] : null;
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

function parseResult(text) {
  for (const line of String(text || "").trim().split(/\r?\n/).reverse()) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed.ok === "boolean") return parsed;
    } catch { /* ignore non-JSON diagnostics */ }
  }
  return null;
}

function publicResult(result, fallbackCode) {
  return {
    ok: result?.ok === true,
    reason_code: typeof result?.reason_code === "string" ? result.reason_code : fallbackCode,
    next_step: typeof result?.next_step === "string" ? result.next_step : null,
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
}) {
  const definition = assertMode(mode);
  const id = typeof tunnelId === "string" ? tunnelId.trim() : "";
  const key = typeof runtimeKey === "string" ? runtimeKey.trim() : "";
  if (!id) return Promise.resolve({ ok: false, reason_code: "tunnel_id_missing", next_step: "enter_tunnel_id" });
  if (!key) return Promise.resolve({ ok: false, reason_code: "runtime_key_missing", next_step: "enter_runtime_key" });

  const config = readJson(configPath) || {};
  const executable = detectTunnelClient({ config, env });
  if (!executable.available) return Promise.resolve({ ok: false, reason_code: "tunnel_client_missing", next_step: "choose_tunnel_client" });

  const proxy = config.tunnelProxy || {};
  const coreProxy = proxy.core || { mode: "environment" };
  const endpoint = mode === "direct" && proxy.scope === "separate" ? (proxy.direct || coreProxy) : coreProxy;
  const script = join(projectRoot, "scripts", "control", "provision-patchwarden-tunnel.ps1");
  const args = [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script,
    "-Mode", mode,
    "-TunnelId", id,
    "-TunnelClientExe", executable.path,
    "-ConfigPath", configPath,
    "-CredentialPath", credentialPath,
    "-ProxyMode", endpoint.mode || "environment",
  ];
  if (endpoint.mode === "manual" && endpoint.url) args.push("-ProxyUrl", endpoint.url);

  const childEnv = { ...env };
  delete childEnv.CONTROL_PLANE_API_KEY;
  return new Promise((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      const safe = publicResult(result, "provisioning_failed");
      const statuses = readJson(statusPath) || {};
      atomicWriteJson(statusPath, {
        ...statuses,
        [mode]: { ...safe, checked_at: new Date().toISOString(), profile: definition.profile },
      }, false);
      resolvePromise(safe);
    };
    let child;
    try {
      child = spawnImpl("powershell.exe", args, {
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
    child.stdout?.on("data", (chunk) => { stdout = (stdout + chunk.toString()).slice(-16000); });
    child.stderr?.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-8000); });
    child.on("error", () => {
      clearTimeout(timer);
      finish({ ok: false, reason_code: "provisioning_spawn_failed", next_step: "retry" });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const combined = `${stdout}\n${stderr}`.split(key).join("[REDACTED]");
      const parsed = parseResult(combined);
      finish(code === 0 && parsed?.ok === true ? parsed : (parsed || { ok: false, reason_code: "provisioning_failed" }));
    });
    child.stdin.end(`${key}\n`);
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
}) {
  const definition = assertMode(mode);
  if (!existsSync(credentialPath)) return Promise.resolve({ ok: false, reason_code: "tunnel_credential_missing", next_step: "enter_runtime_key" });
  const profile = profilePath(mode, env);
  if (!profile || !existsSync(profile)) return Promise.resolve({ ok: false, reason_code: "tunnel_profile_missing", next_step: "configure_profile" });
  const config = readJson(configPath) || {};
  const executable = detectTunnelClient({ config, env });
  if (!executable.available) return Promise.resolve({ ok: false, reason_code: "tunnel_client_missing", next_step: "choose_tunnel_client" });
  const proxy = config.tunnelProxy || {};
  const coreProxy = proxy.core || { mode: "environment" };
  const endpoint = mode === "direct" && proxy.scope === "separate" ? (proxy.direct || coreProxy) : coreProxy;
  const script = join(projectRoot, "scripts", "control", "provision-patchwarden-tunnel.ps1");
  const args = [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script,
    "-Mode", mode, "-UseSavedCredential",
    "-TunnelClientExe", executable.path,
    "-ConfigPath", configPath,
    "-CredentialPath", credentialPath,
    "-ProxyMode", endpoint.mode || "environment",
  ];
  if (endpoint.mode === "manual" && endpoint.url) args.push("-ProxyUrl", endpoint.url);
  const childEnv = { ...env };
  delete childEnv.CONTROL_PLANE_API_KEY;
  return new Promise((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      const safe = publicResult(result, "revalidation_failed");
      const statuses = readJson(statusPath) || {};
      atomicWriteJson(statusPath, { ...statuses, [mode]: { ...safe, checked_at: new Date().toISOString(), profile: definition.profile } }, false);
      resolvePromise(safe);
    };
    let child;
    try {
      child = spawnImpl("powershell.exe", args, { cwd: projectRoot, windowsHide: true, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      finish({ ok: false, reason_code: "provisioning_spawn_failed", next_step: "retry" });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already exited */ }
      finish({ ok: false, reason_code: "provisioning_timeout", next_step: "check_proxy" });
    }, 60_000);
    child.stdout?.on("data", (chunk) => { stdout = (stdout + chunk.toString()).slice(-16000); });
    child.stderr?.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-8000); });
    child.on("error", () => { clearTimeout(timer); finish({ ok: false, reason_code: "provisioning_spawn_failed", next_step: "retry" }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const parsed = parseResult(`${stdout}\n${stderr}`);
      finish(code === 0 && parsed?.ok === true ? parsed : (parsed || { ok: false, reason_code: "revalidation_failed" }));
    });
  });
}

export function forgetTunnelCredential(credentialPath) {
  try {
    rmSync(credentialPath, { force: true });
    return { ok: true, credential_configured: false };
  } catch {
    return { ok: false, reason_code: "credential_forget_failed" };
  }
}
