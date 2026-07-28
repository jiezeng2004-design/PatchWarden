#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const root = fileURLToPath(new URL("../..", import.meta.url));
const logsHtml = readFileSync(join(root, "ui", "pages", "logs.html"), "utf-8");
const i18n = readFileSync(join(root, "ui", "i18n.js"), "utf-8");
const settings = readFileSync(join(root, "ui", "settings.js"), "utf-8");
const tasks = readFileSync(join(root, "ui", "pages", "tasks.html"), "utf-8");

for (const key of [
  "logs.coreCategory", "logs.directCategory", "logs.watcherCategory", "logs.controlCenterCategory",
  "logs.last100", "logs.tailFilterLabel", "logs.clearView", "logs.levelFilterLabel", "logs.allLevels", "logs.levelError", "logs.levelWarning",
  "logs.levelInfo", "logs.searchPlaceholder", "logs.searchLabel", "logs.stdout", "logs.stderr", "logs.clearedEmpty", "logs.liveMeta",
  "logs.errorTitle", "logs.unknownError",
]) {
  assert.match(logsHtml + i18n, new RegExp(key.replace(".", "\\.")), `missing localized log key: ${key}`);
  assert.equal((i18n.match(new RegExp(`"${key.replace(".", "\\.")}"`, "g")) || []).length, 2, `${key} must exist in both dictionaries`);
}

assert.doesNotMatch(logsHtml, />tail (?:100|300|1000)</, "tail selectors must use user-facing localized labels");
assert.doesNotMatch(logsHtml, /<option value="(?:error|warn|info)">(Error|Warning|Info)<\/option>/, "Chinese mode must not expose English-only level labels");
assert.match(i18n, /\[data-i18n-aria-label\]/, "localized controls must update accessible names when the language changes");
assert.match(i18n, /select\.dataset\.i18nTitle = "language\.label"/, "language selector title must be localized with its accessible name");
for (const id of ["tailSelect", "levelFilter", "logSearch"]) {
  assert.match(logsHtml, new RegExp(`id="${id}"[^>]+data-i18n-aria-label=`), `${id} must have a localized accessible name`);
}
assert.match(logsHtml, /var clearedViews = Object\.create\(null\)/, "cleared state must be tracked per category");
assert.match(logsHtml, /clearedViews\[currentCategory\] = true/, "clear view must mark only the active category");
assert.match(logsHtml, /if \(clearedViews\[cat\]\)/, "returning to a cleared category must preserve the cleared view");
assert.match(logsHtml, /logAbortController\.abort\(\)/, "category switches must cancel stale log requests");
assert.match(logsHtml, /requestId !== logRequestId \|\| category !== currentCategory/, "stale category responses must not render");
assert.match(logsHtml, /loadLogs\(\{ force: true \}\)/, "explicit refresh must restore a cleared category");
assert.match(logsHtml, /var currentError = null/, "dynamic log errors must retain a localizable state key");
assert.match(logsHtml, /renderError\(\);\s*renderLastUpdated\(\);/, "language changes must re-render dynamic errors and timestamps");
assert.match(logsHtml, /\.log-category-control \{ flex-basis: 100%; width: 100%; \}/, "narrow desktop toolbars must place categories on their own row");
assert.match(settings, /agent\.available \? \(agent\.commandLabel \|\| tr\("settings\.agentAvailable"\)\) : tr\("settings\.agentMissing"\)/, "missing Agent CLIs must use the active UI language");
for (const label of ["Running", "Pending", "Failed Verification", "Ready For Review", "Manual Verification Required", "Unrecorded Command Execution", "Artifact Hygiene", "Scope Changes"]) {
  assert.doesNotMatch(tasks, new RegExp(`>${label}<`), `Chinese task filters must not expose English-only label: ${label}`);
}

class FakeClassList {
  #values = new Set();
  add(value) { this.#values.add(value); }
  remove(value) { this.#values.delete(value); }
  contains(value) { return this.#values.has(value); }
}

class FakeElement {
  constructor(id, attributes = {}) {
    this.id = id;
    this.attributes = new Map(Object.entries(attributes));
    this.classList = new FakeClassList();
    this.listeners = new Map();
    this.textContent = "";
    this.innerHTML = "";
    this.value = "";
    this.checked = false;
  }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(name, handler) {
    const handlers = this.listeners.get(name) || [];
    handlers.push(handler);
    this.listeners.set(name, handlers);
  }
  trigger(name) {
    for (const handler of this.listeners.get(name) || []) handler({ currentTarget: this, target: this });
  }
}

const ids = [
  "error-banner", "error-message", "refreshIcon", "lastUpdated", "stdoutContent", "stdoutEmpty", "stdoutMeta",
  "stderrContent", "stderrEmpty", "stderrMeta", "tailSelect", "autoRefresh", "refreshBtn", "clearView", "levelFilter", "logSearch",
];
const elements = new Map(ids.map((id) => [id, new FakeElement(id)]));
const categories = ["core", "direct", "watcher", "control-center"].map((category) => new FakeElement(`category-${category}`, { "data-cat": category }));
elements.get("tailSelect").value = "100";
elements.get("levelFilter").value = "";

const pendingRequests = [];
const pageEvents = new Map();
let autoRefreshCallback = null;
const fakeDocument = {
  getElementById(id) { return elements.get(id) || null; },
  querySelectorAll(selector) { return selector === ".cat-btn" ? categories : []; },
};
const fakeWindow = {
  addEventListener(name, handler) {
    const handlers = pageEvents.get(name) || [];
    handlers.push(handler);
    pageEvents.set(name, handlers);
  },
  PatchWardenLogParser: {
    parseLine(line, stream) {
      return { raw: String(line), time: "", level: "info", component: stream, summary: String(line), detail: String(line) };
    },
  },
};
class FakeAbortController {
  constructor() { this.signal = {}; }
  abort() { this.signal.aborted = true; }
}
const fetchStub = (url) => new Promise((resolve, reject) => pendingRequests.push({ url, resolve, reject }));
const scriptStart = logsHtml.indexOf("  (function () {");
const scriptEnd = logsHtml.indexOf("\n  </script>", scriptStart);
assert.ok(scriptStart >= 0 && scriptEnd > scriptStart, "log page state script must be present");
runInNewContext(logsHtml.slice(scriptStart, scriptEnd), {
  AbortController: FakeAbortController,
  Date,
  JSON,
  Object,
  Promise,
  RegExp,
  String,
  Array,
  Error,
  encodeURIComponent,
  parseInt,
  document: fakeDocument,
  window: fakeWindow,
  navigator: {},
  fetch: fetchStub,
  setInterval(callback) { autoRefreshCallback = callback; return 1; },
  clearInterval() {},
  setTimeout,
});

const settle = async () => new Promise((resolve) => setImmediate(resolve));
const respond = async (request, category, stdout) => {
  request.resolve({ ok: true, status: 200, json: async () => ({ category, tail: 100, stdout, stderr: "" }) });
  await settle();
};
const byCategory = (category) => categories.find((element) => element.getAttribute("data-cat") === category);

assert.equal(pendingRequests.length, 1, "initial Core request must start once");
assert.match(pendingRequests[0].url, /\/api\/logs\/core/, "initial request must target Core");
byCategory("direct").trigger("click");
assert.equal(pendingRequests.length, 2, "switching to Direct must issue its own request");
await respond(pendingRequests[1], "direct", "DIRECT-LATEST");
assert.match(elements.get("stdoutContent").innerHTML, /DIRECT-LATEST/, "Direct response must render in Direct view");
await respond(pendingRequests[0], "core", "CORE-STALE");
assert.doesNotMatch(elements.get("stdoutContent").innerHTML, /CORE-STALE/, "stale Core response must not overwrite Direct");

byCategory("core").trigger("click");
await respond(pendingRequests[2], "core", "CORE-CURRENT");
elements.get("clearView").trigger("click");
assert.match(elements.get("stdoutEmpty").textContent, /当前分类视图已清空/, "clearing Core must show its cleared state");
byCategory("direct").trigger("click");
await respond(pendingRequests[3], "direct", "DIRECT-AFTER-CORE-CLEAR");
assert.match(elements.get("stdoutContent").innerHTML, /DIRECT-AFTER-CORE-CLEAR/, "Direct must stay available after Core is cleared");
byCategory("core").trigger("click");
assert.match(elements.get("stdoutEmpty").textContent, /当前分类视图已清空/, "returning to Core must retain only Core's cleared state");

elements.get("autoRefresh").checked = true;
elements.get("autoRefresh").trigger("change");
assert.equal(typeof autoRefreshCallback, "function", "auto-refresh must register a callback");
const requestsBeforeAutoRefresh = pendingRequests.length;
autoRefreshCallback();
assert.equal(pendingRequests.length, requestsBeforeAutoRefresh, "auto-refresh must not restore a cleared category");
elements.get("refreshBtn").trigger("click");
assert.equal(pendingRequests.length, requestsBeforeAutoRefresh + 1, "manual refresh must restore the active cleared category only");
await respond(pendingRequests.at(-1), "core", "CORE-MANUAL-REFRESH");
assert.match(elements.get("stdoutContent").innerHTML, /CORE-MANUAL-REFRESH/, "manual refresh must render the active category again");

byCategory("direct").trigger("click");
await respond(pendingRequests.at(-1), "direct", "DIRECT-FOR-TAIL");
elements.get("clearView").trigger("click");
byCategory("core").trigger("click");
await respond(pendingRequests.at(-1), "core", "CORE-BEFORE-TAIL");
elements.get("tailSelect").value = "300";
elements.get("tailSelect").trigger("change");
await respond(pendingRequests.at(-1), "core", "CORE-TAIL-REFRESH");
byCategory("direct").trigger("click");
assert.match(elements.get("stdoutEmpty").textContent, /当前分类视图已清空/, "changing Core tail must not restore a cleared Direct category");

byCategory("watcher").trigger("click");
await respond(pendingRequests.at(-1), "core", "WRONG-CATEGORY");
assert.match(elements.get("error-message").textContent, /日志分类响应不匹配/, "a mismatched response must produce a localized error state");
const translations = {
  "logs.categoryMismatch": { zh: "日志分类响应不匹配", en: "Log category response did not match the current view" },
  "logs.updatedAt": { zh: "更新于 {time}", en: "Updated {time}" },
};
let language = "zh";
fakeWindow.PatchWardenI18n = {
  t(key, params) {
    let value = translations[key]?.[language] || key;
    for (const [name, replacement] of Object.entries(params || {})) value = value.replaceAll(`{${name}}`, String(replacement));
    return value;
  },
};
language = "en";
for (const handler of pageEvents.get("patchwarden:languagechange") || []) handler();
assert.equal(elements.get("error-message").textContent, "Log category response did not match the current view", "language changes must re-render the retained error key");
assert.match(elements.get("lastUpdated").textContent, /^Updated /, "language changes must re-render the retained timestamp");

class I18nNode {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.textContent = "";
    this.title = "";
    this.placeholder = "";
    this.id = "";
  }
  appendChild(child) { this.children.push(child); return child; }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  addEventListener(name, handler) { this.listeners.set(name, handler); }
}

const i18nBody = new I18nNode("body");
const i18nHeader = i18nBody.appendChild(new I18nNode("header"));
const i18nAside = i18nBody.appendChild(new I18nNode("aside"));
const allI18nNodes = () => {
  const nodes = [];
  const visit = (node) => { nodes.push(node); node.children.forEach(visit); };
  visit(i18nBody);
  return nodes;
};
const i18nDocument = {
  body: i18nBody,
  documentElement: { lang: "" },
  readyState: "complete",
  addEventListener() {},
  createElement(tagName) { return new I18nNode(tagName); },
  createTreeWalker() { return { nextNode() { return null; } }; },
  getElementById(id) { return allI18nNodes().find((node) => node.id === id) || null; },
  querySelector(selector) {
    if (selector === "header") return i18nHeader;
    if (selector === "aside") return i18nAside;
    return null;
  },
  querySelectorAll(selector) {
    const propertyBySelector = {
      "[data-i18n]": "i18n",
      "[data-i18n-title]": "i18nTitle",
      "[data-i18n-placeholder]": "i18nPlaceholder",
      "[data-i18n-aria-label]": "i18nAriaLabel",
      "[data-core-version]": "coreVersion",
    };
    const property = propertyBySelector[selector];
    return property ? allI18nNodes().filter((node) => Object.hasOwn(node.dataset, property)) : [];
  },
};
const i18nStorage = new Map();
const i18nWindow = { addEventListener() {}, dispatchEvent() {} };
class FakeMutationObserver { observe() {} }
runInNewContext(i18n, {
  Array,
  CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
  MutationObserver: FakeMutationObserver,
  NodeFilter: { SHOW_TEXT: 4 },
  Object,
  Promise,
  RegExp,
  String,
  document: i18nDocument,
  fetch: async () => ({ ok: false }),
  localStorage: { getItem: (key) => i18nStorage.get(key) || null, setItem: (key, value) => i18nStorage.set(key, String(value)) },
  navigator: { language: "zh-CN" },
  window: i18nWindow,
});
const languageSelector = i18nDocument.getElementById("pw-language-switcher");
assert.ok(languageSelector, "i18n initialization must add a language selector");
assert.equal(languageSelector.getAttribute("aria-label"), "语言", "language selector aria-label must start in Chinese");
assert.equal(languageSelector.title, "语言", "language selector title must start in Chinese");
await i18nWindow.PatchWardenI18n.setLanguage("en");
assert.equal(languageSelector.getAttribute("aria-label"), "Language", "language selector aria-label must update after switching to English");
assert.equal(languageSelector.title, "Language", "language selector title must update after switching to English");

console.log("ok - log categories are bilingual, clear independently, and ignore stale category responses");
