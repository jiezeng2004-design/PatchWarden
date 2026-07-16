import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

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
  });

  it("does not gate Dashboard toolbar layout on preload", () => {
    const css = read("ui/desktop.css");
    assert.match(css, /\.pw-dashboard-toolbar\s*\{/);
    assert.doesNotMatch(css, /html\.pw-desktop \.pw-dashboard-toolbar/);
    assert.match(css, /overflow-x:\s*hidden/);
  });

  it("treats disabled Direct as an optional healthy state", () => {
    const dashboard = read("ui/pages/dashboard.html");
    assert.match(dashboard, /coreReady && \(!directProfileEnabled \|\| directReady\)/);
    assert.match(dashboard, /ok: true,\s+detail: directProfileEnabled \? '已启用' : '可选，未启用'/);
    assert.doesNotMatch(dashboard, /\|\| !directProfileEnabled \|\| !releaseReady/);
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
});
