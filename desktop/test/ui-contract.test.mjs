import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";

const repoRoot = resolve(import.meta.dirname, "..", "..");
const read = (path) => readFileSync(resolve(repoRoot, path), "utf8");

describe("desktop UI contracts", () => {
  it("loads the shared translation layer on every Control Center page", () => {
    const pages = ["audit", "dashboard", "direct-sessions", "getting-started", "logs", "settings", "task-detail", "tasks", "workspace"];
    for (const page of pages) assert.match(read(`ui/pages/${page}.html`), /<script src="\/i18n\.js"><\/script>/, page);
    const i18n = read("ui/i18n.js");
    for (const marker of ['"zh-CN"', "en:", "applyTranslations", "patchwarden.language", "MutationObserver"]) assert.ok(i18n.includes(marker), marker);
  });

  it("keeps every declarative translation key in both dictionaries", () => {
    const i18n = read("ui/i18n.js");
    const keys = new Set();
    for (const file of ["ui/pages/getting-started.html", "ui/pages/settings.html"]) {
      for (const match of read(file).matchAll(/data-i18n(?:-title|-placeholder)?="([^"]+)"/g)) keys.add(match[1]);
    }
    for (const key of keys) assert.ok((i18n.match(new RegExp(`"${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`, "g")) || []).length >= 2, key);
  });

  it("provides four readiness checks and bounded credential controls", () => {
    const home = read("ui/pages/getting-started.html");
    assert.equal((home.match(/class="readiness-item"/g) || []).length, 4);
    assert.match(home, /data-i18n="home\.manual"/);
    const settings = read("ui/pages/settings.html");
    for (const id of ["tunnelMode", "tunnelId", "runtimeKey", "provisionTunnel", "revalidateCredential", "forgetCredential", "language"]) assert.ok(settings.includes(`id="${id}"`), id);
    const homeClient = read("ui/getting-started.js");
    assert.match(homeClient, /lastCoreReady \? "home\.coreRunning"/);
  });

  it("keeps Settings static and dynamic copy on translation keys", () => {
    const settingsPage = read("ui/pages/settings.html");
    const settingsClient = read("ui/settings.js");
    assert.doesNotMatch(settingsPage, />[^<]*\p{Script=Han}[^<]*</u);
    assert.doesNotMatch(settingsClient, /[\p{Script=Han}]/u);
    for (const key of [
      "settings.appearance",
      "settings.mcpTunnel",
      "settings.workspaceDiagnostics",
      "settings.saveRuntime",
      "settings.runDoctor",
    ]) assert.ok(settingsPage.includes(`data-i18n="${key}"`), key);
    for (const key of ["settings.autoDetecting", "settings.doctorFailed", "settings.savedReload", "settings.saveFailed"]) {
      assert.ok(settingsClient.includes(`"${key}"`), key);
    }
    assert.match(settingsClient, /async function initializeSettings\(\)/);
    assert.match(settingsClient, /state\.runtimeSettings \|\| await api\.getRuntimeSettings\(\)/);
    assert.match(settingsClient, /state\.workspaceRoot \|\| tr\("settings\.workspaceHelp"\)/);
    assert.match(settingsClient, /state\.tunnelClient && state\.tunnelClient\.available/);
    assert.match(settingsClient, /tr\("settings\.loadFailed"\)/);
    for (const id of ["tunnelClientPath", "configPath", "workspacePath"]) {
      assert.doesNotMatch(settingsPage, new RegExp(`id="${id}"[^>]*data-i18n=`), id);
    }
  });

  it("does not gate Dashboard toolbar layout on preload", () => {
    const css = read("ui/desktop.css");
    assert.match(css, /\.pw-dashboard-toolbar\s*\{/);
    assert.doesNotMatch(css, /html\.pw-desktop \.pw-dashboard-toolbar/);
    assert.match(css, /overflow-x:\s*hidden/);
  });

  it("treats disabled Direct as an optional healthy state", () => {
    const dashboard = read("ui/pages/dashboard.html");
    const status = read("src/control/routes/status.ts");
    assert.match(status, /state: directEnabled \? \(directReady \? "ready" : "needs_action"\) : "optional"/);
    assert.match(status, /历史任务与审计记录不会影响当前实时就绪状态/);
    assert.match(dashboard, /experience\.live_checks/);
    assert.doesNotMatch(dashboard, /watcherDownAndFailed|failedCount > 2/);
  });

  it("keeps long-running history behind bounded list contracts", () => {
    const tasks = read("ui/pages/tasks.html");
    const sessions = read("ui/pages/direct-sessions.html");
    const workspace = read("ui/pages/workspace.html");
    const logs = read("ui/pages/logs.html");
    assert.match(tasks, /limit=50/);
    assert.match(tasks, /nextCursor \|\| data\.next_cursor/);
    assert.match(sessions, /session-state/);
    for (const id of ["session-repo", "session-date-from", "session-date-to", "direct-disabled", "sessions-more"]) assert.ok(sessions.includes(`id="${id}"`), id);
    assert.match(sessions, /data\.nextCursor \|\| data\.next_cursor/);
    assert.match(workspace, /internal_directories/);
    assert.match(workspace, /搜索 Git 项目/);
    assert.match(logs, /仅清空当前显示，不删除日志文件/);
    for (const marker of ["parseLogEntries", "log-row", "copy-log-line", "historical_snapshot"]) assert.ok(logs.includes(marker), marker);
    assert.doesNotMatch(logs, /stderr[^]*stroke="var\(--pw-state-error\)"[^]*<h2[^>]*>stderr<\/h2>/);
  });

  it("exposes exactly one dependency-aware action on Getting Started", () => {
    const home = read("ui/pages/getting-started.html");
    const client = read("ui/getting-started.js");
    const css = read("ui/desktop.css");
    assert.ok(home.indexOf('data-check="workspace"') < home.indexOf('data-check="core"'));
    assert.ok(home.indexOf('data-check="core"') < home.indexOf('data-check="tunnel"'));
    assert.match(client, /setPrimaryAction\(!workspaceReady \? "workspace" : !coreReady \? "core" : !tunnelReady \? "tunnel" : "chatgpt"\)/);
    assert.match(css, /data-primary-action="true"/);
  });

  it("parses JSONL logs and preserves raw-line fallback", () => {
    const context = {};
    runInNewContext(read("ui/log-parser.js"), context);
    const structured = context.PatchWardenLogParser.parseLine('{"timestamp":"2026-07-21T00:00:00Z","level":"warning","component":"watcher","message":"tick"}', "stderr");
    assert.equal(structured.structured, true);
    assert.equal(structured.level, "warn");
    assert.equal(structured.component, "watcher");
    assert.equal(structured.summary, "tick");
    const raw = context.PatchWardenLogParser.parseLine("plain stderr output", "stderr");
    assert.equal(raw.structured, false);
    assert.equal(raw.level, "");
    assert.equal(raw.summary, "plain stderr output");
  });

  it("keeps the logs page usable when the parser asset is missing", () => {
    const logs = read("ui/pages/logs.html");
    assert.match(logs, /<script src="\/log-parser\.js"><\/script>/);
    assert.match(logs, /if \(!window\.PatchWardenLogParser \|\| typeof window\.PatchWardenLogParser\.parseLine !== 'function'\)/);
    assert.match(logs, /structured: entry !== null/);
  });

  it("shows bounded Core and Direct connection identity", () => {
    const dashboard = read("ui/pages/dashboard.html");
    assert.match(dashboard, /status\.connections && status\.connections\[prefix\]/);
    assert.match(dashboard, /connection\.tunnel_id_masked/);
    assert.match(dashboard, /connection\.reconnect_guidance/);
  });

  it("boots the desktop theme before CSS and keeps desktop navigation static", () => {
    for (const file of ["audit", "dashboard", "direct-sessions", "getting-started", "logs", "settings", "task-detail", "tasks", "workspace"]) {
      const html = read(`ui/pages/${file}.html`);
      assert.ok(html.indexOf("/desktop-bootstrap.js") < html.indexOf("/desktop.css"), `${file} must bootstrap before desktop CSS`);
      assert.match(html, /data-nav-key="getting-started"/);
      assert.match(html, /data-nav-key="settings"/);
    }
    const bridge = read("ui/desktop-bridge.js");
    assert.doesNotMatch(bridge, /addSettingsNavigation/);
  });

  it("keeps packaged UI smoke isolated from normal startup", () => {
    const main = read("desktop/src/main.ts");
    const smoke = read("desktop/scripts/smoke-unpacked.mjs");
    assert.match(main, /PATCHWARDEN_DESKTOP_SMOKE === "1"/);
    assert.match(main, /\[\[1280, 720\], \[1024, 700\], \[960, 640\]\]/);
    assert.match(main, /metrics\.scrollWidth <= metrics\.clientWidth/);
    assert.match(main, /focusOrderOk/);
    assert.match(smoke, /valid keyboard focus order/);
    assert.match(smoke, /PATCHWARDEN_CONFIG: isolatedConfig/);
    assert.match(smoke, /second instance must exit successfully/);
    assert.doesNotMatch(smoke, /taskkill|Stop-Process|kill all/i);
  });
});
