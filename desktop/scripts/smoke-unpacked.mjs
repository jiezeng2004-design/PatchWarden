#!/usr/bin/env node
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawn } from "node:child_process";

const argv = process.argv.slice(2);
function option(name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

const executable = resolve(option("--exe") || "");
const output = resolve(option("--output") || "");
const holdMs = Number(option("--hold-ms") || 10000);
const noCapture = argv.includes("--no-capture");
const requireScreenshots = argv.includes("--require-screenshots");
if (process.platform !== "win32") throw new Error("Unpacked desktop smoke requires Windows.");
if (!existsSync(executable) || basename(executable).toLowerCase() !== "patchwarden.exe") throw new Error(`Invalid unpacked executable: ${executable}`);
if (!option("--output")) throw new Error("--output is required");
if (!Number.isInteger(holdMs) || holdMs < 1000 || holdMs > 180000) throw new Error("--hold-ms must be an integer from 1000 to 180000");
if (existsSync(output)) throw new Error(`Smoke output already exists: ${output}`);
mkdirSync(output, { recursive: true });

const tempRoot = mkdtempSync(join(tmpdir(), "patchwarden-desktop-smoke-"));
const localAppData = join(tempRoot, "local");
const appData = join(tempRoot, "roaming");
const reportPath = join(localAppData, "PatchWarden", "desktop-smoke-report.json");
const isolatedConfig = join(tempRoot, "missing", "patchwarden.config.json");
const env = {
  ...process.env,
  LOCALAPPDATA: localAppData,
  APPDATA: appData,
  PATCHWARDEN_CONFIG: isolatedConfig,
  PATCHWARDEN_DESKTOP_SMOKE: "1",
  PATCHWARDEN_DESKTOP_SMOKE_HOLD_MS: String(holdMs),
  PATCHWARDEN_DESKTOP_SMOKE_CAPTURE: noCapture ? "0" : "1",
};

function launch() {
  const child = spawn(executable, [], { env, windowsHide: false, stdio: ["ignore", "pipe", "pipe"] });
  child.smokeOutput = "";
  const append = (chunk) => { child.smokeOutput = `${child.smokeOutput}${chunk}`.slice(-16000); };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  return child;
}

function waitForFile(path, timeoutMs) {
  return new Promise((resolvePromise, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      if (existsSync(path)) return resolvePromise();
      if (Date.now() >= deadline) return reject(new Error(`Timed out waiting for ${path}`));
      setTimeout(poll, 100);
    };
    poll();
  });
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolvePromise, reject) => {
    if (child.exitCode !== null) return resolvePromise(child.exitCode);
    const timer = setTimeout(() => reject(new Error(`Process ${child.pid} did not exit within ${timeoutMs}ms`)), timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolvePromise(code);
    });
  });
}

let first = null;
let second = null;
try {
  first = launch();
  await waitForFile(reportPath, 45000);
  const desktopReport = JSON.parse(readFileSync(reportPath, "utf8"));
  second = launch();
  const secondExitCode = await waitForExit(second, 5000);
  const firstExitCode = await waitForExit(first, holdMs + 10000);

  assert.equal(secondExitCode, 0, "second instance must exit successfully");
  assert.equal(firstExitCode, 0, "smoke instance must exit successfully");
  assert.equal(desktopReport.ok, true, "all smoke viewports must avoid horizontal overflow");
  assert.equal(desktopReport.packaged, true, "smoke must run the packaged executable");
  assert.equal(desktopReport.singleInstanceLock, true, "first instance must own the single-instance lock");
  assert.deepEqual(desktopReport.minimumSize, [960, 640]);
  assert.equal(desktopReport.visible, true);
  assert.match(desktopReport.pageUrl, /onboarding\/index\.html$/i);
  assert.deepEqual(desktopReport.viewports.map((item) => item.requested), [
    { width: 1280, height: 720 },
    { width: 1024, height: 700 },
    { width: 960, height: 640 },
  ]);

  const screenshots = [];
  for (const viewport of desktopReport.viewports) {
    if (!viewport.screenshot) continue;
    const target = join(output, basename(viewport.screenshot));
    copyFileSync(viewport.screenshot, target);
    screenshots.push(target);
  }
  if (requireScreenshots) assert.equal(screenshots.length, 3, "required UI smoke screenshots were not captured");
  const result = {
    ok: true,
    version: desktopReport.version,
    mode: desktopReport.mode,
    second_instance_exit_code: secondExitCode,
    viewport_count: desktopReport.viewports.length,
    screenshot_count: screenshots.length,
    screenshot_capture_errors: desktopReport.viewports.filter((item) => item.screenshotError).length,
    screenshots,
  };
  console.log(JSON.stringify(result));
} catch (error) {
  const desktopLog = join(localAppData, "PatchWarden", "desktop.log");
  if (existsSync(desktopLog)) copyFileSync(desktopLog, join(output, "desktop.log"));
  const details = [first?.smokeOutput, second?.smokeOutput].filter(Boolean).join("\n");
  throw new Error(`${error instanceof Error ? error.message : String(error)}${details ? `\nDesktop output:\n${details}` : ""}`);
} finally {
  if (second && second.exitCode === null) second.kill();
  if (first && first.exitCode === null) first.kill();
  rmSync(tempRoot, { recursive: true, force: true });
}
