import { join, resolve } from "node:path";
import {
  buildDesktopChildEnvironment,
  type DesktopChildEnvironmentOptions,
} from "./child-environment.js";

/** Input for resolving the PatchWarden core runtime root. */
export interface ResolveCoreRootOptions {
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly desktopRoot: string;
}

/** Options passed to Electron's utilityProcess.fork. */
export interface UtilityProcessOptionsResult {
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
  readonly stdio: "pipe";
  readonly serviceName: string;
}

export function resolveCoreRoot({ isPackaged, resourcesPath, desktopRoot }: ResolveCoreRootOptions): string {
  return isPackaged ? join(resourcesPath, "core") : resolve(desktopRoot, "..");
}

export function utilityProcessOptions(
  coreRoot: string,
  env: Record<string, string | undefined>,
  serviceName: string,
  environmentOptions: Omit<DesktopChildEnvironmentOptions, "overrides"> = {},
): UtilityProcessOptionsResult {
  return {
    cwd: coreRoot,
    env: buildDesktopChildEnvironment({ ...environmentOptions, overrides: env }),
    stdio: "pipe",
    serviceName,
  };
}
