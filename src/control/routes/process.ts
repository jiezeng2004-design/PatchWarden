/**
 * Control Center routes — process lifecycle proxy (/api/start-all,
 * /api/stop-all, /api/restart-all, /api/core/*, /api/direct/*).
 *
 * Proxies start/stop/restart actions to scripts/control/manage-patchwarden.ps1
 * and exposes open-logs-folder. Start/restart actions run a preflight that
 * verifies the tunnel-client executable and launcher files exist before
 * launching, so the non-interactive web UI never deadlocks on a missing
 * dependency. All endpoints are POST routes gated by the control token.
 */
import { existsSync } from "node:fs";
import { delimiter, extname, join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { type ServerResponse } from "node:http";
import { recordEvent } from "../runtime.js";
import { DEFAULT_TUNNEL_CLIENT_EXE, errorMessage, getRuntimeRoot, manageScriptPath, projectRoot, sendJson } from "../shared.js";

type ControlMode = "core" | "direct";

interface ManageResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runManageAction(action: string, mode: string): Promise<ManageResult> {
  return new Promise((resolveP, rejectP) => {
    let child;
    try {
      child = spawn(
        "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", manageScriptPath, action, mode, "-Background"],
        { cwd: projectRoot, windowsHide: true }
      );
    } catch (err) {
      rejectP(err);
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* ignore */ }
      rejectP(new Error(`manage-patchwarden.ps1 timed out after 60s (action=${action}, mode=${mode})`));
    }, 60_000);
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf-8");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf-8");
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectP(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveP({ exitCode: code ?? -1, stdout, stderr });
    });
  });
}

function selectedControlModes(mode: string): ControlMode[] {
  if (mode === "core" || mode === "direct") return [mode];
  return ["core", "direct"];
}

function launcherPathForMode(mode: ControlMode): string {
  const launcherName = mode === "direct" ? "Start-PatchWarden-Direct-Tunnel.cmd" : "Start-PatchWarden-Tunnel.cmd";
  return join(projectRoot, "scripts", "launchers", launcherName);
}

function findExecutableOnPath(fileName: string): string | null {
  const pathValue = process.env.PATH || "";
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
      : [""];
  for (const entry of pathValue.split(delimiter)) {
    if (!entry) continue;
    const direct = join(entry, fileName);
    if (existsSync(direct)) return direct;
    if (process.platform === "win32" && !extname(fileName)) {
      for (const ext of extensions) {
        const candidate = join(entry, fileName + ext.toLowerCase());
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

function findTunnelClientExecutable(): string | null {
  if (process.env.PATCHWARDEN_CONTROL_FORCE_MISSING_TUNNEL_CLIENT === "1") return null;
  const explicit = process.env.TUNNEL_CLIENT_EXE || process.env.PATCHWARDEN_TUNNEL_CLIENT_EXE;
  if (explicit && existsSync(explicit)) return explicit;
  const fromPath = findExecutableOnPath("tunnel-client.exe") ?? findExecutableOnPath("tunnel-client");
  if (fromPath) return fromPath;

  const candidates = [
    DEFAULT_TUNNEL_CLIENT_EXE,
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "patchwarden", "tunnel-client.exe") : null,
    process.env.APPDATA ? join(process.env.APPDATA, "tunnel-client", "tunnel-client.exe") : null,
    join(homedir(), "tunnel-client", "tunnel-client.exe"),
  ].filter((v): v is string => typeof v === "string" && v.length > 0);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// Re-exported so the status route can surface tunnel-client availability in
// /api/status without duplicating the discovery logic.
export { findTunnelClientExecutable };

function preflightManageAction(action: string, mode: string): { status: number; body: Record<string, unknown> } | null {
  if (action !== "start" && action !== "restart") return null;

  const missingLaunchers = selectedControlModes(mode)
    .map((m) => ({ mode: m, path: launcherPathForMode(m) }))
    .filter((entry) => !existsSync(entry.path));
  const tunnelClient = findTunnelClientExecutable();
  const missing: string[] = [];
  if (!tunnelClient) missing.push("tunnel-client.exe");
  for (const entry of missingLaunchers) missing.push(`${entry.mode} launcher`);

  if (missing.length === 0) return null;

  return {
    status: 409,
    body: {
      ok: false,
      action,
      mode,
      error:
        "Control Center preflight failed. Start/restart from the Web UI is non-interactive, so required runtime dependencies must be available before launching.",
      missing,
      next_steps: [
        "Install tunnel-client.exe or set TUNNEL_CLIENT_EXE / PATCHWARDEN_TUNNEL_CLIENT_EXE to its full path.",
        `Default checked path: ${DEFAULT_TUNNEL_CLIENT_EXE}`,
        "Verify the launcher files under scripts/launchers are present.",
        "Then retry from PatchWarden Control Center or PatchWarden-Control-Tray.cmd.",
      ],
    },
  };
}

export async function handleManageAction(res: ServerResponse, action: string, mode: string): Promise<void> {
  try {
    const preflight = preflightManageAction(action, mode);
    if (preflight) {
      recordEvent("manage." + mode + "." + action + ".preflight_failed", {
        missing: preflight.body.missing,
      });
      sendJson(res, preflight.status, preflight.body);
      return;
    }
    const result = await runManageAction(action, mode);
    recordEvent("manage." + mode + "." + action, {
      exit_code: result.exitCode,
      ok: result.exitCode === 0,
    });
    sendJson(res, 200, {
      ok: result.exitCode === 0,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  } catch (err) {
    recordEvent("manage." + mode + "." + action + ".failed", { error: errorMessage(err) });
    sendJson(res, 500, { error: errorMessage(err) });
  }
}

export function handleOpenLogsFolder(res: ServerResponse): void {
  try {
    const target = getRuntimeRoot(false);
    let cmd: string;
    if (process.platform === "win32") {
      cmd = "explorer.exe";
    } else if (process.platform === "darwin") {
      cmd = "open";
    } else {
      cmd = "xdg-open";
    }
    try {
      const child = spawn(cmd, [target], { detached: true, stdio: "ignore" });
      child.on("error", () => { /* ignore spawn errors */ });
      child.unref();
    } catch {
      /* ignore */
    }
    sendJson(res, 200, { ok: true, path: target });
  } catch (err) {
    sendJson(res, 500, { error: errorMessage(err) });
  }
}
