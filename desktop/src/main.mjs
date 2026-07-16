import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  shell,
  Tray,
  utilityProcess,
} from "electron";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { detectAgents } from "./agent-detection.mjs";
import {
  atomicWriteJson,
  buildConfig,
  readJson,
  readPreferences,
  readRuntimeSettings,
  resolveDesktopLanguage,
  resolveDesktopPaths,
  updatePreferences,
  updateRuntimeSettings,
} from "./config-store.mjs";
import { mayStopBackend, probeControlCenter } from "./backend-probe.mjs";
import { detectTunnelClient, validateTunnelClientPath } from "./runtime-settings.mjs";
import { resolveCoreRoot, utilityProcessOptions } from "./runtime-root.mjs";
import {
  forgetTunnelCredential,
  getTunnelSetupStatus,
  provisionTunnelProfile,
  revalidateTunnelProfile,
} from "./tunnel-provisioner.mjs";

const CONTROL_URL = "http://127.0.0.1:8090";
const ALLOWED_CONTROL_ACTIONS = new Map([
  ["start", "/api/start-all"],
  ["stop", "/api/stop-all"],
  ["restart", "/api/restart-all"],
]);

const desktopRoot = resolve(import.meta.dirname, "..");
const coreRoot = resolveCoreRoot({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, desktopRoot });
const preloadPath = join(desktopRoot, "src", "preload.cjs");
const onboardingPath = join(desktopRoot, "onboarding", "index.html");
const iconPath = app.isPackaged ? join(process.resourcesPath, "icon.ico") : join(desktopRoot, ".stage", "icon.ico");
const trayIconPath = app.isPackaged ? join(process.resourcesPath, "icon.png") : join(desktopRoot, ".stage", "icon.png");

let mainWindow = null;
let tray = null;
let ownedBackend = null;
let quitting = false;
let appMode = "starting";
let blockReason = null;
let detectedAgents = [];
let desktopPaths = null;
let preferences = null;
let activeConfigPath = null;
let desktopLogPath = null;

app.setName("PatchWarden");
if (process.env.LOCALAPPDATA) {
  app.setPath("userData", join(process.env.LOCALAPPDATA, "PatchWarden"));
}
const gotLock = app.requestSingleInstanceLock();
console.log(`[desktop] single-instance lock: ${gotLock ? "acquired" : "unavailable"}`);
if (!gotLock) app.quit();

app.on("second-instance", () => showWindow());
app.on("window-all-closed", () => {
  if (quitting || (preferences && preferences.closeBehavior === "quit")) app.quit();
});
app.on("before-quit", () => { quitting = true; });
app.on("will-quit", () => stopOwnedBackend());

function writeAppLog(message, error = null) {
  if (!desktopLogPath) return;
  try {
    mkdirSync(resolve(desktopLogPath, ".."), { recursive: true });
    const detail = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack || ""}` : error ? String(error) : "";
    appendFileSync(desktopLogPath, `${new Date().toISOString()} ${message}${detail ? ` ${detail}` : ""}\n`, "utf8");
  } catch { /* logging must never block startup */ }
}

function readCoreVersion() {
  try {
    return JSON.parse(readFileSync(join(coreRoot, "package.json"), "utf8")).version || app.getVersion();
  } catch {
    return app.getVersion();
  }
}

function allowedSender(event) {
  const url = event.senderFrame && event.senderFrame.url ? event.senderFrame.url : "";
  return url === pathToFileURL(onboardingPath).href || url.startsWith(`${CONTROL_URL}/`);
}

function registerIpc(channel, handler) {
  ipcMain.handle(channel, async (event, value) => {
    if (!allowedSender(event)) throw new Error("Desktop request rejected for this page");
    return handler(value);
  });
}

function applyTheme(value) {
  nativeTheme.themeSource = value === "light" || value === "dark" ? value : "system";
}

function currentState() {
  return {
    mode: appMode,
    version: readCoreVersion(),
    reason: blockReason,
    configPath: activeConfigPath,
    backend: {
      owned: Boolean(ownedBackend),
      pid: ownedBackend ? ownedBackend.pid : null,
      port: 8090,
      url: CONTROL_URL,
    },
    preferences,
    resolvedLanguage: resolveLanguage(preferences?.language),
    runtimeSettings: activeConfigPath ? readRuntimeSettings(activeConfigPath) : null,
  };
}

function resolveLanguage(language) {
  return resolveDesktopLanguage(language, app.getLocale());
}

function desktopText(key) {
  const en = resolveLanguage(preferences?.language) === "en";
  const values = {
    show: ["显示 PatchWarden", "Show PatchWarden"],
    start: ["启动 Core（Direct 可选）", "Start Core (Direct optional)"],
    stop: ["停止 Core / Direct", "Stop Core / Direct"],
    restart: ["重启 Core（Direct 可选）", "Restart Core (Direct optional)"],
    logs: ["打开日志目录", "Open logs folder"],
    quit: ["退出桌面应用", "Quit desktop app"],
    stopQuit: ["停止全部并退出", "Stop all and quit"],
    window: ["PatchWarden 开始使用", "PatchWarden Getting Started"],
  };
  return values[key]?.[en ? 1 : 0] || key;
}

async function validateWorkspace(workspaceRoot) {
  const moduleUrl = pathToFileURL(join(coreRoot, "dist", "security", "workspaceRootGuard.js")).href;
  const { validateWorkspaceRoot } = await import(moduleUrl);
  return validateWorkspaceRoot(workspaceRoot);
}

function configIsUsable(path) {
  const config = readJson(path);
  return Boolean(config && typeof config.workspaceRoot === "string" && config.workspaceRoot.trim());
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 2500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function waitForBackend(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await probeControlCenter(fetchWithTimeout, CONTROL_URL, activeConfigPath);
    if (result.kind === "patchwarden") return result;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 350));
  }
  return { kind: "absent", version: null };
}

function spawnBackend() {
  const entry = join(coreRoot, "dist", "controlCenter.js");
  const detectedTunnel = detectTunnelClient({ config: readJson(activeConfigPath) || {}, env: process.env });
  const backendEnv = {
    ...process.env,
    PATCHWARDEN_CONFIG: activeConfigPath,
    PATCHWARDEN_CONTROL_PORT: "8090",
    PATCHWARDEN_DESKTOP_RUNTIME: "1",
  };
  if (detectedTunnel.available) backendEnv.PATCHWARDEN_TUNNEL_CLIENT_EXE = detectedTunnel.path;
  ownedBackend = utilityProcess.fork(entry, ["--port", "8090"], utilityProcessOptions(coreRoot, {
      ...backendEnv,
    }, "PatchWarden Control Center"));
  const child = ownedBackend;
  writeAppLog(`Started owned Control Center child pid=${child.pid || "unknown"}.`);
  child.on("exit", () => {
    if (mayStopBackend(ownedBackend, child)) ownedBackend = null;
  });
}

async function ensureBackend() {
  const probe = await probeControlCenter(fetchWithTimeout, CONTROL_URL, activeConfigPath);
  if (probe.kind === "patchwarden") {
    appMode = "ready";
    blockReason = null;
    return true;
  }
  if (probe.kind === "foreign") {
    appMode = "blocked";
    blockReason = "端口 8090 已被其他程序占用，PatchWarden 没有抢占该端口。";
    return false;
  }
  if (probe.kind === "mismatched_patchwarden") {
    appMode = "blocked";
    blockReason = "端口 8090 上已有使用其他配置的 PatchWarden Control Center。请先退出该实例，再重新打开桌面应用。";
    return false;
  }
  spawnBackend();
  const ready = await waitForBackend();
  if (ready.kind !== "patchwarden") {
    appMode = "blocked";
    blockReason = "Control Center 未能在 15 秒内启动，请查看桌面日志。";
    stopOwnedBackend();
    return false;
  }
  appMode = "ready";
  blockReason = null;
  return true;
}

function stopOwnedBackend() {
  if (!ownedBackend) return;
  const child = ownedBackend;
  ownedBackend = null;
  writeAppLog(`Stopping owned Control Center child pid=${child.pid || "unknown"}.`);
  try { child.kill(); } catch { /* already stopped */ }
}

async function restartOwnedBackendAndLoad() {
  stopOwnedBackend();
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
  const ready = await ensureBackend();
  if (ready) await loadDashboard();
  else await loadOnboarding();
}

async function controlAction(action) {
  const route = ALLOWED_CONTROL_ACTIONS.get(action);
  if (!route) throw new Error("Unsupported control action");
  const tokenResponse = await fetchWithTimeout(`${CONTROL_URL}/control-token.json`);
  if (!tokenResponse.ok) throw new Error("Control Center token is unavailable");
  const tokenBody = await tokenResponse.json();
  const response = await fetchWithTimeout(`${CONTROL_URL}${route}`, {
    method: "POST",
    headers: { "X-PatchWarden-Control-Token": tokenBody.token },
  }, 45_000);
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) throw new Error(body.error || body.reason || `Control action failed (${response.status})`);
  return body;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#101318" : "#f5f7f8",
    icon: existsSync(iconPath) ? iconPath : undefined,
    autoHideMenuBar: true,
    title: desktopText("window"),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const allowed = url === pathToFileURL(onboardingPath).href || url.startsWith(`${CONTROL_URL}/`);
    if (!allowed) event.preventDefault();
  });
  mainWindow.webContents.on("did-fail-load", (_event, code, description) => {
    writeAppLog(`Renderer load failed code=${code} description=${description}.`);
  });
  mainWindow.webContents.on("page-title-updated", (event) => {
    event.preventDefault();
    mainWindow?.setTitle(desktopText("window"));
  });
  mainWindow.on("close", (event) => {
    if (quitting || preferences.closeBehavior === "quit") return;
    event.preventDefault();
    mainWindow.hide();
  });
}

function showWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

async function loadOnboarding() {
  if (!mainWindow) return;
  await mainWindow.loadFile(onboardingPath);
  showWindow();
  writeAppLog("Displayed desktop setup window.");
}

async function loadDashboard() {
  if (!mainWindow) return;
  await mainWindow.loadURL(`${CONTROL_URL}/pages/getting-started.html`);
  showWindow();
  writeAppLog("Displayed desktop getting-started page.");
}

function createTray() {
  const image = existsSync(trayIconPath) ? nativeImage.createFromPath(trayIconPath) : nativeImage.createEmpty();
  if (image.isEmpty()) throw new Error("Desktop tray icon could not be decoded");
  tray = new Tray(image);
  tray.setToolTip("PatchWarden");
  updateTrayMenu();
  tray.on("double-click", showWindow);
}

function updateTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: desktopText("show"), click: showWindow },
    { type: "separator" },
    { label: desktopText("start"), click: () => void controlAction("start").catch(showTrayError) },
    { label: desktopText("stop"), click: () => void controlAction("stop").catch(showTrayError) },
    { label: desktopText("restart"), click: () => void controlAction("restart").catch(showTrayError) },
    { label: desktopText("logs"), click: () => void shell.openPath(desktopPaths.logs) },
    { type: "separator" },
    { label: desktopText("quit"), click: quitDesktop },
    { label: desktopText("stopQuit"), click: () => void stopAllAndQuit() },
  ]));
}

function showTrayError(error) {
  if (tray) tray.displayBalloon({ title: "PatchWarden", content: error instanceof Error ? error.message : String(error) });
}

function quitDesktop() {
  quitting = true;
  app.quit();
}

async function stopAllAndQuit() {
  try { await controlAction("stop"); } catch { /* explicit exit still proceeds */ }
  quitDesktop();
}

async function runDoctor() {
  return new Promise((resolvePromise) => {
    const entry = join(coreRoot, "dist", "doctor.js");
    const child = utilityProcess.fork(entry, [], utilityProcessOptions(
      coreRoot,
      { ...process.env, PATCHWARDEN_CONFIG: activeConfigPath, PATCHWARDEN_DESKTOP_RUNTIME: "1" },
      "PatchWarden Doctor",
    ));
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout = (stdout + chunk.toString()).slice(-24000); });
    child.stderr?.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-8000); });
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, 30000);
    child.on("exit", async (code) => {
      clearTimeout(timer);
      const output = `${stdout}${stderr ? `\n${stderr}` : ""}`.trim();
      const result = {
        ok: code === 0,
        counts: {
          ok: (output.match(/\bOK\b/g) || []).length,
          warn: (output.match(/\bWARN\b/g) || []).length,
          fail: (output.match(/\bFAIL\b/g) || []).length,
        },
        output,
      };
      resolvePromise(result);
      if (appMode === "setup-check") {
        setTimeout(() => { void restartOwnedBackendAndLoad(); }, 900);
      }
    });
  });
}

function registerDesktopIpc() {
  registerIpc("desktop:get-state", async () => currentState());
  registerIpc("desktop:choose-workspace", async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"], title: "选择 PatchWarden 工作区" });
    return result.canceled || result.filePaths.length !== 1 ? null : result.filePaths[0];
  });
  registerIpc("desktop:choose-tunnel-client", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openFile"],
      title: "选择 tunnel-client.exe",
      filters: [{ name: "tunnel-client.exe", extensions: ["exe"] }],
    });
    if (result.canceled || result.filePaths.length !== 1) return null;
    const validation = validateTunnelClientPath(result.filePaths[0]);
    return validation.ok ? { ok: true, path: validation.path, source: "用户选择" } : validation;
  });
  registerIpc("desktop:detect-tunnel-client", async () => {
    return detectTunnelClient({ config: readJson(activeConfigPath) || {}, env: process.env });
  });
  registerIpc("desktop:detect-agents", async () => {
    detectedAgents = await detectAgents();
    return detectedAgents;
  });
  registerIpc("desktop:save-setup", async (value) => {
    if (!value || typeof value.workspaceRoot !== "string" || !Array.isArray(value.enabledAgents)) {
      return { ok: false, error: "配置数据无效" };
    }
    const validation = await validateWorkspace(value.workspaceRoot);
    if (!validation.ok) return { ok: false, error: validation.reason, validation };
    const enabledNames = new Set(value.enabledAgents.filter((name) => name === "codex" || name === "opencode"));
    const selected = detectedAgents.filter((agent) => enabledNames.has(agent.name) && agent.available);
    atomicWriteJson(activeConfigPath, buildConfig(validation.path, selected), true);
    if (appMode === "ready") {
      setTimeout(() => { void restartOwnedBackendAndLoad(); }, 300);
    } else {
      appMode = "setup-check";
    }
    return { ok: true, workspaceRoot: validation.path, agentCount: selected.length };
  });
  registerIpc("desktop:run-doctor", runDoctor);
  registerIpc("desktop:get-preferences", async () => preferences);
  registerIpc("desktop:set-preferences", async (value) => {
    preferences = updatePreferences(desktopPaths.preferences, value || {});
    applyTheme(preferences.theme);
    mainWindow?.setTitle(desktopText("window"));
    updateTrayMenu();
    return preferences;
  });
  registerIpc("desktop:get-runtime-settings", async () => readRuntimeSettings(activeConfigPath));
  registerIpc("desktop:set-runtime-settings", async (value) => {
    if (!value || typeof value !== "object") throw new Error("运行设置数据无效");
    if (value.tunnelClientPath) {
      const validation = validateTunnelClientPath(value.tunnelClientPath);
      if (!validation.ok) throw new Error(validation.error);
    }
    const settings = updateRuntimeSettings(activeConfigPath, value);
    const restartRequired = !ownedBackend;
    if (ownedBackend) setTimeout(() => { void restartOwnedBackendAndLoad(); }, 250);
    return { ok: true, settings, restartRequired };
  });
  registerIpc("desktop:get-tunnel-setup-status", async (mode) => getTunnelSetupStatus({
    mode,
    configPath: activeConfigPath,
    statusPath: desktopPaths.tunnelSetupStatus,
    credentialPath: desktopPaths.credential,
  }));
  registerIpc("desktop:provision-tunnel-profile", async (value) => {
    if (!value || typeof value !== "object") return { ok: false, reason_code: "invalid_request" };
    let runtimeKey = typeof value.runtimeKey === "string" ? value.runtimeKey : "";
    try {
      return await provisionTunnelProfile({
        mode: value.mode,
        tunnelId: value.tunnelId,
        runtimeKey,
        configPath: activeConfigPath,
        statusPath: desktopPaths.tunnelSetupStatus,
        credentialPath: desktopPaths.credential,
        projectRoot: coreRoot,
      });
    } finally {
      runtimeKey = "";
      try { value.runtimeKey = ""; } catch { /* IPC clone may be immutable */ }
    }
  });
  registerIpc("desktop:revalidate-tunnel-profile", async (mode) => revalidateTunnelProfile({
    mode,
    configPath: activeConfigPath,
    statusPath: desktopPaths.tunnelSetupStatus,
    credentialPath: desktopPaths.credential,
    projectRoot: coreRoot,
  }));
  registerIpc("desktop:forget-tunnel-credential", async () => forgetTunnelCredential(desktopPaths.credential));
  registerIpc("desktop:open-path", async (kind) => {
    const target = kind === "logs" ? desktopPaths.logs : kind === "config" ? activeConfigPath : null;
    if (!target) throw new Error("Unsupported desktop path");
    return shell.openPath(target);
  });
}

async function bootstrap() {
  await app.whenReady();
  app.setAppUserModelId("io.github.jiezeng2004design.patchwarden");
  desktopPaths = resolveDesktopPaths(process.env, app.getPath("userData"));
  desktopLogPath = join(desktopPaths.root, "desktop.log");
  writeAppLog(`Starting PatchWarden Desktop ${readCoreVersion()}.`);
  preferences = readPreferences(desktopPaths.preferences);
  applyTheme(preferences.theme);
  activeConfigPath = desktopPaths.config;
  registerDesktopIpc();
  createWindow();

  if (configIsUsable(activeConfigPath)) {
    const ready = await ensureBackend();
    if (ready) await loadDashboard();
    else await loadOnboarding();
  } else {
    appMode = "setup";
    await loadOnboarding();
  }

  try {
    createTray();
  } catch (error) {
    preferences = { ...preferences, closeBehavior: "quit" };
    writeAppLog("Tray initialization failed; close behavior changed to quit for this run.", error);
  }
}

if (gotLock) {
  void bootstrap().catch((error) => {
    writeAppLog("Desktop bootstrap failed.", error);
    dialog.showErrorBox("PatchWarden Desktop", `桌面应用启动失败。请查看 desktop.log。\n\n${error instanceof Error ? error.message : String(error)}`);
    quitting = true;
    app.quit();
  });
}
