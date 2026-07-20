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
  type IpcMainInvokeEvent,
} from "electron";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { detectAgents, getAgentAdapter, refreshAgentModels } from "./agent-detection.js";
import { discoverModelsForAgent } from "./model-discovery.js";
import {
  atomicWriteJson,
  buildConfig,
  readAgentSettings,
  readJson,
  readPreferences,
  readRuntimeSettings,
  resolveDesktopLanguage,
  resolveDesktopPaths,
  updatePreferences,
  updateAgentSettings,
  updateRuntimeSettings,
} from "./config-store.js";
import type { AgentDetection, AgentDetectionInput, AgentRegistration } from "./agent-adapters.js";
import type { AgentSelection, DesktopPaths, DesktopPreferences } from "./config-store.js";
import { mayStopBackend, probeControlCenter, type ProbeFetchImpl } from "./backend-probe.js";
import { createSerializedRestartScheduler, stopBackendChild } from "./backend-lifecycle.js";
import { detectTunnelClient, validateTunnelClientPath } from "./runtime-settings.js";
import { resolveCoreRoot, utilityProcessOptions } from "./runtime-root.js";
import {
  forgetTunnelCredential,
  getTunnelSetupStatus,
  provisionTunnelProfile,
  revalidateTunnelProfile,
} from "./tunnel-provisioner.js";

const CONTROL_URL = "http://127.0.0.1:8090";
const smokeMode = process.env.PATCHWARDEN_DESKTOP_SMOKE === "1";
const ALLOWED_CONTROL_ACTIONS = new Map<string, string>([
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

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let ownedBackend: ReturnType<typeof utilityProcess.fork> | null = null;
let quitting = false;
let appMode = "starting";
let blockReason: string | null = null;
let detectedAgents: AgentDetection[] = [];
let desktopPaths: DesktopPaths | null = null;
let preferences: DesktopPreferences | null = null;
let activeConfigPath: string | null = null;
let desktopLogPath: string | null = null;

type JsonRecord = Record<string, unknown>;
type DesktopIpcHandler = (value: unknown) => unknown | Promise<unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function tunnelDetectionConfig(value: unknown): { tunnelClientPath?: string; workspaceRoot?: string } {
  const config = asRecord(value);
  return {
    ...(typeof config.tunnelClientPath === "string" ? { tunnelClientPath: config.tunnelClientPath } : {}),
    ...(typeof config.workspaceRoot === "string" ? { workspaceRoot: config.workspaceRoot } : {}),
  };
}

function requireAgentId(value: unknown): string {
  if (typeof value !== "string" || !getAgentAdapter(value)) throw new Error("不支持的 Agent");
  return value;
}

function requireTunnelMode(value: unknown): "core" | "direct" {
  if (value !== "core" && value !== "direct") throw new Error("Unsupported tunnel setup mode");
  return value;
}

function parseAgentSelections(value: unknown): AgentSelection[] {
  if (!Array.isArray(value)) throw new Error("Agent 设置数据无效");
  return value.map((item) => {
    if (!isRecord(item) || typeof item.id !== "string") throw new Error("Agent 设置数据无效");
    if (item.enabled !== undefined && typeof item.enabled !== "boolean") throw new Error("Agent 设置数据无效");
    if (item.model !== undefined && item.model !== null && typeof item.model !== "string") throw new Error("Agent 设置数据无效");
    return {
      id: item.id,
      ...(typeof item.enabled === "boolean" ? { enabled: item.enabled } : {}),
      ...(typeof item.model === "string" || item.model === null ? { model: item.model } : {}),
    };
  });
}

function isAgentRegistration(value: unknown): value is AgentRegistration {
  if (!isRecord(value) || typeof value.command !== "string") return false;
  if (!Array.isArray(value.args) || value.args.some((arg) => typeof arg !== "string")) return false;
  if (value.adapter !== undefined && typeof value.adapter !== "string") return false;
  if (value.model !== undefined && typeof value.model !== "string") return false;
  return value.envAllowlist === undefined
    || (Array.isArray(value.envAllowlist) && value.envAllowlist.every((name) => typeof name === "string"));
}

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
app.on("will-quit", () => { void stopOwnedBackend(); });

function writeAppLog(message: string, error: unknown = null): void {
  if (!desktopLogPath) return;
  try {
    mkdirSync(resolve(desktopLogPath, ".."), { recursive: true });
    const detail = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack || ""}` : error ? String(error) : "";
    appendFileSync(desktopLogPath, `${new Date().toISOString()} ${message}${detail ? ` ${detail}` : ""}\n`, "utf8");
  } catch { /* logging must never block startup */ }
}

function readCoreVersion(): string {
  try {
    const manifest = asRecord(JSON.parse(readFileSync(join(coreRoot, "package.json"), "utf8")));
    return typeof manifest.version === "string" && manifest.version ? manifest.version : app.getVersion();
  } catch {
    return app.getVersion();
  }
}

function allowedSender(event: IpcMainInvokeEvent): boolean {
  const url = event.senderFrame && event.senderFrame.url ? event.senderFrame.url : "";
  return url === pathToFileURL(onboardingPath).href || url.startsWith(`${CONTROL_URL}/`);
}

function registerIpc(channel: string, handler: DesktopIpcHandler): void {
  ipcMain.handle(channel, async (event: IpcMainInvokeEvent, value?: unknown) => {
    if (!allowedSender(event)) throw new Error("Desktop request rejected for this page");
    return handler(value);
  });
}

function applyTheme(value: string | undefined): void {
  nativeTheme.themeSource = value === "light" || value === "dark" ? value : "system";
}

function currentState(): Record<string, unknown> {
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

function configuredWorkspaceRoot(): string {
  const config = asRecord(activeConfigPath ? readJson(activeConfigPath) : null);
  return config && typeof config.workspaceRoot === "string" ? config.workspaceRoot : process.cwd();
}

function configuredAgentEnvironmentPolicy(agentId?: string): {
  allowedNames: string[];
  blockedNames: string[];
} {
  const config = asRecord(activeConfigPath ? readJson(activeConfigPath) : null);
  const agentsValue = config.agents;
  if (agentsValue !== undefined && !isRecord(agentsValue)) {
    throw new Error("Agent 配置无效");
  }
  const agents = asRecord(agentsValue);
  const registrations = agentId ? [agents[agentId]] : Object.values(agents);
  const allowedNames: string[] = [];
  for (const value of registrations) {
    if (!isRecord(value)) continue;
    const registration = value;
    const envAllowlist = registration.envAllowlist;
    if (envAllowlist === undefined) continue;
    if (!Array.isArray(envAllowlist) || envAllowlist.some((name: unknown) => typeof name !== "string")) {
      throw new Error("Agent envAllowlist 配置无效");
    }
    allowedNames.push(...envAllowlist);
  }
  const ownerTokenEnv = asRecord(config.http).ownerTokenEnv;
  if (ownerTokenEnv !== undefined && typeof ownerTokenEnv !== "string") {
    throw new Error("HTTP ownerTokenEnv 配置无效");
  }
  return {
    allowedNames: [...new Set(allowedNames)],
    blockedNames: ownerTokenEnv ? [ownerTokenEnv] : [],
  };
}

function publicAgentCatalog() {
  const configured = new Map((activeConfigPath ? readAgentSettings(activeConfigPath) : []).map((agent) => [agent.id, agent]));
  const workspaceRoot = configuredWorkspaceRoot();
  return detectedAgents.map((agent) => {
    const local = discoverModelsForAgent(agent.id, workspaceRoot);
    const setting = configured.get(agent.id);
    return {
      id: agent.id,
      name: agent.id,
      displayName: agent.displayName,
      available: agent.available,
      enabled: setting ? true : false,
      selectedModel: setting?.model || null,
      models: local.models,
      modelSources: local.sources,
      commandLabel: agent.command ? `${agent.displayName} (${agent.source})` : null,
      supportsModelOverride: agent.supportsModelOverride,
      supportsModelRefresh: agent.supportsModelRefresh,
      reason: agent.reason,
    };
  });
}

function resolveLanguage(language: string | undefined): "zh-CN" | "en" {
  return resolveDesktopLanguage(language, app.getLocale());
}

function desktopText(key: string): string {
  const en = resolveLanguage(preferences?.language) === "en";
  const values: Record<string, [string, string]> = {
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

async function validateWorkspace(workspaceRoot: string): Promise<{ ok: boolean; path?: string; reason?: string }> {
  const moduleUrl = pathToFileURL(join(coreRoot, "dist", "security", "workspaceRootGuard.js")).href;
  const { validateWorkspaceRoot } = await import(moduleUrl) as { validateWorkspaceRoot: (root: string) => { ok: boolean; path?: string; reason?: string } };
  return validateWorkspaceRoot(workspaceRoot);
}

function configIsUsable(path: string): boolean {
  const config = asRecord(readJson(path));
  return Boolean(config && typeof config.workspaceRoot === "string" && config.workspaceRoot.trim());
}

async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs: number = 2500): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const probeFetch: ProbeFetchImpl = (url) => fetchWithTimeout(url);

async function waitForBackend(timeoutMs: number = 15000): Promise<{ kind: string; version: string | null }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await probeControlCenter(probeFetch, CONTROL_URL, activeConfigPath);
    if (result.kind === "patchwarden") return result;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 350));
  }
  return { kind: "absent", version: null };
}

function spawnBackend(): void {
  const entry = join(coreRoot, "dist", "controlCenter.js");
  const detectedTunnel = detectTunnelClient({ config: tunnelDetectionConfig(readJson(activeConfigPath!)), env: process.env });
  const backendEnv: NodeJS.ProcessEnv = {
    PATCHWARDEN_CONFIG: activeConfigPath || "",
    PATCHWARDEN_CONTROL_PORT: "8090",
    PATCHWARDEN_DESKTOP_RUNTIME: "1",
  };
  if (detectedTunnel.available) backendEnv.PATCHWARDEN_TUNNEL_CLIENT_EXE = detectedTunnel.path as string;
  ownedBackend = utilityProcess.fork(entry, ["--port", "8090"], utilityProcessOptions(
    coreRoot,
    backendEnv,
    "PatchWarden Control Center",
    configuredAgentEnvironmentPolicy(),
  ));
  const child = ownedBackend;
  writeAppLog(`Started owned Control Center child pid=${child?.pid || "unknown"}.`);
  child?.on("exit", () => {
    if (mayStopBackend(ownedBackend, child)) ownedBackend = null;
  });
}

async function ensureBackend(): Promise<boolean> {
  const probe = await probeControlCenter(probeFetch, CONTROL_URL, activeConfigPath);
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
    await stopOwnedBackend();
    return false;
  }
  appMode = "ready";
  blockReason = null;
  return true;
}

async function stopOwnedBackend(): Promise<boolean> {
  if (!ownedBackend) return true;
  const child = ownedBackend;
  ownedBackend = null;
  writeAppLog(`Stopping owned Control Center child pid=${child?.pid || "unknown"}.`);
  return stopBackendChild(child);
}

async function restartOwnedBackendAndLoad(): Promise<void> {
  const stopped = await stopOwnedBackend();
  if (!stopped) {
    appMode = "blocked";
    blockReason = "Control Center 未能在 5 秒内退出；为避免重复实例，桌面应用没有启动替代进程。";
    await loadOnboarding();
    return;
  }
  const ready = await ensureBackend();
  if (ready) await loadDashboard();
  else await loadOnboarding();
}

const scheduleBackendRestart = createSerializedRestartScheduler(restartOwnedBackendAndLoad);

function requestBackendRestart(delayMs: number): void {
  void scheduleBackendRestart(delayMs).catch((error) => {
    writeAppLog("Serialized Control Center restart failed.", error);
    appMode = "blocked";
    blockReason = error instanceof Error ? error.message : String(error);
  });
}

async function controlAction(action: string): Promise<JsonRecord> {
  const route = ALLOWED_CONTROL_ACTIONS.get(action);
  if (!route) throw new Error("Unsupported control action");
  const tokenResponse = await fetchWithTimeout(`${CONTROL_URL}/control-token.json`);
  if (!tokenResponse.ok) throw new Error("Control Center token is unavailable");
  const tokenBody = asRecord(await tokenResponse.json());
  if (typeof tokenBody.token !== "string" || !tokenBody.token) throw new Error("Control Center token is invalid");
  const response = await fetchWithTimeout(`${CONTROL_URL}${route}`, {
    method: "POST",
    headers: { "X-PatchWarden-Control-Token": tokenBody.token },
  }, 45_000);
  const body = asRecord(await response.json().catch(() => ({})));
  const failure = typeof body.error === "string"
    ? body.error
    : typeof body.reason === "string"
      ? body.reason
      : `Control action failed (${response.status})`;
  if (!response.ok || body.ok === false) throw new Error(failure);
  return body;
}

function createWindow(): void {
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
    if (quitting || (preferences && preferences.closeBehavior === "quit")) return;
    event.preventDefault();
    mainWindow?.hide();
  });
}

function showWindow(): void {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

async function loadOnboarding(): Promise<void> {
  if (!mainWindow) return;
  await mainWindow.loadFile(onboardingPath);
  showWindow();
  writeAppLog("Displayed desktop setup window.");
}

async function loadDashboard(): Promise<void> {
  if (!mainWindow) return;
  await mainWindow.loadURL(`${CONTROL_URL}/pages/getting-started.html`);
  showWindow();
  writeAppLog("Displayed desktop getting-started page.");
}

function createTray(): void {
  const image = existsSync(trayIconPath) ? nativeImage.createFromPath(trayIconPath) : nativeImage.createEmpty();
  if (image.isEmpty()) throw new Error("Desktop tray icon could not be decoded");
  tray = new Tray(image);
  tray.setToolTip("PatchWarden");
  updateTrayMenu();
  tray.on("double-click", showWindow);
}

async function writeSmokeEvidence(): Promise<void> {
  if (!smokeMode || !mainWindow || !desktopPaths) return;
  const captureScreenshots = process.env.PATCHWARDEN_DESKTOP_SMOKE_CAPTURE !== "0";
  const viewportResults = [];
  const screenshotDir = join(desktopPaths.root, "desktop-smoke-screenshots");
  mkdirSync(screenshotDir, { recursive: true });
  for (const [width, height] of [[1280, 720], [1024, 700], [960, 640]]) {
    mainWindow.setSize(width, height);
    showWindow();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 180));
    const metrics = await mainWindow.webContents.executeJavaScript(`(() => {
      const root = document.documentElement;
      const body = document.body;
      const visible = [...document.querySelectorAll("body *")].filter((node) => {
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      });
      const maxRight = visible.reduce((value, node) => Math.max(value, node.getBoundingClientRect().right), 0);
      return {
        title: document.title,
        readyState: document.readyState,
        innerWidth,
        innerHeight,
        clientWidth: root.clientWidth,
        scrollWidth: root.scrollWidth,
        bodyScrollWidth: body ? body.scrollWidth : 0,
        maxVisibleRight: Math.ceil(maxRight),
      };
    })()`);
    let screenshot = captureScreenshots ? join(screenshotDir, `${width}x${height}.png`) : null;
    let screenshotError: string | null = null;
    if (screenshot) {
      try {
        writeFileSync(screenshot, (await mainWindow.webContents.capturePage()).toPNG());
      } catch (error) {
        screenshot = null;
        screenshotError = error instanceof Error ? error.name : "capture_failed";
      }
    }
    viewportResults.push({ requested: { width, height }, bounds: mainWindow.getBounds(), metrics, screenshot, screenshotError });
  }
  const report = {
    ok: viewportResults.every(({ metrics }) => metrics.scrollWidth <= metrics.clientWidth && metrics.maxVisibleRight <= metrics.clientWidth),
    version: readCoreVersion(),
    packaged: app.isPackaged,
    singleInstanceLock: gotLock,
    mode: appMode,
    visible: mainWindow.isVisible(),
    minimumSize: mainWindow.getMinimumSize(),
    pageUrl: mainWindow.webContents.getURL(),
    viewports: viewportResults,
  };
  const reportPath = join(desktopPaths.root, "desktop-smoke-report.json");
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`[desktop-smoke] report=${reportPath}`);
  const requestedHold = Number(process.env.PATCHWARDEN_DESKTOP_SMOKE_HOLD_MS || 8000);
  const holdMs = Number.isInteger(requestedHold) && requestedHold >= 1000 && requestedHold <= 180000 ? requestedHold : 8000;
  setTimeout(() => {
    quitting = true;
    app.quit();
  }, holdMs);
}

function updateTrayMenu(): void {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: desktopText("show"), click: showWindow },
    { type: "separator" },
    { label: desktopText("start"), click: () => void controlAction("start").catch(showTrayError) },
    { label: desktopText("stop"), click: () => void controlAction("stop").catch(showTrayError) },
    { label: desktopText("restart"), click: () => void controlAction("restart").catch(showTrayError) },
    { label: desktopText("logs"), click: () => void shell.openPath(desktopPaths!.logs) },
    { type: "separator" },
    { label: desktopText("quit"), click: quitDesktop },
    { label: desktopText("stopQuit"), click: () => void stopAllAndQuit() },
  ]));
}

function showTrayError(error: unknown): void {
  if (tray) tray.displayBalloon({ title: "PatchWarden", content: error instanceof Error ? error.message : String(error) });
}

function quitDesktop(): void {
  quitting = true;
  app.quit();
}

async function stopAllAndQuit(): Promise<void> {
  try { await controlAction("stop"); } catch { /* explicit exit still proceeds */ }
  quitDesktop();
}

async function runDoctor(): Promise<{ ok: boolean; counts: { ok: number; warn: number; fail: number }; output: string }> {
  return new Promise((resolvePromise) => {
    const entry = join(coreRoot, "dist", "doctor.js");
    const child = utilityProcess.fork(entry, [], utilityProcessOptions(
      coreRoot,
      { PATCHWARDEN_CONFIG: activeConfigPath || "", PATCHWARDEN_DESKTOP_RUNTIME: "1" },
      "PatchWarden Doctor",
    ));
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(-24000); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8000); });
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, 30000);
    child.on("exit", async (code: number | null) => {
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
        requestBackendRestart(900);
      }
    });
  });
}

function registerDesktopIpc(): void {
  registerIpc("desktop:get-state", async () => currentState());
  registerIpc("desktop:choose-workspace", async () => {
    const result = await dialog.showOpenDialog(mainWindow!, { properties: ["openDirectory"], title: "选择 PatchWarden 工作区" });
    return result.canceled || result.filePaths.length !== 1 ? null : result.filePaths[0];
  });
  registerIpc("desktop:choose-tunnel-client", async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ["openFile"],
      title: "选择 tunnel-client.exe",
      filters: [{ name: "tunnel-client.exe", extensions: ["exe"] }],
    });
    if (result.canceled || result.filePaths.length !== 1) return null;
    const validation = validateTunnelClientPath(result.filePaths[0]);
    return validation.ok ? { ok: true, path: validation.path, source: "用户选择" } : validation;
  });
  registerIpc("desktop:detect-tunnel-client", async () => {
    return detectTunnelClient({ config: tunnelDetectionConfig(readJson(activeConfigPath!)), env: process.env });
  });
  registerIpc("desktop:detect-agents", async () => {
    detectedAgents = await detectAgents();
    return publicAgentCatalog();
  });
  registerIpc("desktop:get-agent-settings", async () => {
    if (detectedAgents.length === 0) detectedAgents = await detectAgents();
    return publicAgentCatalog();
  });
  registerIpc("desktop:discover-agent-models", async (value) => {
    const id = requireAgentId(value);
    return discoverModelsForAgent(id, configuredWorkspaceRoot());
  });
  registerIpc("desktop:refresh-agent-models", async (value) => {
    const id = requireAgentId(value);
    if (detectedAgents.length === 0) detectedAgents = await detectAgents();
    const detection = detectedAgents.find((agent) => agent.id === id);
    const environmentPolicy = configuredAgentEnvironmentPolicy(id);
    return {
      agentId: id,
      models: await refreshAgentModels(id, detection, {
        cwd: coreRoot,
        envAllowlist: environmentPolicy.allowedNames,
        blockedEnvNames: environmentPolicy.blockedNames,
      }),
    };
  });
  registerIpc("desktop:save-setup", async (value) => {
    const input = asRecord(value);
    if (typeof input.workspaceRoot !== "string" || !Array.isArray(input.enabledAgents)) {
      return { ok: false, error: "配置数据无效" };
    }
    if (input.enabledAgents.some((name) => typeof name !== "string")) {
      return { ok: false, error: "配置数据无效" };
    }
    const validation = await validateWorkspace(input.workspaceRoot);
    if (!validation.ok) return { ok: false, error: validation.reason, validation };
    const enabledNames = new Set(input.enabledAgents.filter((name): name is string => typeof name === "string" && Boolean(getAgentAdapter(name))));
    const agentModels = asRecord(input.agentModels);
    const selections = [...enabledNames].map((id) => ({
      id,
      enabled: true,
      model: typeof agentModels[id] === "string" ? agentModels[id] : null,
    }));
    const selected = detectedAgents.filter((agent) => enabledNames.has(agent.id) && agent.available);
    const generated = buildConfig(validation.path!, selected, selections);
    const existing = asRecord(readJson(activeConfigPath!));
    const existingAgents = asRecord(existing.agents);
    if (Object.keys(existingAgents).length > 0) {
      const customAgents: Record<string, AgentRegistration> = {};
      for (const [id, registration] of Object.entries(existingAgents)) {
        if (!isAgentRegistration(registration)) continue;
        if (!getAgentAdapter(registration.adapter || id)) customAgents[id] = registration;
      }
      const managedAgents: Record<string, AgentRegistration> = {};
      for (const [id, registration] of Object.entries(generated.agents || {})) {
        const envAllowlist = asRecord(existingAgents[id]).envAllowlist;
        managedAgents[id] = {
          ...registration,
          ...(Array.isArray(envAllowlist) && envAllowlist.every((name) => typeof name === "string")
            ? { envAllowlist: [...envAllowlist] as string[] }
            : {}),
        };
      }
      generated.agents = { ...customAgents, ...managedAgents };
    }
    const nextConfig = typeof existing.workspaceRoot === "string"
      ? { ...existing, ...generated, workspaceRoot: validation.path, agents: generated.agents }
      : generated;
    atomicWriteJson(activeConfigPath!, nextConfig, true);
    if (appMode === "ready") {
      requestBackendRestart(300);
    } else {
      appMode = "setup-check";
    }
    return { ok: true, workspaceRoot: validation.path, agentCount: selected.length };
  });
  registerIpc("desktop:save-agent-settings", async (value) => {
    const selections = parseAgentSelections(asRecord(value).agents);
    if (detectedAgents.length === 0) detectedAgents = await detectAgents();
    const settings = updateAgentSettings(activeConfigPath!, detectedAgents as readonly AgentDetectionInput[], selections);
    const restartRequired = !ownedBackend;
    if (ownedBackend) requestBackendRestart(250);
    return { ok: true, settings, restartRequired };
  });
  registerIpc("desktop:run-doctor", runDoctor);
  registerIpc("desktop:get-preferences", async () => preferences);
  registerIpc("desktop:set-preferences", async (value) => {
    preferences = updatePreferences(desktopPaths!.preferences, value);
    applyTheme(preferences.theme);
    mainWindow?.setTitle(desktopText("window"));
    updateTrayMenu();
    return preferences;
  });
  registerIpc("desktop:get-runtime-settings", async () => readRuntimeSettings(activeConfigPath!));
  registerIpc("desktop:set-runtime-settings", async (value) => {
    if (!isRecord(value)) throw new Error("运行设置数据无效");
    if (value.tunnelClientPath) {
      const validation = validateTunnelClientPath(value.tunnelClientPath);
      if (!validation.ok) throw new Error(validation.error);
    }
    const settings = updateRuntimeSettings(activeConfigPath!, value);
    const restartRequired = !ownedBackend;
    if (ownedBackend) requestBackendRestart(250);
    return { ok: true, settings, restartRequired };
  });
  registerIpc("desktop:get-tunnel-setup-status", async (value) => getTunnelSetupStatus({
    mode: requireTunnelMode(value),
    configPath: activeConfigPath!,
    statusPath: desktopPaths!.tunnelSetupStatus,
    credentialPath: desktopPaths!.credential,
  }));
  registerIpc("desktop:provision-tunnel-profile", async (value) => {
    if (!isRecord(value)) return { ok: false, reason_code: "invalid_request" };
    const mode = requireTunnelMode(value.mode);
    let runtimeKey = typeof value.runtimeKey === "string" ? value.runtimeKey : "";
    try {
      return await provisionTunnelProfile({
        mode,
        tunnelId: typeof value.tunnelId === "string" ? value.tunnelId : undefined,
        runtimeKey,
        configPath: activeConfigPath!,
        statusPath: desktopPaths!.tunnelSetupStatus,
        credentialPath: desktopPaths!.credential,
        projectRoot: coreRoot,
      });
    } finally {
      runtimeKey = "";
      try { value.runtimeKey = ""; } catch { /* IPC clone may be immutable */ }
    }
  });
  registerIpc("desktop:revalidate-tunnel-profile", async (value) => revalidateTunnelProfile({
    mode: requireTunnelMode(value),
    configPath: activeConfigPath!,
    statusPath: desktopPaths!.tunnelSetupStatus,
    credentialPath: desktopPaths!.credential,
    projectRoot: coreRoot,
  }));
  registerIpc("desktop:forget-tunnel-credential", async () => forgetTunnelCredential(desktopPaths!.credential));
  registerIpc("desktop:open-path", async (kind) => {
    const target = kind === "logs" ? desktopPaths!.logs : kind === "config" ? activeConfigPath! : null;
    if (!target) throw new Error("Unsupported desktop path");
    return shell.openPath(target);
  });
}

async function bootstrap(): Promise<void> {
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
  await writeSmokeEvidence();
}

if (gotLock) {
  void bootstrap().catch((error: unknown) => {
    writeAppLog("Desktop bootstrap failed.", error);
    dialog.showErrorBox("PatchWarden Desktop", `桌面应用启动失败。请查看 desktop.log。\n\n${error instanceof Error ? error.message : String(error)}`);
    quitting = true;
    app.quit();
  });
}
