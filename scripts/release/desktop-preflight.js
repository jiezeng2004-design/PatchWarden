#!/usr/bin/env node
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const desktopRoot = join(root, "desktop");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const argv = process.argv.slice(2);
const requireClean = argv.includes("--require-clean");
const skipUiSmoke = argv.includes("--skip-ui-smoke");

function option(name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

function json(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function directoryStats(directory) {
  let files = 0;
  let bytes = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = directoryStats(path);
      files += nested.files;
      bytes += nested.bytes;
    } else if (entry.isFile()) {
      files += 1;
      bytes += statSync(path).size;
    }
  }
  return { files, bytes };
}

function spawnSpec(command, args) {
  if (process.platform === "win32" && /\.cmd$/i.test(command)) {
    return { command: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", command, ...args] };
  }
  return { command, args };
}

function capture(command, args, cwd = root) {
  const spec = spawnSpec(command, args);
  const result = spawnSync(spec.command, spec.args, { cwd, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout || result.error?.message || "unknown error"}`);
  return String(result.stdout || "").trim();
}

const rootPackage = json(join(root, "package.json"));
const rootLock = json(join(root, "package-lock.json"));
const desktopPackage = json(join(desktopRoot, "package.json"));
const desktopLock = json(join(desktopRoot, "package-lock.json"));
const versionSource = readFileSync(join(root, "src", "version.ts"), "utf8");
const sourceVersion = versionSource.match(/PATCHWARDEN_VERSION\s*=\s*"([^"]+)"/)?.[1] || null;
const versions = [rootPackage.version, rootLock.version, rootLock.packages?.[""]?.version, desktopPackage.version, desktopLock.version, desktopLock.packages?.[""]?.version, sourceVersion];
if (versions.some((version) => version !== rootPackage.version)) throw new Error(`Version mismatch: ${versions.join(", ")}`);
if (process.platform !== "win32") throw new Error("Desktop preflight requires Windows.");

const gitStatus = capture("git", ["status", "--porcelain=v1", "-z"]);
const changedFileCount = gitStatus ? gitStatus.split("\0").filter(Boolean).length : 0;
if (requireClean && changedFileCount > 0) throw new Error(`Release preflight requires a clean worktree; found ${changedFileCount} changed paths.`);

const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
const defaultOutput = join(root, "release", `desktop-preflight-${rootPackage.version}-${stamp}`);
const outputRoot = resolve(option("--output") || defaultOutput);
if (existsSync(outputRoot)) throw new Error(`Preflight output already exists: ${outputRoot}`);
mkdirSync(outputRoot, { recursive: true });

const report = {
  schema_version: "patchwarden-desktop-preflight-v1",
  status: "running",
  started_at: new Date().toISOString(),
  finished_at: null,
  version: rootPackage.version,
  output_directory: outputRoot,
  source: {
    branch: capture("git", ["branch", "--show-current"]),
    head: capture("git", ["rev-parse", "HEAD"]),
    dirty: changedFileCount > 0,
    changed_path_count: changedFileCount,
    status_sha256: sha256(gitStatus),
    tracked_diff_sha256: sha256(capture("git", ["diff", "--binary", "HEAD"])),
  },
  environment: {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    npm: capture(npmCommand, ["--version"]),
    electron: desktopPackage.devDependencies.electron,
    electron_builder: desktopPackage.devDependencies["electron-builder"],
  },
  options: { require_clean: requireClean, skip_ui_smoke: skipUiSmoke },
  checks: [],
  package: null,
  runtime_manifest: null,
  ui_smoke: null,
  artifact: null,
  error: null,
};

function saveReport() {
  writeFileSync(join(outputRoot, "preflight-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const lines = [
    `# PatchWarden Desktop ${report.version} preflight`,
    "",
    `- Status: ${report.status}`,
    `- Source: ${report.source.branch} @ ${report.source.head}`,
    `- Dirty baseline: ${report.source.dirty} (${report.source.changed_path_count} paths, status SHA256 ${report.source.status_sha256})`,
    `- Node/npm: ${report.environment.node} / ${report.environment.npm}`,
    `- Electron: ${report.environment.electron}`,
    `- Output: ${report.output_directory}`,
    "",
    "## Checks",
    "",
    ...report.checks.map((check) => `- ${check.ok ? "PASS" : "FAIL"} ${check.name} (${check.duration_ms} ms)`),
    "",
    report.runtime_manifest ? `Packaged runtime: ${report.runtime_manifest.tool_profile}, ${report.runtime_manifest.tool_count} tools, manifest SHA256 ${report.runtime_manifest.tool_manifest_sha256}.` : "Packaged runtime: not verified.",
    report.ui_smoke ? `UI smoke: ${report.ui_smoke.ok ? "passed" : "failed"}.` : "UI smoke: not run.",
    report.error ? `\nError: ${report.error}` : "",
  ];
  writeFileSync(join(outputRoot, "preflight-report.md"), `${lines.join("\n")}\n`, "utf8");
}

function run(name, command, args, cwd = root) {
  const started = Date.now();
  const spec = spawnSpec(command, args);
  const result = spawnSync(spec.command, spec.args, { cwd, encoding: "utf8", windowsHide: true, maxBuffer: 128 * 1024 * 1024 });
  const stdout = String(result.stdout || "");
  const stderr = String(result.stderr || "");
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  const check = { name, ok: result.status === 0, exit_code: result.status, duration_ms: Date.now() - started };
  report.checks.push(check);
  saveReport();
  if (!check.ok) throw new Error(`${name} failed with exit code ${result.status ?? "unknown"}: ${stderr || result.error?.message || "see command output"}`);
  return stdout;
}

let isolatedRoot = null;
try {
  run("root clean build", npmCommand, ["run", "build"]);
  run("build output contract", npmCommand, ["run", "check:build-output"]);
  const unitOutput = run("root unit tests", npmCommand, ["run", "test:unit"]);
  const desktopOutput = run("desktop tests", npmCommand, ["run", "desktop:test"]);
  const packageOutput = run("npm package surface", npmCommand, ["run", "verify:package"]);
  run("desktop staging", npmCommand, ["run", "desktop:stage"]);
  run("Electron directory package", npmCommand, ["exec", "electron-builder", "--", "--win", "dir", "--x64", `--config.directories.output=${outputRoot}`], desktopRoot);

  report.package = {
    npm_file_count: Number(packageOutput.match(/OK:\s+(\d+) package files/)?.[1] || 0),
    root_unit_tests: Number([...unitOutput.matchAll(/tests\s+(\d+)/g)].at(-1)?.[1] || 0),
    desktop_tests: Number([...desktopOutput.matchAll(/tests\s+(\d+)/g)].at(-1)?.[1] || 0),
  };

  const unpackedRoot = join(outputRoot, "win-unpacked");
  const executable = join(unpackedRoot, "PatchWarden.exe");
  const packagedCore = join(unpackedRoot, "resources", "core");
  if (!existsSync(executable) || !existsSync(packagedCore)) throw new Error("Electron directory package is missing its executable or core runtime.");
  for (const forbidden of ["dist/test", "src/test", "docs/archive", "scripts/checks/doctor-smoke.js"]) {
    if (existsSync(join(packagedCore, forbidden))) throw new Error(`Packaged core contains development-only path: ${forbidden}`);
  }
  const packagedChecks = readdirSync(join(packagedCore, "scripts", "checks")).sort();
  if (JSON.stringify(packagedChecks) !== JSON.stringify(["mcp-manifest-check.js"])) {
    throw new Error(`Packaged core has unexpected check scripts: ${packagedChecks.join(", ")}`);
  }
  const coreStats = directoryStats(packagedCore);
  report.package.packaged_core_file_count = coreStats.files;
  report.package.packaged_core_size_bytes = coreStats.bytes;

  isolatedRoot = join(tmpdir(), `patchwarden-preflight-${process.pid}-${Date.now()}`);
  cpSync(packagedCore, isolatedRoot, { recursive: true });
  const manifestOutput = run("isolated packaged runtime manifest", process.execPath, ["scripts/checks/mcp-manifest-check.js", "--profile", "chatgpt_core"], isolatedRoot);
  report.runtime_manifest = JSON.parse(manifestOutput);
  if (!report.runtime_manifest.ok || report.runtime_manifest.server_version !== rootPackage.version || report.runtime_manifest.tool_count !== 26) {
    throw new Error("Packaged runtime manifest did not match the 1.6.1 26-tool contract.");
  }

  if (!skipUiSmoke) {
    const smokeOutput = run("unpacked desktop UI smoke", process.execPath, ["scripts/smoke-unpacked.mjs", "--exe", executable, "--output", join(outputRoot, "ui-smoke")], desktopRoot);
    report.ui_smoke = JSON.parse(smokeOutput.trim().split(/\r?\n/).at(-1));
    if (!report.ui_smoke.ok) throw new Error("Unpacked desktop UI smoke did not pass.");
  }

  report.artifact = {
    name: basename(executable),
    size_bytes: readFileSync(executable).length,
    sha256: sha256(readFileSync(executable)),
  };
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  if (isolatedRoot) rmSync(isolatedRoot, { recursive: true, force: true });
  report.finished_at = new Date().toISOString();
  saveReport();
}

console.log(`[desktop-preflight] PASS: ${outputRoot}`);
