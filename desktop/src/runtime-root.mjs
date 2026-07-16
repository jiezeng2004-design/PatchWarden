import { join, resolve } from "node:path";

export function resolveCoreRoot({ isPackaged, resourcesPath, desktopRoot }) {
  return isPackaged ? join(resourcesPath, "core") : resolve(desktopRoot, "..");
}

export function utilityProcessOptions(coreRoot, env, serviceName) {
  return { cwd: coreRoot, env, stdio: "pipe", serviceName };
}
