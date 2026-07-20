#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildChildEnvironment,
  resolvePackageManagerInvocation,
} from "../../dist/runner/processSecurity.js";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const env = buildChildEnvironment({ cwd: root });
const invocation = resolvePackageManagerInvocation(process.platform === "win32" ? "npm.cmd" : "npm", root, {
  pathValue: env.PATH,
});
const result = spawnSync(invocation.command, [...invocation.argsPrefix, "pack", "--dry-run", "--json"], {
  cwd: root,
  encoding: "utf8",
  env,
  shell: false,
  windowsHide: true,
});

if (result.status !== 0) {
  process.stderr.write(result.stderr || result.stdout || result.error?.message || "npm pack --dry-run --json failed\n");
  process.exit(result.status || 1);
}

let metadata;
try {
  metadata = JSON.parse(result.stdout);
} catch (error) {
  console.error(`[package-manifest-check] Could not parse npm pack JSON: ${error.message}`);
  process.exit(1);
}

const files = metadata?.[0]?.files?.map((entry) => String(entry.path).replace(/\\/g, "/")) || [];
const forbidden = [
  /(^|\/)\.local(\/|$)/i,
  /\.local\.(cmd|ps1)$/i,
  /(^|\/)patchwarden\.config\.json$/i,
  new RegExp(`(^|/)${["safe", "bifrost"].join("-")}\\.config\\.json$`, "i"),
  /(^|\/)\.env$/i,
  /\.dpapi$/i,
  /^docs\/optimization-proposal\.md$/i,
  /(^|\/)kill-patchwarden\.(cmd|ps1)$/i,
  /^(?:dist|src)\/test\//i,
  /^docs\/archive\//i,
];
const leaked = files.filter((file) => forbidden.some((pattern) => pattern.test(file)));
if (leaked.length > 0) {
  console.error("[package-manifest-check] Private files would enter the npm package:");
  for (const file of leaked) console.error(`  ${file}`);
  process.exit(1);
}

const required = [
  "dist/index.js",
  "dist/index.d.ts",
  "PatchWarden.cmd",
  "scripts/launchers/PatchWarden-Desktop.cmd",
  "scripts/control/manage-patchwarden.ps1",
  "scripts/launchers/Start-PatchWarden-Tunnel.cmd",
  "scripts/launchers/Start-PatchWarden-Direct-Tunnel.cmd",
];
const missing = required.filter((file) => !files.includes(file));
if (missing.length > 0) {
  console.error("[package-manifest-check] Required control files are missing:");
  for (const file of missing) console.error(`  ${file}`);
  process.exit(1);
}

const publicControlFiles = [
  "PatchWarden.cmd",
  "scripts/launchers/Start-PatchWarden-Tunnel.cmd",
  "scripts/launchers/Start-PatchWarden-Direct-Tunnel.cmd",
];
const privateAbsolutePath = /[A-Za-z]:\\(?:Users\\[^\\\r\n]+|ai_agent)\\/i;
const privatePathLeaks = publicControlFiles.filter((file) => {
  try {
    return privateAbsolutePath.test(readFileSync(file, "utf8"));
  } catch {
    return false;
  }
});
if (privatePathLeaks.length > 0) {
  console.error("[package-manifest-check] Public control files contain machine-specific absolute paths:");
  for (const file of privatePathLeaks) console.error(`  ${file}`);
  process.exit(1);
}

console.log(`[package-manifest-check] OK: ${files.length} package files, no private local launchers.`);
