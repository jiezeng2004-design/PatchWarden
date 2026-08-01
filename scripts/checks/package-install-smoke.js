#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const NPM_STEP_TIMEOUT_MS = 90_000;
const MAX_FAILURE_DIAGNOSTIC_CHARS = 16 * 1024;
const MAX_PROCESS_OUTPUT_BYTES = 16 * 1024 * 1024;
const NPM_NETWORK_ARGS = ["--prefer-offline", "--fetch-retries=0", "--fetch-timeout=15000", "--no-audit", "--no-fund"];
export const PROXY_ENVIRONMENT_NAMES = Object.freeze([
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "no_proxy",
]);

export function collectExactProxyValues(environment = {}) {
  const values = new Set();
  const add = (value) => {
    if (typeof value === "string" && value.length >= 8) values.add(value);
  };
  const addSlashForms = (value) => {
    if (typeof value !== "string" || value.length === 0) return;
    const withoutSlash = value.endsWith("/") ? value.slice(0, -1) : value;
    add(withoutSlash);
    add(`${withoutSlash}/`);
  };
  for (const name of PROXY_ENVIRONMENT_NAMES) {
    const value = environment[name];
    if (typeof value !== "string" || value.length < 8) continue;
    add(value);
    const trimmed = value.trim();
    add(trimmed);
    addSlashForms(trimmed);
    try {
      const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`);
      add(parsed.origin);
      add(parsed.host);
      add(parsed.hostname);
      const endpoint = parsed.origin === "null" ? `${parsed.protocol}//${parsed.host}` : parsed.origin;
      addSlashForms(endpoint);
    } catch {
      // The original explicit value remains protected even when it is not a valid endpoint.
    }
  }
  return [...values].sort((left, right) => right.length - left.length);
}

export function redactExactValues(value, exactValues = []) {
  let redacted = String(value ?? "");
  const values = [...new Set(exactValues.filter((item) => typeof item === "string" && item.length >= 8))]
    .sort((left, right) => right.length - left.length);
  for (const exactValue of values) {
    redacted = redacted.split(exactValue).join("<redacted-exact-value>");
  }
  return redacted;
}

export function redactDiagnosticTail(value, exactValues = [], maxChars = MAX_FAILURE_DIAGNOSTIC_CHARS) {
  const exactRedacted = redactExactValues(value, exactValues);
  const patternRedacted = exactRedacted
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1<redacted>@")
    .replace(/\b(authorization|proxy-authorization|token|api[_-]?key|password|secret)\b(\s*[:=]\s*)([^\s,;]+)/gi, "$1$2<redacted>");
  const limit = Number.isInteger(maxChars) && maxChars > 0 ? maxChars : MAX_FAILURE_DIAGNOSTIC_CHARS;
  if (patternRedacted.length <= limit) return patternRedacted;
  return `[truncated to final ${limit} chars]\n${patternRedacted.slice(-limit)}`;
}

export function sanitizedProcessFailure(result, exactValues = [], fallback = "process failed") {
  const raw = result?.stderr || result?.stdout || result?.spawnError || result?.error?.message || fallback;
  return redactDiagnosticTail(raw, exactValues);
}

function isMainModule() {
  if (!process.argv[1]) return false;
  const invoked = resolve(process.argv[1]);
  const current = resolve(fileURLToPath(import.meta.url));
  return process.platform === "win32" ? invoked.toLowerCase() === current.toLowerCase() : invoked === current;
}

export async function runPackageInstallSmoke() {
  const { runSimpleProcess } = await import("../../dist/runner/simpleProcess.js");
  const exactValues = collectExactProxyValues(process.env);
  let temp;

  async function run(command, args, cwd, name, environmentVariableNames = []) {
    const result = await runSimpleProcess({
      command,
      args,
      cwd,
      timeoutMs: NPM_STEP_TIMEOUT_MS,
      maxStdoutBytes: MAX_PROCESS_OUTPUT_BYTES,
      maxStderrBytes: MAX_PROCESS_OUTPUT_BYTES,
      environmentVariableNames,
      environmentOverrides: { npm_config_update_notifier: "false" },
    });
    const safeFailure = sanitizedProcessFailure(result, exactValues, `${name} failed`);
    if (result.timedOut) {
      throw new Error(`${name} timed out after ${NPM_STEP_TIMEOUT_MS}ms; check the npm cache or registry/proxy reachability. ${safeFailure}`);
    }
    if (result.exitCode !== 0 || result.spawnError) throw new Error(safeFailure);
    return result.stdout;
  }

  async function runNpm(args, cwd, name) {
    return await run(npm, [...NPM_NETWORK_ARGS, ...args], cwd, name, PROXY_ENVIRONMENT_NAMES);
  }

  try {
    temp = mkdtempSync(join(tmpdir(), "patchwarden-package-install-"));
    const packDir = join(temp, "pack");
    const consumer = join(temp, "consumer");
    try {
      mkdirSync(packDir, { recursive: true });
      mkdirSync(consumer, { recursive: true });
      const packed = JSON.parse(await runNpm(["pack", "--ignore-scripts", "--json", "--pack-destination", packDir], root, "npm pack"));
      const filename = basename(String(packed?.[0]?.filename || ""));
      if (!filename.endsWith(".tgz")) throw new Error("npm pack did not produce a tgz receipt");
      const archive = join(packDir, filename);
      if (!existsSync(archive)) throw new Error(`Packed archive missing: ${filename}`);
      writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "patchwarden-install-smoke", private: true }));
      await runNpm(["install", "--ignore-scripts", archive], consumer, "npm install isolated package");

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
      await run(process.execPath, ["--check", join(installed, "dist", "index.js")], consumer, "node --check dist/index.js");
      await run(process.execPath, ["--check", join(installed, "dist", "attestation", "cli.js")], consumer, "node --check dist/attestation/cli.js");
      console.log(`[package-install-smoke] OK: installed ${filename} into an isolated consumer.`);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(redactDiagnosticTail(message, exactValues));
  }
}

if (isMainModule()) await runPackageInstallSmoke();
