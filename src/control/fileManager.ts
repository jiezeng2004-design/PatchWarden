import { spawn } from "node:child_process";
import { join } from "node:path";
import { buildChildEnvironment, resolveTrustedExecutable } from "../runner/processSecurity.js";

const FILE_MANAGER_ENVIRONMENT = [
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "DBUS_SESSION_BUS_ADDRESS",
  "XDG_RUNTIME_DIR",
] as const;

/** Launch a trusted platform file manager without inheriting ambient secrets. */
export function launchFileManager(target: string, cwd: string): boolean {
  try {
    const env = buildChildEnvironment({ cwd, allowedNames: FILE_MANAGER_ENVIRONMENT });
    const requested = fileManagerCommand(env);
    const command = resolveTrustedExecutable(requested, cwd, { pathValue: env.PATH });
    const child = spawn(command, [target], {
      cwd,
      detached: true,
      env,
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", () => { /* opening a convenience viewer is best effort */ });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function fileManagerCommand(env: NodeJS.ProcessEnv): string {
  if (process.platform === "win32") {
    const windowsRoot = env.SystemRoot || env.WINDIR;
    return windowsRoot ? join(windowsRoot, "explorer.exe") : "explorer.exe";
  }
  if (process.platform === "darwin") return "open";
  return "xdg-open";
}
