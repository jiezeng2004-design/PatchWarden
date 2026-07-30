#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { reserveLoopbackPort } from "../lib/loopback-port.js";

if (process.platform !== "win32") {
  console.log("ok - PatchWarden control smoke skipped outside Windows");
  process.exit(0);
}

const scriptDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const root = resolve(scriptDir, "..", "..");
const manager = join(root, "scripts", "control", "manage-patchwarden.ps1");
const temp = mkdtempSync(join(tmpdir(), "patchwarden-control-smoke-"));
const coreHealthPort = await reserveLoopbackPort();
const directHealthPort = await reserveLoopbackPort();
const coreHealthUrl = `http://127.0.0.1:${coreHealthPort}`;
const directHealthUrl = `http://127.0.0.1:${directHealthPort}`;
const mockConfig = join(temp, "patchwarden.config.json");
writeFileSync(mockConfig, JSON.stringify({
  workspaceRoot: temp,
  plansDir: ".patchwarden/plans",
  tasksDir: ".patchwarden/tasks",
}), "utf8");
const env = {
  ...process.env,
  LOCALAPPDATA: join(temp, "LocalAppData"),
  APPDATA: join(temp, "AppData"),
  TEMP: join(temp, "Temp"),
  TMP: join(temp, "Temp"),
  PATCHWARDEN_CONFIG: mockConfig,
  PATCHWARDEN_CORE_HEALTH_URL: coreHealthUrl,
  PATCHWARDEN_DIRECT_HEALTH_URL: directHealthUrl,
  PATCHWARDEN_TEST_DISABLE_PROFILE_PROCESS_SCAN: "1",
};
let fakeTunnel = null;
let fakeWatcher = null;
let healthServer = null;
let ownedSupervisor = null;
let ownedSupervisorOutput = "";
const ownedProcessIds = [];

try {
  const statusOutput = run(["status", "all", "-Json"]);
  const statuses = JSON.parse(statusOutput);
  if (!Array.isArray(statuses) || statuses.length !== 2) {
    throw new Error(`expected two status rows, got: ${statusOutput}`);
  }
  const byMode = new Map(statuses.map((entry) => [entry.mode, entry]));
  if (byMode.get("core")?.tool_profile !== "chatgpt_core") {
    throw new Error("Core status did not report chatgpt_core");
  }
  if (byMode.get("direct")?.tool_profile !== "chatgpt_direct") {
    throw new Error("Direct status did not report chatgpt_direct");
  }

  const startPlan = run(["start", "all", "-WhatIf"]);
  requireText(startPlan, "start:core");
  requireText(startPlan, "start:direct");

  const restartPlan = run(["restart", "direct", "-WhatIf", "-SkipBuild"]);
  requireText(restartPlan, "stop:direct");
  requireText(restartPlan, "start:direct");

  const fakeDirectory = join(temp, "fake-tunnel");
  const fakeExecutable = join(fakeDirectory, "tunnel-client.exe");
  const fakeScript = join(fakeDirectory, "sleep.ps1");
  const systemPowerShell = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  mkdirSync(fakeDirectory, { recursive: true });
  copyFileSync(systemPowerShell, fakeExecutable);
  writeFileSync(fakeScript, "Start-Sleep -Seconds 120\r\n", "utf8");
  fakeTunnel = spawn(
    fakeExecutable,
    ["-NoProfile", "-File", fakeScript, "run", "--profile", "patchwarden-direct"],
    { stdio: "ignore", windowsHide: true }
  );
  await delay(500);
  if (fakeTunnel.exitCode !== null) throw new Error("fake Tunnel process exited before stop test");
  const directRuntime = join(env.LOCALAPPDATA, "patchwarden", "runtime-direct");
  mkdirSync(directRuntime, { recursive: true });
  mkdirSync(env.TEMP, { recursive: true });
  writeFileSync(join(directRuntime, "tunnel-status.json"), JSON.stringify({
    status: "stopped",
    ready: false,
    pid: null,
    tool_profile: "chatgpt_direct",
    tool_count: 19,
    tools_ready: true,
  }), "utf8");
  writeFileSync(join(directRuntime, "tunnel-client.pid"), String(fakeTunnel.pid), "utf8");
  writeFileSync(join(directRuntime, "tunnel-health-url.txt"), directHealthUrl, "utf8");
  const legacyDirectPid = join(env.TEMP, "patchwarden-direct.pid");
  const legacyDirectUrl = join(env.TEMP, "patchwarden-direct-health.url");
  writeFileSync(legacyDirectPid, String(fakeTunnel.pid), "utf8");
  writeFileSync(legacyDirectUrl, directHealthUrl, "utf8");

  const desktopOwnerA = "0123456789abcdef0123456789abcdef";
  const desktopOwnerB = "fedcba9876543210fedcba9876543210";
  const missingReceiptStop = runFailure(["stop", "direct", "-OwnedOnly", "-OwnerInstanceId", desktopOwnerA]);
  requireText(`${missingReceiptStop.stdout}\n${missingReceiptStop.stderr}`, "ownership could not be verified");
  if (fakeTunnel.exitCode !== null || !existsSync(join(directRuntime, "tunnel-client.pid"))) {
    throw new Error("owner-scoped stop changed a runtime with no ownership receipt");
  }
  writeFileSync(join(directRuntime, "tunnel-status.json"), JSON.stringify({
    status: "ready", ready: true, pid: fakeTunnel.pid, owner_instance_id: desktopOwnerB,
  }), "utf8");
  writeFileSync(join(directRuntime, "supervisor-status.json"), JSON.stringify({
    status: "running", pid: fakeTunnel.pid, owner_instance_id: desktopOwnerB,
  }), "utf8");
  const mismatchedOwnerStop = runFailure(["stop", "direct", "-OwnedOnly", "-OwnerInstanceId", desktopOwnerA]);
  requireText(`${mismatchedOwnerStop.stdout}\n${mismatchedOwnerStop.stderr}`, "ownership could not be verified");
  if (fakeTunnel.exitCode !== null || !existsSync(join(directRuntime, "tunnel-client.pid"))) {
    throw new Error("owner-scoped stop changed a runtime belonging to another Desktop instance");
  }
  writeFileSync(join(directRuntime, "supervisor-status.json"), "{not-json", "utf8");
  const corruptReceiptStop = runFailure(["stop", "direct", "-OwnedOnly", "-OwnerInstanceId", desktopOwnerA]);
  requireText(`${corruptReceiptStop.stdout}\n${corruptReceiptStop.stderr}`, "ownership could not be verified");
  if (fakeTunnel.exitCode !== null || !existsSync(join(directRuntime, "tunnel-client.pid"))) {
    throw new Error("owner-scoped stop changed a runtime with a corrupt ownership receipt");
  }

  const stopOutput = run(["stop", "direct"]);
  requireText(stopOutput, `Stopped PID ${fakeTunnel.pid}`);
  await waitForExit(fakeTunnel, 5000);
  if (fakeTunnel.exitCode === null) throw new Error("manager did not stop the owned Direct fixture process");
  for (const stalePath of [join(directRuntime, "tunnel-client.pid"), join(directRuntime, "tunnel-health-url.txt"), legacyDirectPid, legacyDirectUrl]) {
    if (existsSync(stalePath)) throw new Error(`manager did not clean stale runtime file: ${stalePath}`);
  }

  const ownedTree = join(temp, "owned-runtime-tree");
  const ownedTunnel = join(ownedTree, "tunnel-client.exe");
  const ownedSleep = join(ownedTree, "sleep.ps1");
  const ownedLauncher = join(ownedTree, "owned-launcher.ps1");
  const ownedSupervisorScript = join(ownedTree, "owned-supervisor.ps1");
  const ownedLauncherPid = join(ownedTree, "launcher.pid");
  const ownedTunnelPid = join(ownedTree, "tunnel.pid");
  mkdirSync(ownedTree, { recursive: true });
  copyFileSync(systemPowerShell, ownedTunnel);
  writeFileSync(ownedSleep, "Start-Sleep -Seconds 120\r\n", "utf8");
  writeFileSync(ownedLauncher, `
param([string]$TunnelExe, [string]$SleepScript, [string]$TunnelPidFile, [string]$ProjectRootMarker, [string]$LauncherMarker, [string]$ToolProfile, [string]$Profile, [string]$OwnerInstanceId)
$child = Start-Process -FilePath $TunnelExe -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $SleepScript, "run", "--profile", $Profile) -PassThru -WindowStyle Hidden
Set-Content -LiteralPath $TunnelPidFile -Value $child.Id -Encoding ASCII
Start-Sleep -Seconds 120
`, "utf8");
  writeFileSync(ownedSupervisorScript, `
param([string]$LauncherScript, [string]$TunnelExe, [string]$SleepScript, [string]$LauncherPidFile, [string]$TunnelPidFile, [string]$ProjectRootMarker, [string]$SupervisorMarker, [string]$ToolProfile, [string]$Profile, [string]$OwnerInstanceId)
$child = Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $LauncherScript, $TunnelExe, $SleepScript, $TunnelPidFile, $ProjectRootMarker, "scripts/control/start-patchwarden-tunnel.ps1", "-ToolProfile", $ToolProfile, "-Profile", $Profile, "-OwnerInstanceId", $OwnerInstanceId) -PassThru -WindowStyle Hidden
Set-Content -LiteralPath $LauncherPidFile -Value $child.Id -Encoding ASCII
Start-Sleep -Seconds 120
`, "utf8");
  ownedSupervisor = spawn("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ownedSupervisorScript,
    ownedLauncher, ownedTunnel, ownedSleep, ownedLauncherPid, ownedTunnelPid,
    root, "scripts/control/run-background-supervisor.ps1", "-ToolProfile", "chatgpt_direct", "-Profile", "patchwarden-direct", "-OwnerInstanceId", desktopOwnerA,
  ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  ownedSupervisor.stdout.on("data", (chunk) => { ownedSupervisorOutput += chunk.toString(); });
  ownedSupervisor.stderr.on("data", (chunk) => { ownedSupervisorOutput += chunk.toString(); });
  try {
    await waitForFile(ownedLauncherPid, 5000);
    await waitForFile(ownedTunnelPid, 5000);
  } catch (error) {
    throw new Error(`${error.message}\nowned tree output:\n${ownedSupervisorOutput}`);
  }
  const ownedLauncherId = Number(readFileSync(ownedLauncherPid, "utf8").trim());
  const ownedTunnelId = Number(readFileSync(ownedTunnelPid, "utf8").trim());
  if (!Number.isInteger(ownedLauncherId) || !Number.isInteger(ownedTunnelId)) {
    throw new Error("owned runtime fixture did not record process identifiers");
  }
  ownedProcessIds.push(ownedSupervisor.pid, ownedLauncherId, ownedTunnelId);
  writeFileSync(join(directRuntime, "tunnel-status.json"), JSON.stringify({
    status: "ready", ready: true, pid: ownedTunnelId, launcher_pid: ownedLauncherId,
    supervisor_pid: ownedSupervisor.pid, owner_instance_id: desktopOwnerA,
  }), "utf8");
  writeFileSync(join(directRuntime, "supervisor-status.json"), JSON.stringify({
    status: "running", pid: ownedSupervisor.pid, owner_instance_id: desktopOwnerA,
  }), "utf8");
  writeFileSync(join(directRuntime, "tunnel-client.pid"), String(ownedTunnelId), "utf8");
  const ownedStop = run(["stop", "direct", "-OwnedOnly", "-OwnerInstanceId", desktopOwnerA]);
  if (!ownedStop.includes("Signaled owned tunnel")) {
    throw new Error(`verified owner tree was rejected:\n${ownedStop}\nsupervisor=${processCommandLine(ownedSupervisor.pid)}\nlauncher=${processCommandLine(ownedLauncherId)}\ntunnel=${processCommandLine(ownedTunnelId)}`);
  }
  await waitForExit(ownedSupervisor, 5000);
  if (isProcessAlive(ownedLauncherId) || isProcessAlive(ownedTunnelId)) {
    throw new Error("owner-scoped stop did not stop the verified supervisor process tree");
  }
  if (existsSync(join(directRuntime, "tunnel-client.pid"))) {
    throw new Error("owner-scoped stop did not clean its verified runtime receipt");
  }

  fakeWatcher = spawn(
    process.execPath,
    ["-e", "setTimeout(()=>{},120000)", join(root, "dist", "runner", "watch.js")],
    { stdio: "ignore", windowsHide: true }
  );
  await delay(500);
  if (fakeWatcher.exitCode !== null) throw new Error("fake watcher exited before kill test");
  const killOutput = run(["kill", "core"]);
  requireText(killOutput, `Stopped PID ${fakeWatcher.pid}`);
  await waitForExit(fakeWatcher, 5000);
  if (fakeWatcher.exitCode === null) throw new Error("kill core did not stop the project-scoped watcher fixture");

  const coreRuntime = join(env.LOCALAPPDATA, "patchwarden", "runtime");
  mkdirSync(coreRuntime, { recursive: true });
  writeFileSync(join(coreRuntime, "tunnel-status.json"), JSON.stringify({
    status: "stopped",
    ready: false,
    pid: null,
    reason_code: "stale_fixture",
    last_error: "stale failure",
    tool_profile: "chatgpt_core",
    tool_count: 26,
    tools_ready: true,
  }), "utf8");
  healthServer = spawn(
    process.execPath,
    ["-e", `require('http').createServer((req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ok:true}))}).listen(${coreHealthPort},'127.0.0.1')`],
    { stdio: "ignore", windowsHide: true }
  );
  await delay(750);
  if (healthServer.exitCode !== null) throw new Error(`health fallback fixture could not listen on ${coreHealthUrl}`);
  const coreStatusRaw = run(["status", "core", "-Json"]);
  const coreStatusValue = JSON.parse(coreStatusRaw);
  const coreStatus = Array.isArray(coreStatusValue) ? coreStatusValue[0] : coreStatusValue;
  if (coreStatus.status !== "running" || coreStatus.ready !== true || coreStatus.health_alive !== true || coreStatus.reason_code !== "health_endpoint_ready") {
    throw new Error(`health fallback did not override stale runtime JSON: ${coreStatusRaw}`);
  }
  const conflict = runFailure(["restart", "core", "-WhatIf", "-SkipBuild"]);
  requireText(`${conflict.stdout}\n${conflict.stderr}`, "Unsafe health-port conflict");
  if (healthServer.exitCode !== null) throw new Error("manager killed an unrelated health-port owner");
  const scopedKill = run(["kill", "core"]);
  requireText(scopedKill, "No matching Core Agent process");
  if (healthServer.exitCode !== null) throw new Error("kill core terminated an unrelated process");

  const expectedFiles = [
    "PatchWarden.cmd",
    "scripts/launchers/PatchWarden-Control.cmd",
    "scripts/launchers/PatchWarden-Control-Tray.cmd",
    "scripts/launchers/PatchWarden-Desktop.cmd",
    "scripts/launchers/Restart-PatchWarden-Control.cmd",
    "scripts/launchers/Stop-PatchWarden.cmd",
    "scripts/control/manage-patchwarden.ps1",
    "scripts/control/run-background-supervisor.ps1",
    "scripts/control/stop-patchwarden.ps1",
    "scripts/launchers/Start-PatchWarden-Tunnel.cmd",
    "scripts/launchers/Start-PatchWarden-Direct-Tunnel.cmd",
  ];
  for (const relativePath of expectedFiles) {
    if (!existsSync(join(root, relativePath))) {
      throw new Error(`missing consolidated control file: ${relativePath}`);
    }
  }
  const rootEntry = readFileSync(join(root, "PatchWarden.cmd"), "utf8");
  if (!rootEntry.includes("manage-patchwarden.ps1")) {
    throw new Error("PatchWarden.cmd does not invoke the consolidated manager");
  }
  const stopEntry = readFileSync(join(root, "scripts", "launchers", "Stop-PatchWarden.cmd"), "utf8");
  if (!stopEntry.includes("control\\stop-patchwarden.ps1")) {
    throw new Error("Stop-PatchWarden.cmd does not invoke the one-click shutdown script");
  }
  const desktopEntry = readFileSync(join(root, "scripts", "launchers", "PatchWarden-Desktop.cmd"), "utf8");
  if (!desktopEntry.includes("control-center-tray.ps1") || !desktopEntry.includes("WindowStyle Hidden")) {
    throw new Error("PatchWarden-Desktop.cmd must launch the tray hidden as the daily desktop entry");
  }
  const managerSource = readFileSync(manager, "utf8");
  const wrapperSource = readFileSync(join(root, "scripts", "control", "run-background-supervisor.ps1"), "utf8");
  for (const expected of ["supervisor-status.json", "supervisor.stdout.log", "supervisor.stderr.log", "run-background-supervisor.ps1", "Write-BackgroundStartingState", "OwnerInstanceId", "OwnedOnly", "Get-OwnedRuntimeReceipt"]) {
    if (!managerSource.includes(expected)) {
      throw new Error(`background manager is missing supervisor observability: ${expected}`);
    }
  }
  if (!wrapperSource.includes("1> $stdout 2> $stderr") || !wrapperSource.includes("-SupervisorProcessId") || wrapperSource.includes("CONTROL_PLANE_API_KEY")) {
    throw new Error("background wrapper must redirect supervisor logs without credential arguments");
  }
  console.log("ok - control handles orphan cleanup, scoped kill, port conflicts, health fallback, and Core/Direct lifecycle actions");
} finally {
  if (fakeTunnel?.exitCode === null) fakeTunnel.kill();
  if (fakeWatcher?.exitCode === null) fakeWatcher.kill();
  if (healthServer?.exitCode === null) healthServer.kill();
  if (ownedSupervisor?.exitCode === null) ownedSupervisor.kill();
  for (const pid of ownedProcessIds) {
    try { process.kill(pid); } catch { /* fixture process already exited */ }
  }
  await Promise.all([fakeTunnel, fakeWatcher, healthServer, ownedSupervisor]
    .filter(Boolean)
    .map((child) => waitForExit(child, 3000).catch(() => undefined)));
  await Promise.all(ownedProcessIds.map((pid) => waitForPidExit(pid, 3000)));
  rmSync(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

function run(args) {
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", manager, ...args],
    { cwd: root, env, encoding: "utf8" }
  );
  if (result.status !== 0) {
    throw new Error(`manager failed (${args.join(" ")}):\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout.trim();
}

function runFailure(args) {
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", manager, ...args],
    { cwd: root, env, encoding: "utf8" }
  );
  if (result.status === 0) {
    throw new Error(`manager unexpectedly succeeded (${args.join(" ")}):\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function requireText(value, expected) {
  if (!value.toLowerCase().includes(expected.toLowerCase())) {
    throw new Error(`expected ${JSON.stringify(expected)} in output:\n${value}`);
  }
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function waitForExit(child, timeoutMilliseconds) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error("timed out waiting for fixture process to exit")), timeoutMilliseconds);
    child.once("exit", () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
}

async function waitForFile(path, timeoutMilliseconds) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await delay(50);
  }
  throw new Error(`timed out waiting for fixture file: ${path}`);
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function processCommandLine(pid) {
  const result = spawnSync("powershell.exe", [
    "-NoProfile", "-Command",
    `(Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\" -ErrorAction SilentlyContinue).CommandLine`,
  ], { encoding: "utf8" });
  return `${result.stdout || ""}${result.stderr || ""}`.trim();
}

async function waitForPidExit(pid, timeoutMilliseconds) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await delay(25);
  }
  throw new Error(`timed out waiting for fixture process ${pid} to exit`);
}
