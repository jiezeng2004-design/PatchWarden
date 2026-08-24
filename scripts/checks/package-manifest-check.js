#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runSimpleProcess } from "../../dist/runner/simpleProcess.js";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const npmPackTimeoutMs = 90_000;
const result = await runSimpleProcess({
  command: npm,
  args: [
    "pack",
    "--dry-run",
    "--json",
    "--ignore-scripts",
    "--prefer-offline",
    "--offline",
    "--fetch-retries=0",
    "--fetch-timeout=15000",
  ],
  cwd: root,
  timeoutMs: npmPackTimeoutMs,
  maxStdoutBytes: 4 * 1024 * 1024,
  maxStderrBytes: 64 * 1024,
  environmentOverrides: { npm_config_update_notifier: "false" },
});

if (result.timedOut) {
  console.error(`[package-manifest-check] npm pack --dry-run --json timed out after ${npmPackTimeoutMs / 1000}s.`);
  process.exit(1);
}

if (result.spawnError !== null) {
  console.error("[package-manifest-check] npm pack --dry-run --json failed to start (spawn error).");
  process.exit(1);
}

if (result.exitCode === null) {
  console.error("[package-manifest-check] npm pack --dry-run --json ended without an exit code.");
  process.exit(1);
}

if (result.exitCode !== 0) {
  console.error(`[package-manifest-check] npm pack --dry-run --json failed (exit code ${result.exitCode}).`);
  process.exit(result.exitCode || 1);
}

let metadata;
try {
  metadata = JSON.parse(result.stdout);
} catch (error) {
  console.error(`[package-manifest-check] Could not parse npm pack JSON: ${error.message}`);
  process.exit(1);
}

const files = metadata?.[0]?.files?.map((entry) => String(entry.path).replace(/\\/g, "/")) || [];
const packageMetadata = metadata?.[0] || {};
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
  /^docs\/assets\//i,
  /^src\//i,
  /^dist\/smoke-test\.(?:js|d\.ts)$/i,
  /^scripts\/checks\/(?!mcp-manifest-check\.js$)/i,
];
const leaked = files.filter((file) => forbidden.some((pattern) => pattern.test(file)));
if (leaked.length > 0) {
  console.error("[package-manifest-check] Private files would enter the npm package:");
  for (const file of leaked) console.error(`  ${file}`);
  process.exit(1);
}

const required = [
  "CONTRIBUTORS.md",
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

// Direct Review plus the Control Center cache and supervised process modules
// expand the published runtime while keeping the package surface bounded.
const maxFiles = 412;
const maxUnpackedBytes = 6 * 1024 * 1024;
if (files.length > maxFiles || Number(packageMetadata.unpackedSize || 0) > maxUnpackedBytes) {
  console.error(`[package-manifest-check] Package budget exceeded: ${files.length}/${maxFiles} files, ${packageMetadata.unpackedSize}/${maxUnpackedBytes} unpacked bytes.`);
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

console.log(`[package-manifest-check] OK: ${files.length} files, ${packageMetadata.unpackedSize} unpacked bytes, no private local launchers.`);
