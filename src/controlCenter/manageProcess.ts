import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, extname, join } from "node:path";
import { homedir } from "node:os";
import { DEFAULT_TUNNEL_CLIENT_EXE } from "./constants.js";

// ── manage-patchwarden.ps1 invocation ─────────────────────────────

export interface ManageResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function runManageAction(action: string, mode: string, manageScriptPath: string, projectRoot: string): Promise<ManageResult> {
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

// ── Control modes ────────────────────────────────────────────────

export type ControlMode = "core" | "direct";

export function selectedControlModes(mode: string): ControlMode[] {
  if (mode === "core" || mode === "direct") return [mode];
  return ["core", "direct"];
}

export function launcherPathForMode(mode: ControlMode, projectRoot: string): string {
  const launcherName = mode === "direct" ? "Start-PatchWarden-Direct-Tunnel.cmd" : "Start-PatchWarden-Tunnel.cmd";
  return join(projectRoot, "scripts", "launchers", launcherName);
}

// ── Executable finder ─────────────────────────────────────────────

export function findExecutableOnPath(fileName: string): string | null {
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

export function findTunnelClientExecutable(): string | null {
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

// ── Preflight check ──────────────────────────────────────────────

export function preflightManageAction(action: string, mode: string, projectRoot: string): { status: number; body: Record<string, unknown> } | null {
  if (action !== "start" && action !== "restart") return null;

  const missingLaunchers = selectedControlModes(mode)
    .map((m) => ({ mode: m, path: launcherPathForMode(m, projectRoot) }))
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