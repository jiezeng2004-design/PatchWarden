import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createIconPng, wrapPngAsIco } from "./icon.mjs";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(desktopRoot, "..");
const stageRoot = join(desktopRoot, ".stage");
const coreStage = join(stageRoot, "core");
const rootPackage = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const rootPackageLock = JSON.parse(readFileSync(join(repoRoot, "package-lock.json"), "utf8"));
const desktopPackage = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf8"));

if (rootPackage.version !== desktopPackage.version) {
  throw new Error(`Desktop version ${desktopPackage.version} must match root version ${rootPackage.version}`);
}
if (!existsSync(join(repoRoot, "dist", "controlCenter.js"))) {
  throw new Error("Root dist is missing. Run npm.cmd run build before desktop staging.");
}

rmSync(stageRoot, { recursive: true, force: true });
mkdirSync(coreStage, { recursive: true });
for (const directory of ["dist", "ui", "scripts/control", "scripts/launchers", "scripts/mcp", "examples"]) {
  cpSync(join(repoRoot, directory), join(coreStage, directory), { recursive: true });
}
rmSync(join(coreStage, "dist", "test"), { recursive: true, force: true });
mkdirSync(join(coreStage, "scripts", "checks"), { recursive: true });
cpSync(
  join(repoRoot, "scripts", "checks", "mcp-manifest-check.js"),
  join(coreStage, "scripts", "checks", "mcp-manifest-check.js"),
);
for (const file of ["package.json", "PatchWarden.cmd"]) {
  cpSync(join(repoRoot, file), join(coreStage, file));
}

for (const [relativePath, metadata] of Object.entries(rootPackageLock.packages || {})) {
  if (!relativePath.startsWith("node_modules/") || metadata.dev === true) continue;
  const source = join(repoRoot, relativePath);
  if (!existsSync(source)) continue;
  const destination = join(coreStage, relativePath);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true });
}

for (const requiredPath of [
  "dist/index.js",
  "scripts/checks/mcp-manifest-check.js",
  "node_modules/@modelcontextprotocol/sdk/package.json",
]) {
  if (!existsSync(join(coreStage, requiredPath))) {
    throw new Error(`Desktop staged runtime is missing ${requiredPath}`);
  }
}

const png = createIconPng();
writeFileSync(join(stageRoot, "icon.png"), png);
writeFileSync(join(stageRoot, "icon.ico"), wrapPngAsIco(png));
console.log(`[desktop:stage] Staged PatchWarden ${rootPackage.version} runtime and icon.`);
