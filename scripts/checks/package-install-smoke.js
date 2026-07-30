#!/usr/bin/env node
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolvePackageManagerInvocation } from "../../dist/runner/processSecurity.js";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const temp = mkdtempSync(join(tmpdir(), "patchwarden-package-install-"));
const packDir = join(temp, "pack");
const consumer = join(temp, "consumer");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf-8",
    shell: false,
    windowsHide: true,
    env: { ...process.env, npm_config_audit: "false", npm_config_fund: "false" },
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || result.error?.message || `${command} failed`);
  }
  return result.stdout;
}

function runNpm(args, cwd) {
  const invocation = resolvePackageManagerInvocation(npm, cwd, { pathValue: process.env.PATH });
  return run(invocation.command, [...invocation.argsPrefix, ...args], cwd);
}

try {
  mkdirSync(packDir, { recursive: true });
  mkdirSync(consumer, { recursive: true });
  const packed = JSON.parse(runNpm(["pack", "--json", "--pack-destination", packDir], root));
  const filename = basename(String(packed?.[0]?.filename || ""));
  if (!filename.endsWith(".tgz")) throw new Error("npm pack did not produce a tgz receipt");
  const archive = join(packDir, filename);
  if (!existsSync(archive)) throw new Error(`Packed archive missing: ${filename}`);
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "patchwarden-install-smoke", private: true }));
  runNpm(["install", "--ignore-scripts", "--no-audit", "--no-fund", archive], consumer);

  const installed = join(consumer, "node_modules", "patchwarden");
  const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf-8"));
  if (manifest.name !== "patchwarden" || manifest.engines?.node !== ">=20.0.0") {
    throw new Error("Installed manifest does not match the runtime contract");
  }
  for (const required of [
    "dist/index.js",
    "dist/index.d.ts",
    "dist/attestation/cli.js",
    "scripts/control/manage-patchwarden.ps1",
    "scripts/checks/mcp-manifest-check.js",
    "ui/pages/dashboard.html",
  ]) {
    if (!existsSync(join(installed, required))) throw new Error(`Installed package is missing ${required}`);
  }
  for (const forbidden of ["src", "docs/assets", "dist/test", "dist/smoke-test.js", "scripts/checks/http-mcp-smoke.js"]) {
    if (existsSync(join(installed, forbidden))) throw new Error(`Installed package unexpectedly contains ${forbidden}`);
  }
  run(process.execPath, ["--check", join(installed, "dist", "index.js")], consumer);
  run(process.execPath, ["--check", join(installed, "dist", "attestation", "cli.js")], consumer);
  console.log(`[package-install-smoke] OK: installed ${filename} into an isolated consumer.`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
