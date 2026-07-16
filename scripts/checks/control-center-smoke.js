#!/usr/bin/env node
/**
 * PatchWarden Control Center — smoke test (test mode).
 *
 * Strict invariants:
 *   - Does NOT open a browser.
 *   - Does NOT call manage-patchwarden.ps1 for real start/stop operations.
 *   - Does NOT kill any process other than the controlCenter child it spawned.
 *   - Uses test port 18090 via PATCHWARDEN_CONTROL_PORT.
 *   - Always shuts down the spawned server (even on failure).
 *
 * Run: node scripts/checks/control-center-smoke.js
 */

import { spawn, execSync } from "node:child_process";
import http from "node:http";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..", "..");
const serverPath = join(projectRoot, "dist", "controlCenter.js");
const uiRoot = join(projectRoot, "ui");
const trayScriptPath = join(projectRoot, "scripts", "control", "control-center-tray.ps1");

const TEST_PORT = 18090;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
// Redirect control-center status/events/log files into a project-local temp
// dir so the smoke test can write them even when LOCALAPPDATA is restricted
// by the dev sandbox. Cleaned up on exit.
const TEST_LOG_DIR = join(projectRoot, ".tmp", "control-center-smoke");
try { mkdirSync(TEST_LOG_DIR, { recursive: true }); } catch { /* ignore */ }
const READY_TIMEOUT_MS = 15_000;
const READY_POLL_MS = 500;
const REQUEST_TIMEOUT_MS = 5000;

let child = null;
let childExitedEarly = false;
let childExitInfo = null;
let childStderr = "";
let childStdout = "";

const results = [];
let passed = 0;
let failed = 0;

function record(name, ok, detail) {
  const tag = ok ? "[PASS]" : "[FAIL]";
  results.push({ name, ok, detail });
  if (ok) {
    passed++;
    console.log(`${tag} ${name}`);
  } else {
    failed++;
    console.log(`${tag} ${name}`);
    if (detail) {
      console.log(`        ${detail}`);
    }
  }
}

function cleanup() {
  if (child && !child.killed && child.exitCode === null && child.signalCode === null) {
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      if (child && child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }
    }, 2000);
  }
  // Best-effort cleanup of the project-local test log dir.
  try {
    if (existsSync(TEST_LOG_DIR)) rmSync(TEST_LOG_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function waitForChildExit(timeoutMs = 5000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      if (child && child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }
      finish();
    }, timeoutMs);
    child.once("exit", finish);
  });
}

process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});
process.on("SIGTERM", () => {
  cleanup();
  process.exit(143);
});

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on("error", reject);
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error("timeout")));
  });
}

function httpPost(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: "POST",
        headers,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      }
    );
    req.on("error", reject);
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error("timeout")));
    req.end();
  });
}

async function waitForServer() {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastErr = null;
  while (Date.now() < deadline) {
    if (childExitedEarly) {
      throw new Error(
        `controlCenter exited before ready${childExitInfo ? ` (code=${childExitInfo.code}, signal=${childExitInfo.signal})` : ""}\nstderr:\n${childStderr}`
      );
    }
    try {
      const res = await httpGet(`${BASE_URL}/api/status`);
      if (res && typeof res.status === "number") {
        return true;
      }
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, READY_POLL_MS));
  }
  throw new Error(
    `controlCenter not ready within ${READY_TIMEOUT_MS}ms (last error: ${lastErr ? lastErr.message : "n/a"})\nstderr:\n${childStderr}`
  );
}

function tryJson(body) {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function readHtmlFiles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!e.name.toLowerCase().endsWith(".html")) continue;
    const full = join(dir, e.name);
    try {
      out.push({ path: full, content: readFileSync(full, "utf-8") });
    } catch {
      /* ignore unreadable */
    }
  }
  return out;
}

// ── Test 1: Static file serving ─────────────────────────────────
async function testStaticFiles() {
  const name = "Test 1: static file serving";
  try {
    const root = await httpGet(`${BASE_URL}/`);
    const vendor = await httpGet(`${BASE_URL}/vendor/tailwindcss-browser.js`);
    const css = await httpGet(`${BASE_URL}/colors_and_type.css`);
    const desktopCss = await httpGet(`${BASE_URL}/desktop.css`);
    const desktopBridge = await httpGet(`${BASE_URL}/desktop-bridge.js`);
    const i18n = await httpGet(`${BASE_URL}/i18n.js`);
    const gettingStarted = await httpGet(`${BASE_URL}/pages/getting-started.html`);
    const gettingStartedJs = await httpGet(`${BASE_URL}/getting-started.js`);
    const settings = await httpGet(`${BASE_URL}/pages/settings.html`);
    const favicon = await httpGet(`${BASE_URL}/favicon.ico`);

    const checks = [];
    if (root.status !== 200) checks.push(`GET / -> status ${root.status} (expected 200)`);
    const rootCt = root.headers["content-type"] || "";
    if (!rootCt.includes("text/html")) checks.push(`GET / -> Content-Type ${rootCt} (expected text/html)`);
    if (!root.body.includes("setup-checklist-card")) checks.push("dashboard missing setup checklist card");
    if (!root.body.includes("查看 Core / Direct 本次日志尾部")) checks.push("dashboard activity log is not collapsed behind a summary");
    if (!root.body.includes("pw-dashboard-toolbar")) checks.push("dashboard missing stable desktop toolbar layout");
    if (!root.body.includes("evidence-pack-card")) checks.push("dashboard missing v1.5 evidence pack card");

    if (vendor.status !== 200) checks.push(`GET /vendor/tailwindcss-browser.js -> status ${vendor.status}`);
    const vendorCt = vendor.headers["content-type"] || "";
    if (!vendorCt.includes("javascript")) checks.push(`GET /vendor/tailwindcss-browser.js -> Content-Type ${vendorCt}`);

    if (css.status !== 200) checks.push(`GET /colors_and_type.css -> status ${css.status}`);
    const cssCt = css.headers["content-type"] || "";
    if (!cssCt.includes("text/css")) checks.push(`GET /colors_and_type.css -> Content-Type ${cssCt}`);

    if (desktopCss.status !== 200 || !(desktopCss.headers["content-type"] || "").includes("text/css")) {
      checks.push("desktop refinement stylesheet is not served as CSS");
    }
    if (desktopBridge.status !== 200 || !(desktopBridge.headers["content-type"] || "").includes("javascript")) {
      checks.push("desktop bridge is not served as JavaScript");
    }
    if (i18n.status !== 200 || !i18n.body.includes("applyTranslations") || !i18n.body.includes('"zh-CN"') || !i18n.body.includes("en:")) {
      checks.push("shared Chinese/English translation dictionary is unavailable");
    }
    if (gettingStarted.status !== 200 || (gettingStarted.body.match(/class="readiness-item"/g) || []).length !== 4 || !gettingStarted.body.includes("home.manual")) {
      checks.push("desktop getting-started page is missing its four readiness checks or manual ChatGPT state");
    }
    if (gettingStartedJs.status !== 200 || !gettingStartedJs.body.includes("getTunnelSetupStatus") || !gettingStartedJs.body.includes("health_check")) {
      checks.push("getting-started controller is missing bounded Tunnel status or health_check guidance");
    }
    if (settings.status !== 200 || !settings.body.includes("/settings.js")) {
      checks.push("desktop settings page is unavailable or missing its bounded bridge");
    }
    for (const marker of ["detectTunnel", "chooseTunnel", "enableDirectProfile", "proxyScope", "saveRuntime", "tunnelId", "runtimeKey", "provisionTunnel", "forgetCredential", "language"]) {
      if (!settings.body.includes(marker)) checks.push(`desktop settings missing runtime control: ${marker}`);
    }
    if (!desktopBridge.body.includes("patchwardenApplyTheme") || !desktopBridge.body.includes("请求超过 10 秒")) {
      checks.push("desktop bridge is missing renderer theme propagation or bounded loading timeout");
    }

    if (favicon.status !== 200) checks.push(`GET /favicon.ico -> status ${favicon.status}`);
    const faviconCt = favicon.headers["content-type"] || "";
    if (!faviconCt.includes("image/svg+xml")) checks.push(`GET /favicon.ico -> Content-Type ${faviconCt}`);

    if (checks.length === 0) {
      record(name, true);
    } else {
      record(name, false, checks.join("; "));
    }
  } catch (err) {
    record(name, false, `error: ${err.message}`);
  }
}

// ── Test 2: /api/status returns valid JSON with required fields ─
async function testPageNavigationRoutes() {
  const name = "Test 1b: page navigation routes and sidebar hrefs work";
  const problems = [];
  const routes = [
    "/dashboard.html",
    "/tasks.html",
    "/workspace.html",
    "/audit.html",
    "/task-detail.html?id=smoke",
    "/pages/dashboard.html",
    "/pages/tasks.html",
    "/pages/workspace.html",
    "/pages/audit.html",
    "/pages/task-detail.html?id=smoke",
    "/settings.html",
    "/pages/settings.html",
    "/pages/getting-started.html",
  ];

  for (const route of routes) {
    try {
      const res = await httpGet(`${BASE_URL}${route}`);
      const contentType = res.headers["content-type"] || "";
      if (res.status !== 200) {
        problems.push(`GET ${route} -> status ${res.status} (expected 200)`);
      } else if (!contentType.includes("text/html")) {
        problems.push(`GET ${route} -> Content-Type ${contentType} (expected text/html)`);
      } else if (!res.body.includes("PatchWarden")) {
        problems.push(`GET ${route} returned HTML without PatchWarden page identity`);
      }
    } catch (err) {
      problems.push(`GET ${route} error: ${err.message}`);
    }
  }

  const htmlFiles = [
    ...readHtmlFiles(join(uiRoot, "pages")),
    ...readHtmlFiles(join(uiRoot, "partials")),
  ];
  for (const f of htmlFiles) {
    if (/href="#"\s+data-nav-key=/.test(f.content)) {
      problems.push(`sidebar nav placeholder href remains in ${f.path}`);
    }
    if (/href="(?:dashboard|tasks|workspace|audit|task-detail)\.html/.test(f.content)) {
      problems.push(`relative page href remains in ${f.path}`);
    }
    if (/(?:href|detailHref|const href|var detailHref)\s*=\s*['"](?:dashboard|tasks|workspace|audit|task-detail)\.html/.test(f.content)) {
      problems.push(`relative script page target remains in ${f.path}`);
    }
  }

  if (problems.length === 0) {
    record(name, true);
  } else {
    record(name, false, problems.join("; "));
  }
}

async function testStatusJson() {
  const name = "Test 2: /api/status returns valid JSON and is fault-tolerant";
  try {
    const res = await httpGet(`${BASE_URL}/api/status`);
    if (res.status !== 200) {
      record(name, false, `status ${res.status} (expected 200)`);
      return;
    }
    const json = tryJson(res.body);
    if (!json || !isObject(json)) {
      record(name, false, `body is not a JSON object: ${res.body.slice(0, 200)}`);
      return;
    }
    const problems = [];

    if (!isObject(json.core)) problems.push("missing/invalid 'core' object");
    else if (typeof json.core.available !== "boolean") problems.push("'core.available' not boolean");

    if (!isObject(json.direct)) problems.push("missing/invalid 'direct' object");
    else if (typeof json.direct.available !== "boolean") problems.push("'direct.available' not boolean");

    if (!isObject(json.watcher)) problems.push("missing/invalid 'watcher' object");
    else if (typeof json.watcher.status !== "string") problems.push("'watcher.status' not string");

    if (!isObject(json.setup)) problems.push("missing/invalid 'setup' object");
    else {
      if (!isObject(json.setup.tunnel_client)) problems.push("'setup.tunnel_client' not object");
      else if (typeof json.setup.tunnel_client.available !== "boolean") problems.push("'setup.tunnel_client.available' not boolean");
      if (!isObject(json.setup.watcher)) problems.push("'setup.watcher' not object");
      if (typeof json.setup.workspace_root !== "string" && json.setup.workspace_root !== null) {
        problems.push("'setup.workspace_root' is neither string nor null");
      }
    }

    if (!isObject(json.tunnel)) problems.push("missing/invalid 'tunnel' object");
    else {
      if (!isObject(json.tunnel.core)) problems.push("'tunnel.core' not object");
      if (!isObject(json.tunnel.direct)) problems.push("'tunnel.direct' not object");
    }

    if (!isObject(json.tools)) problems.push("missing/invalid 'tools' object");
    else {
      if (!isObject(json.tools.core)) problems.push("'tools.core' not object");
      if (!isObject(json.tools.direct)) problems.push("'tools.direct' not object");
    }

    if (!Array.isArray(json.agents)) problems.push("'agents' is not an array");

    if (typeof json.workspace_root !== "string" && json.workspace_root !== null) {
      problems.push("'workspace_root' is neither string nor null");
    }

    if (!isObject(json.tasks)) problems.push("missing/invalid 'tasks' object");
    else {
      if (!Array.isArray(json.tasks.tasks)) problems.push("'tasks.tasks' is not an array");
      if (typeof json.tasks.total !== "number") problems.push("'tasks.total' is not a number");
      if (typeof json.tasks.active !== "number") problems.push("'tasks.active' is not a number");
      if (typeof json.tasks.stale !== "number") problems.push("'tasks.stale' is not a number");
    }

    // Fault-tolerance: when Core/Direct are not started (probes point at dead
    // ports in test mode), available should be false and a reason must be present.
    // We verify the structure rather than hard-asserting false, so the test stays
    // robust even if a stray service happens to answer on the probe port.
    for (const key of ["core", "direct"]) {
      if (json[key].available === false) {
        if (typeof json[key].reason !== "string" || json[key].reason.length === 0) {
          problems.push(`fault-tolerance: ${key}.available===false but reason is missing`);
        }
      } else if (json[key].available !== true && typeof json[key].available !== "boolean") {
        problems.push(`fault-tolerance: ${key}.available is not a boolean`);
      }
    }

    if (problems.length === 0) {
      record(name, true);
    } else {
      record(name, false, problems.join("; "));
    }
  } catch (err) {
    record(name, false, `error: ${err.message}`);
  }
}

// ── Test 3: /api/tasks returns valid JSON ───────────────────────
async function testTasksJson() {
  const name = "Test 3: /api/tasks returns valid JSON";
  try {
    const res = await httpGet(`${BASE_URL}/api/tasks`);
    if (res.status !== 200) {
      record(name, false, `status ${res.status} (expected 200)`);
      return;
    }
    const json = tryJson(res.body);
    if (!json || !isObject(json)) {
      record(name, false, `body is not a JSON object: ${res.body.slice(0, 200)}`);
      return;
    }
    const problems = [];
    if (!Array.isArray(json.tasks)) problems.push("'tasks' is not an array");
    if (typeof json.total !== "number") problems.push("'total' is not a number");
    if (typeof json.returned !== "number") problems.push("'returned' is not a number");

    if (problems.length === 0) {
      record(name, true);
    } else {
      record(name, false, problems.join("; "));
    }
  } catch (err) {
    record(name, false, `error: ${err.message}`);
  }
}

// ── Test 4: /control-token.json returns token + Cache-Control ──
async function testControlToken() {
  const name = "Test 4: /control-token.json returns token with no-store";
  try {
    const res = await httpGet(`${BASE_URL}/control-token.json`);
    if (res.status !== 200) {
      record(name, false, `status ${res.status} (expected 200)`);
      return null;
    }
    const json = tryJson(res.body);
    if (!json || typeof json.token !== "string" || json.token.length === 0) {
      record(name, false, `token missing or empty: ${res.body.slice(0, 200)}`);
      return null;
    }
    const cc = res.headers["cache-control"] || "";
    if (!cc.includes("no-store")) {
      record(name, false, `Cache-Control header missing no-store: ${cc}`);
      return null;
    }
    record(name, true);
    return json.token;
  } catch (err) {
    record(name, false, `error: ${err.message}`);
    return null;
  }
}

// ── Test 5: POST /api/start-all without token -> 403 ────────────
async function testStartAllNoToken() {
  const name = "Test 5: POST /api/start-all without token -> 403";
  try {
    const res = await httpPost(`${BASE_URL}/api/start-all`, {});
    const ok = res.status === 403;
    let detail = null;
    if (!ok) detail = `status ${res.status} (expected 403)`;
    else {
      const json = tryJson(res.body);
      if (!json || typeof json.error !== "string") {
        detail = `response body missing 'error' field: ${res.body.slice(0, 200)}`;
        record(name, false, detail);
        return;
      }
    }
    record(name, ok, detail);
  } catch (err) {
    record(name, false, `error: ${err.message}`);
  }
}

// ── Test 6: POST /api/start-all with wrong token -> 403 ─────────
async function testStartAllWrongToken() {
  const name = "Test 6: POST /api/start-all with wrong token -> 403";
  try {
    const res = await httpPost(`${BASE_URL}/api/start-all`, {
      "X-PatchWarden-Control-Token": "wrong-token",
    });
    const ok = res.status === 403;
    record(name, ok, ok ? null : `status ${res.status} (expected 403)`);
  } catch (err) {
    record(name, false, `error: ${err.message}`);
  }
}

async function testStartAllPreflightMissingTunnelClient(token) {
  const name = "Test 6b: POST /api/start-all with token preflights missing tunnel-client";
  try {
    const res = await httpPost(`${BASE_URL}/api/start-all`, {
      "X-PatchWarden-Control-Token": token,
    });
    const json = tryJson(res.body);
    if (res.status !== 409) {
      record(name, false, `status ${res.status} (expected 409) body=${res.body.slice(0, 200)}`);
      return;
    }
    if (!isObject(json)) {
      record(name, false, `body is not JSON object: ${res.body.slice(0, 200)}`);
      return;
    }
    const missing = Array.isArray(json.missing) ? json.missing : [];
    if (json.ok !== false || !String(json.error || "").includes("preflight") || !missing.includes("tunnel-client.exe")) {
      record(name, false, `unexpected preflight response: ${res.body.slice(0, 300)}`);
      return;
    }
    record(name, true);
  } catch (err) {
    record(name, false, `error: ${err.message}`);
  }
}

// ── Test 7: POST /api/open-logs-folder without token -> 403 ─────
async function testOpenLogsFolderNoToken() {
  const name = "Test 7: POST /api/open-logs-folder without token -> 403";
  try {
    const res = await httpPost(`${BASE_URL}/api/open-logs-folder`, {});
    const ok = res.status === 403;
    let detail = null;
    if (!ok) {
      detail = `status ${res.status} (expected 403; 403 means the folder-open action was NOT executed)`;
    } else {
      const json = tryJson(res.body);
      if (!json || typeof json.error !== "string") {
        detail = `response body missing 'error' field: ${res.body.slice(0, 200)}`;
        record(name, false, detail);
        return;
      }
    }
    record(name, ok, detail);
  } catch (err) {
    record(name, false, `error: ${err.message}`);
  }
}

// ── Test 8: Token does not pollute git ──────────────────────────
function testTokenNotInGit() {
  const name = "Test 8: token does not pollute git (ui/control-token.json absent)";
  let output;
  try {
    output = execSync("git status --porcelain", {
      cwd: projectRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    record(name, true, `SKIP — git not available or not a repo (${err.message.split("\n")[0]})`);
    return;
  }
  if (output.includes("ui/control-token.json")) {
    record(name, false, `git status contains ui/control-token.json:\n${output}`);
  } else {
    record(name, true);
  }
}

// ── Test 9: No CDN requests in UI HTML files ────────────────────
function testNoCdn() {
  const name = "Test 9: no CDN references (https://cdn or https://unpkg) in UI HTML";
  const files = [];
  for (const f of readHtmlFiles(join(uiRoot, "pages"))) files.push(f);
  for (const f of readHtmlFiles(join(uiRoot, "partials"))) files.push(f);

  if (files.length === 0) {
    record(name, false, "no HTML files found under ui/pages or ui/partials");
    return;
  }
  const offenders = [];
  for (const f of files) {
    if (f.content.includes("https://cdn") || f.content.includes("https://unpkg")) {
      offenders.push(f.path);
    }
  }
  if (offenders.length === 0) {
    record(name, true);
  } else {
    record(name, false, `CDN references found in: ${offenders.join(", ")}`);
  }
}

// ── Test 10: Other GET APIs are reachable ───────────────────────
function testTrayMenuContract() {
  const name = "Test 9b: tray menu stays a lightweight quick-control surface";
  let body = "";
  try {
    body = readFileSync(trayScriptPath, "utf-8");
  } catch (err) {
    record(name, false, `could not read tray script: ${err.message}`);
    return;
  }

  const requiredLabels = [
    "Open Dashboard",
    "Status",
    "Start All",
    "Stop All",
    "Restart All",
    "Open Logs",
    "Quit Tray",
  ];
  const forbiddenLabels = [
    "Open Workspace",
    "Open Logs Folder",
    "Open Control Center",
    "Direct Sessions",
    "Audit",
    "Tasks",
  ];

  const problems = [];
  for (const label of requiredLabels) {
    if (!body.includes(`Items.Add("${label}"`)) {
      problems.push(`missing tray label: ${label}`);
    }
  }
  for (const label of forbiddenLabels) {
    if (body.includes(`Items.Add("${label}"`)) {
      problems.push(`tray should not expose complex/old label: ${label}`);
    }
  }
  if (!body.includes("Open Dashboard for tasks, audit logs, Direct sessions, and setup details.")) {
    problems.push("Status message should direct complex management to the dashboard");
  }
  for (const marker of ["New-PatchWardenTrayIcon", "MutexName", "Invoke-TrayControlAction", "PatchWarden: local control"]) {
    if (!body.includes(marker)) problems.push(`tray missing desktop UX marker: ${marker}`);
  }
  if (!body.includes("Tray and dashboard stay available")) {
    problems.push("Stop All should be described as stopping Core/Direct while tray/dashboard remain available");
  }

  if (problems.length === 0) {
    record(name, true);
  } else {
    record(name, false, problems.join("; "));
  }
}

async function testOtherGetApis() {
  const name = "Test 10: other GET APIs are reachable with expected fields";
  const problems = [];

  // /api/workspace
  try {
    const res = await httpGet(`${BASE_URL}/api/workspace`);
    if (res.status !== 200) problems.push(`/api/workspace -> ${res.status} (expected 200)`);
    else {
      const json = tryJson(res.body);
      if (!json || !("workspace_root" in json)) {
        problems.push(`/api/workspace missing 'workspace_root': ${res.body.slice(0, 120)}`);
      }
    }
  } catch (err) {
    problems.push(`/api/workspace error: ${err.message}`);
  }

  // /api/audit
  try {
    const res = await httpGet(`${BASE_URL}/api/audit`);
    if (res.status !== 200) problems.push(`/api/audit -> ${res.status} (expected 200)`);
    else {
      const json = tryJson(res.body);
      if (!json || !Array.isArray(json.audits)) {
        problems.push(`/api/audit missing 'audits' array: ${res.body.slice(0, 120)}`);
      }
    }
  } catch (err) {
    problems.push(`/api/audit error: ${err.message}`);
  }

  // /api/lineages
  try {
    const res = await httpGet(`${BASE_URL}/api/lineages`);
    if (res.status !== 200) problems.push(`/api/lineages -> ${res.status} (expected 200)`);
    else {
      const json = tryJson(res.body);
      if (!json || !Array.isArray(json.lineages) || typeof json.total !== "number") {
        problems.push(`/api/lineages missing bounded lineage summary fields: ${res.body.slice(0, 120)}`);
      }
    }
  } catch (err) {
    problems.push(`/api/lineages error: ${err.message}`);
  }

  // /api/project-policy
  try {
    const res = await httpGet(`${BASE_URL}/api/project-policy?repo_path=.`);
    if (res.status !== 200) problems.push(`/api/project-policy -> ${res.status} (expected 200)`);
    else {
      const json = tryJson(res.body);
      if (!json || !("effective_policy" in json) || !Array.isArray(json.issues)) {
        problems.push(`/api/project-policy missing policy summary fields: ${res.body.slice(0, 120)}`);
      }
      const text = res.body.toLowerCase();
      if (text.includes("stdout") || text.includes("stderr") || text.includes("diff_patch")) {
        problems.push("/api/project-policy leaked log/diff-shaped fields");
      }
    }
  } catch (err) {
    problems.push(`/api/project-policy error: ${err.message}`);
  }

  // /api/release/status
  try {
    const res = await httpGet(`${BASE_URL}/api/release/status?repo_path=.`);
    if (res.status !== 200) problems.push(`/api/release/status -> ${res.status} (expected 200)`);
    else {
      const json = tryJson(res.body);
      if (!json || !("release_readiness" in json) || json.remote_write_performed !== false) {
        problems.push(`/api/release/status missing read-only release status fields: ${res.body.slice(0, 120)}`);
      }
      const text = res.body.toLowerCase();
      if (text.includes("stdout") || text.includes("stderr") || text.includes("diff_patch")) {
        problems.push("/api/release/status leaked log/diff-shaped fields");
      }
    }
  } catch (err) {
    problems.push(`/api/release/status error: ${err.message}`);
  }

  // /api/evidence-packs
  try {
    const res = await httpGet(`${BASE_URL}/api/evidence-packs`);
    if (res.status !== 200) problems.push(`/api/evidence-packs -> ${res.status} (expected 200)`);
    else {
      const json = tryJson(res.body);
      if (!json || !Array.isArray(json.evidence_packs) || typeof json.total !== "number") {
        problems.push(`/api/evidence-packs missing bounded evidence summary fields: ${res.body.slice(0, 120)}`);
      }
      const text = res.body.toLowerCase();
      if (text.includes("stdout_tail") || text.includes("stderr_tail") || text.includes("diff.patch") || text.includes("verification.log")) {
        problems.push("/api/evidence-packs leaked log/diff-shaped fields");
      }
    }
  } catch (err) {
    problems.push(`/api/evidence-packs error: ${err.message}`);
  }

  // /api/direct-sessions/:id/summary (safe, bounded route; missing id is still non-leaky)
  try {
    const res = await httpGet(`${BASE_URL}/api/direct-sessions/direct_missing_summary/summary`);
    if (res.status !== 200) problems.push(`/api/direct-sessions/:id/summary -> ${res.status} (expected 200)`);
    else {
      const json = tryJson(res.body);
      if (!json || json.session_id !== "direct_missing_summary") {
        problems.push(`/api/direct-sessions/:id/summary missing safe summary envelope: ${res.body.slice(0, 120)}`);
      }
      const text = res.body.toLowerCase();
      if (text.includes("stdout_tail") || text.includes("stderr_tail") || text.includes("diff_patch") || text.includes("verification.log")) {
        problems.push("/api/direct-sessions/:id/summary leaked log/diff-shaped fields");
      }
    }
  } catch (err) {
    problems.push(`/api/direct-sessions/:id/summary error: ${err.message}`);
  }

  // /api/logs/core
  try {
    const res = await httpGet(`${BASE_URL}/api/logs/core`);
    if (res.status !== 200) problems.push(`/api/logs/core -> ${res.status} (expected 200)`);
    else {
      const json = tryJson(res.body);
      if (!json || typeof json.stdout !== "string" || typeof json.stderr !== "string") {
        problems.push(`/api/logs/core missing 'stdout'/'stderr' strings: ${res.body.slice(0, 120)}`);
      }
    }
  } catch (err) {
    problems.push(`/api/logs/core error: ${err.message}`);
  }

  // /api/tunnel-ui-url
  try {
    const res = await httpGet(`${BASE_URL}/api/tunnel-ui-url`);
    if (res.status !== 200) problems.push(`/api/tunnel-ui-url -> ${res.status} (expected 200)`);
    else {
      const json = tryJson(res.body);
      if (!json || !isObject(json.core) || !isObject(json.direct)) {
        problems.push(`/api/tunnel-ui-url missing 'core'/'direct' objects: ${res.body.slice(0, 120)}`);
      }
    }
  } catch (err) {
    problems.push(`/api/tunnel-ui-url error: ${err.message}`);
  }

  if (problems.length === 0) {
    record(name, true);
  } else {
    record(name, false, problems.join("; "));
  }
}

// ── Test 11: GET /api/tasks/stale returns valid JSON ────────────
async function testStaleTasksApi() {
  const name = "Test 11: /api/tasks/stale returns valid JSON";
  try {
    const res = await httpGet(`${BASE_URL}/api/tasks/stale`);
    if (res.status !== 200) {
      record(name, false, `status ${res.status} (expected 200)`);
      return;
    }
    const json = tryJson(res.body);
    if (!json || !isObject(json)) {
      record(name, false, `body is not a JSON object: ${res.body.slice(0, 200)}`);
      return;
    }
    const problems = [];
    if (!Array.isArray(json.stale_tasks)) problems.push("'stale_tasks' is not an array");
    if (typeof json.total !== "number") problems.push("'total' is not a number");
    if (typeof json.stale_threshold_seconds !== "number") problems.push("'stale_threshold_seconds' is not a number");
    // watcher must be present (object or null); reason must be null or string
    if (json.watcher !== null && !isObject(json.watcher)) problems.push("'watcher' is neither object nor null");
    if (json.reason !== null && typeof json.reason !== "string") problems.push("'reason' is neither null nor string");

    if (problems.length === 0) {
      record(name, true);
    } else {
      record(name, false, problems.join("; "));
    }
  } catch (err) {
    record(name, false, `error: ${err.message}`);
  }
}

// ── Test 12: GET /api/workspace/<traversal>/status -> 400 ───────
async function testWorkspaceRepoPathTraversal() {
  const name = "Test 12: /api/workspace/<traversal>/status rejected with 400";
  // Use percent-encoded dots to bypass URL-parser segment normalization;
  // after decode the repoParam is "../secret" which contains ".." and is
  // rejected by the server's traversal guard.
  const traversalUrl = `${BASE_URL}/api/workspace/${encodeURIComponent("../secret")}/status`;
  try {
    const res = await httpGet(traversalUrl);
    if (res.status === 400) {
      const json = tryJson(res.body);
      if (json && typeof json.error === "string" && /traversal/i.test(json.error)) {
        record(name, true);
      } else {
        record(name, false, `status 400 but error field missing/invalid: ${res.body.slice(0, 200)}`);
      }
    } else {
      record(name, false, `status ${res.status} (expected 400; traversal must be rejected before git runs)`);
    }
  } catch (err) {
    record(name, false, `error: ${err.message}`);
  }
}

// ── Test 13: POST /api/tasks/:taskId/reconcile without token -> 403
async function testReconcileNoToken() {
  const name = "Test 13: POST /api/tasks/:taskId/reconcile without token -> 403";
  try {
    const res = await httpPost(`${BASE_URL}/api/tasks/smoke-fake-task/reconcile`, {});
    if (res.status !== 403) {
      record(name, false, `status ${res.status} (expected 403 — token gate must fire before reconcile runs)`);
      return;
    }
    const json = tryJson(res.body);
    if (!json || typeof json.error !== "string") {
      record(name, false, `response body missing 'error' field: ${res.body.slice(0, 200)}`);
      return;
    }
    record(name, true);
  } catch (err) {
    record(name, false, `error: ${err.message}`);
  }
}

// ── Test 14: GET /api/direct-sessions returns empty list (not 500)
async function testDirectSessionsEmptyList() {
  const name = "Test 14: /api/direct-sessions returns empty list (not 500) when dir missing";
  try {
    const res = await httpGet(`${BASE_URL}/api/direct-sessions`);
    if (res.status !== 200) {
      record(name, false, `status ${res.status} (expected 200 — missing dir must NOT yield 500)`);
      return;
    }
    const json = tryJson(res.body);
    if (!json || !isObject(json)) {
      record(name, false, `body is not a JSON object: ${res.body.slice(0, 200)}`);
      return;
    }
    const problems = [];
    if (!Array.isArray(json.sessions)) problems.push("'sessions' is not an array");
    if (typeof json.total !== "number") problems.push("'total' is not a number");
    if (json.reason !== null && typeof json.reason !== "string") problems.push("'reason' is neither null nor string");
    if (Array.isArray(json.sessions) && json.sessions.length !== json.total) {
      problems.push(`sessions.length (${json.sessions.length}) != total (${json.total})`);
    }
    if (problems.length === 0) {
      record(name, true);
    } else {
      record(name, false, problems.join("; "));
    }
  } catch (err) {
    record(name, false, `error: ${err.message}`);
  }
}

// ── Test 15: /api/logs/core?tail=<n> honors tail parameter ──────
async function testLogsTailParam() {
  const name = "Test 15: /api/logs/core?tail=300 returns tail=300 in response";
  try {
    const res = await httpGet(`${BASE_URL}/api/logs/core?tail=300`);
    if (res.status !== 200) {
      record(name, false, `status ${res.status} (expected 200)`);
      return;
    }
    const json = tryJson(res.body);
    if (!json || !isObject(json)) {
      record(name, false, `body is not a JSON object: ${res.body.slice(0, 200)}`);
      return;
    }
    const problems = [];
    if (typeof json.stdout !== "string") problems.push("'stdout' is not a string");
    if (typeof json.stderr !== "string") problems.push("'stderr' is not a string");
    if (json.tail !== 300) problems.push(`'tail' is ${json.tail} (expected 300)`);
    if (json.category !== "core") problems.push(`'category' is ${json.category} (expected "core")`);
    if (problems.length === 0) {
      record(name, true);
    } else {
      record(name, false, problems.join("; "));
    }
  } catch (err) {
    record(name, false, `error: ${err.message}`);
  }
}

// ── Test 16: /api/status contains `suggestions` array (Daily Driver) ──
async function testStatusSuggestions() {
  const name = "Test 16: /api/status contains 'suggestions' array";
  try {
    const res = await httpGet(`${BASE_URL}/api/status`);
    if (res.status !== 200) {
      record(name, false, `status ${res.status} (expected 200)`);
      return;
    }
    const json = tryJson(res.body);
    if (!json || !isObject(json)) {
      record(name, false, `body is not a JSON object: ${res.body.slice(0, 200)}`);
      return;
    }
    if (!Array.isArray(json.suggestions)) {
      record(name, false, `'suggestions' is not an array: ${JSON.stringify(json.suggestions).slice(0, 120)}`);
      return;
    }
    // When suggestions exist, each must have a stable code + message + severity.
    const problems = [];
    for (let i = 0; i < json.suggestions.length; i++) {
      const s = json.suggestions[i];
      if (!isObject(s)) {
        problems.push(`suggestions[${i}] is not an object`);
        continue;
      }
      if (typeof s.code !== "string" || s.code.length === 0) problems.push(`suggestions[${i}].code missing`);
      if (typeof s.message !== "string" || s.message.length === 0) problems.push(`suggestions[${i}].message missing`);
      if (typeof s.severity !== "string") problems.push(`suggestions[${i}].severity not string`);
    }
    if (problems.length === 0) {
      record(name, true);
    } else {
      record(name, false, problems.join("; "));
    }
  } catch (err) {
    record(name, false, `error: ${err.message}`);
  }
}

// ── Test 17: /api/events returns valid JSON (Activity Timeline) ──
async function testEventsApi() {
  const name = "Test 17: /api/events returns valid JSON with events array";
  try {
    const res = await httpGet(`${BASE_URL}/api/events?limit=100`);
    if (res.status !== 200) {
      record(name, false, `status ${res.status} (expected 200)`);
      return;
    }
    const json = tryJson(res.body);
    if (!json || !isObject(json)) {
      record(name, false, `body is not a JSON object: ${res.body.slice(0, 200)}`);
      return;
    }
    const problems = [];
    if (!Array.isArray(json.events)) problems.push("'events' is not an array");
    if (typeof json.total !== "number") problems.push("'total' is not a number");
    if (typeof json.limit !== "number") problems.push("'limit' is not a number");
    // Each event (if any) must have timestamp + type strings.
    if (Array.isArray(json.events)) {
      for (let i = 0; i < json.events.length; i++) {
        const ev = json.events[i];
        if (!isObject(ev)) {
          problems.push(`events[${i}] is not an object`);
          continue;
        }
        if (typeof ev.timestamp !== "string") problems.push(`events[${i}].timestamp not string`);
        if (typeof ev.type !== "string") problems.push(`events[${i}].type not string`);
      }
    }
    if (problems.length === 0) {
      record(name, true);
    } else {
      record(name, false, problems.join("; "));
    }
  } catch (err) {
    record(name, false, `error: ${err.message}`);
  }
}

// ── Test 18: /api/logs/control-center returns valid JSON ─────────
async function testControlCenterLogApi() {
  const name = "Test 18: /api/logs/control-center returns valid JSON";
  try {
    const res = await httpGet(`${BASE_URL}/api/logs/control-center`);
    if (res.status !== 200) {
      record(name, false, `status ${res.status} (expected 200)`);
      return;
    }
    const json = tryJson(res.body);
    if (!json || !isObject(json)) {
      record(name, false, `body is not a JSON object: ${res.body.slice(0, 200)}`);
      return;
    }
    const problems = [];
    if (typeof json.stdout !== "string") problems.push("'stdout' is not a string");
    if (typeof json.stderr !== "string") problems.push("'stderr' is not a string");
    if (json.category !== "control-center") problems.push(`'category' is ${json.category} (expected "control-center")`);
    if (typeof json.tail !== "number") problems.push("'tail' is not a number");
    if (problems.length === 0) {
      record(name, true);
    } else {
      record(name, false, problems.join("; "));
    }
  } catch (err) {
    record(name, false, `error: ${err.message}`);
  }
}

// ── Test 19: POST /api/restart-all without token -> 403 ──────────
async function testRestartAllNoToken() {
  const name = "Test 19: POST /api/restart-all without token -> 403";
  try {
    const res = await httpPost(`${BASE_URL}/api/restart-all`, {});
    if (res.status !== 403) {
      record(name, false, `status ${res.status} (expected 403 — restart must be token-gated)`);
      return;
    }
    const json = tryJson(res.body);
    if (!json || typeof json.error !== "string") {
      record(name, false, `response body missing 'error' field: ${res.body.slice(0, 200)}`);
      return;
    }
    record(name, true);
  } catch (err) {
    record(name, false, `error: ${err.message}`);
  }
}

// ── Test 20: /api/control-center-status reports running instance ─
async function testControlCenterStatusApi() {
  const name = "Test 20: /api/control-center-status reports running instance";
  try {
    const res = await httpGet(`${BASE_URL}/api/control-center-status`);
    if (res.status !== 200) {
      record(name, false, `status ${res.status} (expected 200)`);
      return;
    }
    const json = tryJson(res.body);
    if (!json || !isObject(json)) {
      record(name, false, `body is not a JSON object: ${res.body.slice(0, 200)}`);
      return;
    }
    const problems = [];
    if (json.running !== true) problems.push(`'running' is ${json.running} (expected true — server is alive)`);
    if (typeof json.pid !== "number") problems.push("'pid' is not a number");
    if (typeof json.port !== "number") problems.push("'port' is not a number");
    if (json.port !== TEST_PORT) problems.push(`'port' is ${json.port} (expected ${TEST_PORT})`);
    if (typeof json.started_at !== "string") problems.push("'started_at' is not a string");
    if (typeof json.url !== "string" || !json.url.includes(`${TEST_PORT}`)) {
      problems.push(`'url' missing or does not reference port ${TEST_PORT}: ${json.url}`);
    }
    if (typeof json.version !== "string") problems.push("'version' is not a string");
    if (problems.length === 0) {
      record(name, true);
    } else {
      record(name, false, problems.join("; "));
    }
  } catch (err) {
    record(name, false, `error: ${err.message}`);
  }
}

// ── Test 21: GET /api/workspace/repos returns valid JSON with repos array ──
async function testWorkspaceReposApi() {
  const name = "Test 21: /api/workspace/repos returns valid JSON with repos array";
  try {
    const res = await httpGet(`${BASE_URL}/api/workspace/repos`);
    if (res.status !== 200) {
      record(name, false, `status ${res.status} (expected 200)`);
      return;
    }
    const json = tryJson(res.body);
    if (!json || !isObject(json)) {
      record(name, false, `body is not a JSON object: ${res.body.slice(0, 200)}`);
      return;
    }
    const problems = [];
    if (!Array.isArray(json.repos)) problems.push("'repos' is not an array");
    if (typeof json.workspace_root !== "string" && json.workspace_root !== null) {
      problems.push("'workspace_root' is neither string nor null");
    }
    if (Array.isArray(json.repos)) {
      for (let i = 0; i < json.repos.length; i++) {
        const repo = json.repos[i];
        if (!isObject(repo)) {
          problems.push(`repos[${i}] is not an object`);
          continue;
        }
        if (typeof repo.name !== "string") problems.push(`repos[${i}].name not string`);
        if (typeof repo.path !== "string") problems.push(`repos[${i}].path not string`);
        if (typeof repo.has_package_json !== "boolean") problems.push(`repos[${i}].has_package_json not boolean`);
      }
    }
    if (problems.length === 0) {
      record(name, true);
    } else {
      record(name, false, problems.join("; "));
    }
  } catch (err) {
    record(name, false, `error: ${err.message}`);
  }
}

// ── Test 22: /api/release/status no longer mentions release_prepare and has ready_state ──
async function testReleaseStatusFields() {
  const name = "Test 22: /api/release/status has ready_state and no release_prepare text";
  try {
    const res = await httpGet(`${BASE_URL}/api/release/status?repo_path=.`);
    if (res.status !== 200) {
      record(name, false, `status ${res.status} (expected 200)`);
      return;
    }
    const json = tryJson(res.body);
    if (!json || !isObject(json)) {
      record(name, false, `body is not a JSON object: ${res.body.slice(0, 200)}`);
      return;
    }
    const problems = [];
    if (!("ready_state" in json)) problems.push("missing 'ready_state' field");
    if (typeof json.ready_state !== "string") problems.push("'ready_state' is not a string");
    if (!("package_name" in json)) problems.push("missing 'package_name' field");
    if (!("version_source" in json)) problems.push("missing 'version_source' field");
    if (!("version_consistent" in json)) problems.push("missing 'version_consistent' field");
    if (!Array.isArray(json.required_commands)) problems.push("'required_commands' is not an array");
    if (typeof json.commands_blocked_count !== "number") problems.push("'commands_blocked_count' is not a number");
    // The old misleading "release_prepare" text must no longer appear.
    if (res.body.includes("release_prepare")) {
      problems.push("response still contains 'release_prepare' text");
    }
    if (Array.isArray(json.required_commands)) {
      for (let i = 0; i < json.required_commands.length; i++) {
        const cmd = json.required_commands[i];
        if (!isObject(cmd)) {
          problems.push(`required_commands[${i}] is not an object`);
          continue;
        }
        if (typeof cmd.command !== "string") problems.push(`required_commands[${i}].command not string`);
        if (typeof cmd.allowed !== "boolean") problems.push(`required_commands[${i}].allowed not boolean`);
        if (!("blocked_reason" in cmd)) problems.push(`required_commands[${i}] missing 'blocked_reason'`);
      }
    }
    if (problems.length === 0) {
      record(name, true);
    } else {
      record(name, false, problems.join("; "));
    }
  } catch (err) {
    record(name, false, `error: ${err.message}`);
  }
}

// ── Test 23: Safe task endpoints return valid JSON without full content ──
async function testSafeTaskEndpoints() {
  const name = "Test 23: safe task endpoints return valid JSON without stdout/stderr/diff";
  const endpoints = [
    "safe-result",
    "safe-audit",
    "safe-test-summary",
    "safe-diff-summary",
  ];
  const problems = [];
  for (const ep of endpoints) {
    try {
      const res = await httpGet(`${BASE_URL}/api/tasks/nonexistent-smoke-task/${ep}`);
      if (res.status !== 200) {
        problems.push(`/api/tasks/:id/${ep} -> status ${res.status} (expected 200, not 500)`);
        continue;
      }
      const json = tryJson(res.body);
      if (!json || !isObject(json)) {
        problems.push(`/api/tasks/:id/${ep} body is not a JSON object: ${res.body.slice(0, 120)}`);
        continue;
      }
      // Safe endpoints must NOT expose full stdout/stderr/diff content.
      const text = res.body.toLowerCase();
      if (text.includes('"stdout"') && text.includes('"stderr"')) {
        // Some safe endpoints may include a "stdout" key as a bounded field; the
        // invariant we care about is that they don't return the full raw logs.
        // We only flag if both stdout AND stderr appear together (log-shaped).
        problems.push(`/api/tasks/:id/${ep} may leak stdout+stderr shaped fields`);
      }
      if (text.includes('"diff_patch"')) {
        problems.push(`/api/tasks/:id/${ep} leaks 'diff_patch' field`);
      }
    } catch (err) {
      problems.push(`/api/tasks/:id/${ep} error: ${err.message}`);
    }
  }
  if (problems.length === 0) {
    record(name, true);
  } else {
    record(name, false, problems.join("; "));
  }
}

// ── Test 24: /api/tasks?status=running returns valid filtered JSON ──
async function testTasksFilter() {
  const name = "Test 24: /api/tasks?status=running returns valid filtered JSON";
  try {
    const res = await httpGet(`${BASE_URL}/api/tasks?status=running`);
    if (res.status !== 200) {
      record(name, false, `status ${res.status} (expected 200)`);
      return;
    }
    const json = tryJson(res.body);
    if (!json || !isObject(json)) {
      record(name, false, `body is not a JSON object: ${res.body.slice(0, 200)}`);
      return;
    }
    const problems = [];
    if (!Array.isArray(json.tasks)) problems.push("'tasks' is not an array");
    if (typeof json.total !== "number") problems.push("'total' is not a number");
    if (typeof json.returned !== "number") problems.push("'returned' is not a number");
    // Every returned task must match the filter (if any tasks exist).
    if (Array.isArray(json.tasks)) {
      for (let i = 0; i < json.tasks.length; i++) {
        if (json.tasks[i].status !== "running") {
          problems.push(`tasks[${i}].status is '${json.tasks[i].status}' (expected 'running')`);
        }
      }
      if (json.tasks.length !== json.total) {
        problems.push(`tasks.length (${json.tasks.length}) != total (${json.total})`);
      }
    }
    if (problems.length === 0) {
      record(name, true);
    } else {
      record(name, false, problems.join("; "));
    }
  } catch (err) {
    record(name, false, `error: ${err.message}`);
  }
}

// ── Test 25: /api/tasks/stale has explanation and next_action on stale tasks ──
async function testStaleTasksExplanation() {
  const name = "Test 25: /api/tasks/stale stale tasks have explanation and next_action";
  try {
    const res = await httpGet(`${BASE_URL}/api/tasks/stale`);
    if (res.status !== 200) {
      record(name, false, `status ${res.status} (expected 200)`);
      return;
    }
    const json = tryJson(res.body);
    if (!json || !isObject(json)) {
      record(name, false, `body is not a JSON object: ${res.body.slice(0, 200)}`);
      return;
    }
    const problems = [];
    if (!Array.isArray(json.stale_tasks)) problems.push("'stale_tasks' is not an array");
    if (Array.isArray(json.stale_tasks) && json.stale_tasks.length > 0) {
      for (let i = 0; i < json.stale_tasks.length; i++) {
        const t = json.stale_tasks[i];
        if (!isObject(t)) {
          problems.push(`stale_tasks[${i}] is not an object`);
          continue;
        }
        if (typeof t.explanation !== "string" || t.explanation.length === 0) {
          problems.push(`stale_tasks[${i}] missing 'explanation' string`);
        }
        if (typeof t.next_action !== "string" || t.next_action.length === 0) {
          problems.push(`stale_tasks[${i}] missing 'next_action' string`);
        }
        if (typeof t.reason_code !== "string") {
          problems.push(`stale_tasks[${i}] missing 'reason_code' string`);
        }
      }
    }
    if (problems.length === 0) {
      record(name, true);
    } else {
      record(name, false, problems.join("; "));
    }
  } catch (err) {
    record(name, false, `error: ${err.message}`);
  }
}

// ── Test 26: POST /api/tasks/:taskId/hide-stale token gate + valid response ──
async function testHideStaleNoToken() {
  const name = "Test 26: POST /api/tasks/:taskId/hide-stale without token -> 403";
  try {
    const res = await httpPost(`${BASE_URL}/api/tasks/nonexistent/hide-stale`, {});
    if (res.status !== 403) {
      record(name, false, `status ${res.status} (expected 403 — token gate must fire before hide-stale runs)`);
      return;
    }
    const json = tryJson(res.body);
    if (!json || typeof json.error !== "string") {
      record(name, false, `response body missing 'error' field: ${res.body.slice(0, 200)}`);
      return;
    }
    record(name, true);
  } catch (err) {
    record(name, false, `error: ${err.message}`);
  }
}

async function testHideStaleWithToken(token) {
  const name = "Test 27: POST /api/tasks/:taskId/hide-stale with token returns valid JSON";
  try {
    const res = await httpPost(`${BASE_URL}/api/tasks/nonexistent/hide-stale`, {
      "X-PatchWarden-Control-Token": token,
    });
    if (res.status !== 200) {
      record(name, false, `status ${res.status} (expected 200)`);
      return;
    }
    const json = tryJson(res.body);
    if (!json || !isObject(json)) {
      record(name, false, `body is not a JSON object: ${res.body.slice(0, 200)}`);
      return;
    }
    if (json.ok !== true) {
      record(name, false, `expected ok=true, got: ${res.body.slice(0, 200)}`);
      return;
    }
    if (json.hidden !== "nonexistent") {
      record(name, false, `expected hidden='nonexistent', got: ${json.hidden}`);
      return;
    }
    record(name, true);
  } catch (err) {
    record(name, false, `error: ${err.message}`);
  }
}

// ── Test 28: GET /api/warnings returns valid JSON ───────────────
async function testWarningsApi() {
  const name = "Test 28: /api/warnings returns valid JSON with warnings array";
  try {
    const res = await httpGet(`${BASE_URL}/api/warnings`);
    if (res.status !== 200) {
      record(name, false, `status ${res.status} (expected 200)`);
      return;
    }
    const json = tryJson(res.body);
    if (!json || !isObject(json)) {
      record(name, false, `body is not a JSON object: ${res.body.slice(0, 200)}`);
      return;
    }
    const problems = [];
    if (!Array.isArray(json.warnings)) problems.push("'warnings' is not an array");
    if (typeof json.total !== "number") problems.push("'total' is not a number");
    if (Array.isArray(json.warnings)) {
      for (let i = 0; i < json.warnings.length; i++) {
        const w = json.warnings[i];
        if (!isObject(w)) {
          problems.push(`warnings[${i}] is not an object`);
          continue;
        }
        if (typeof w.type !== "string") problems.push(`warnings[${i}].type is not a string`);
        if (typeof w.severity !== "string") problems.push(`warnings[${i}].severity is not a string`);
        if (typeof w.affected_tasks_count !== "number") problems.push(`warnings[${i}].affected_tasks_count is not a number`);
        if (typeof w.recommended_action !== "string") problems.push(`warnings[${i}].recommended_action is not a string`);
      }
    }
    if (problems.length === 0) {
      record(name, true);
    } else {
      record(name, false, problems.join("; "));
    }
  } catch (err) {
    record(name, false, `error: ${err.message}`);
  }
}

// ── Test 29: GET /api/diagnostics returns valid JSON with redaction ─
async function testDiagnosticsApi() {
  const name = "Test 29: /api/diagnostics returns valid JSON with required fields and redaction";
  try {
    const res = await httpGet(`${BASE_URL}/api/diagnostics`);
    if (res.status !== 200) {
      record(name, false, `status ${res.status} (expected 200)`);
      return;
    }
    const json = tryJson(res.body);
    if (!json || !isObject(json)) {
      record(name, false, `body is not a JSON object: ${res.body.slice(0, 200)}`);
      return;
    }
    const problems = [];
    if (typeof json.server_version !== "string") problems.push("'server_version' is not a string");
    if (typeof json.schema_epoch !== "string") problems.push("'schema_epoch' is not a string");
    if (typeof json.watcher_status !== "string") problems.push("'watcher_status' is not a string");
    if (typeof json.workspace_root !== "string" && json.workspace_root !== null) {
      problems.push("'workspace_root' is neither string nor null");
    }
    if (typeof json.direct_profile_enabled !== "boolean") problems.push("'direct_profile_enabled' is not a boolean");
    // Redaction: response body must not contain sensitive keywords
    const lower = res.body.toLowerCase();
    const forbidden = ["token", "password", "secret", "credential", "api_key"];
    for (const word of forbidden) {
      if (lower.includes(word)) {
        problems.push(`response body contains forbidden word '${word}' (redaction failure)`);
      }
    }
    if (problems.length === 0) {
      record(name, true);
    } else {
      record(name, false, problems.join("; "));
    }
  } catch (err) {
    record(name, false, `error: ${err.message}`);
  }
}

async function main() {
  // Sanity: ensure the compiled server exists before spawning.
  if (!existsSync(serverPath) || !statSync(serverPath).isFile()) {
    console.error(`[control-center-smoke] FATAL: ${serverPath} not found. Run 'npm run build' first.`);
    process.exit(1);
  }

  child = spawn("node", [serverPath], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PATCHWARDEN_CONTROL_PORT: String(TEST_PORT),
      PATCHWARDEN_CONTROL_LOG_DIR: TEST_LOG_DIR,
      PATCHWARDEN_CONTROL_FORCE_MISSING_TUNNEL_CLIENT: "1",
      // Point Core/Direct health probes at ports that are not listening, so the
      // smoke test does NOT depend on the real 8080/8081 being free on the host.
      // The probes will get ECONNREFUSED -> available:false with a reason, which
      // is exactly the fault-tolerance path we want to exercise.
      PATCHWARDEN_CORE_URL: "http://127.0.0.1:18080",
      PATCHWARDEN_DIRECT_URL: "http://127.0.0.1:18081",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  child.stdout.on("data", (chunk) => {
    childStdout += chunk.toString("utf-8");
  });
  child.stderr.on("data", (chunk) => {
    childStderr += chunk.toString("utf-8");
  });
  child.on("error", (err) => {
    childExitedEarly = true;
    childExitInfo = { code: null, signal: null, error: err.message };
  });
  child.on("exit", (code, signal) => {
    childExitInfo = { code, signal };
    // Only treat as "exited early" if we haven't started cleanup yet.
    if (!child.killed) {
      childExitedEarly = true;
    }
  });

  try {
    await waitForServer();
    console.log(`[control-center-smoke] server ready at ${BASE_URL}`);

    await testStaticFiles();
    await testPageNavigationRoutes();
    await testStatusJson();
    await testTasksJson();
    const token = await testControlToken();
    await testStartAllNoToken();
    await testStartAllWrongToken();
    if (token) await testStartAllPreflightMissingTunnelClient(token);
    await testOpenLogsFolderNoToken();
    testTokenNotInGit();
    testNoCdn();
    testTrayMenuContract();
    await testOtherGetApis();
    // Phase 2 coverage
    await testStaleTasksApi();
    await testWorkspaceRepoPathTraversal();
    await testReconcileNoToken();
    await testDirectSessionsEmptyList();
    await testLogsTailParam();
    // Daily Driver coverage
    await testStatusSuggestions();
    await testEventsApi();
    await testControlCenterLogApi();
    await testRestartAllNoToken();
    await testControlCenterStatusApi();
    // v1.5.1 Dashboard UI optimization coverage
    await testWorkspaceReposApi();
    await testReleaseStatusFields();
    await testSafeTaskEndpoints();
    await testTasksFilter();
    await testStaleTasksExplanation();
    await testHideStaleNoToken();
    if (token) await testHideStaleWithToken(token);
    // P1 Task 10/11 coverage
    await testWarningsApi();
    await testDiagnosticsApi();

    // Use token to silence unused-var linters and confirm we actually fetched it.
    if (token) {
      // Token was successfully retrieved; no further action needed in test mode.
    }
  } catch (err) {
    record("server bootstrap", false, err.message);
  } finally {
    cleanup();
    // Wait for the child to actually exit so the port is released before we exit.
    await waitForChildExit(5000);
  }

  console.log("");
  console.log(`Summary: ${passed} passed, ${failed} failed`);

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`[control-center-smoke] uncaught error: ${err && err.stack ? err.stack : err}`);
  cleanup();
  process.exit(1);
});
