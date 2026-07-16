(function () {
  var api = window.patchwardenDesktop;
  if (!api) return;

  var html = document.documentElement;
  html.classList.add("pw-desktop");

  var nativeFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var options = init || {};
    var method = String(options.method || "GET").toUpperCase();
    if (method !== "GET" || options.signal) return nativeFetch(input, options);
    var controller = new AbortController();
    var timer = window.setTimeout(function () { controller.abort(); }, 10000);
    return nativeFetch(input, Object.assign({}, options, { signal: controller.signal })).catch(function (error) {
      if (error && error.name === "AbortError") throw new Error("请求超过 10 秒，请重试");
      throw error;
    }).finally(function () { window.clearTimeout(timer); });
  };

  function applyTheme(theme) {
    var dark = theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    html.dataset.theme = dark ? "dark" : "light";
    html.classList.toggle("dark", dark);
    html.classList.toggle("light", !dark);
  }

  window.patchwardenApplyTheme = applyTheme;

  function addSettingsNavigation() {
    var nav = document.querySelector("aside nav");
    if (!nav) return;
    if (!nav.querySelector('[data-nav-key="getting-started"]')) {
      var home = document.createElement("a");
      home.href = "/pages/getting-started.html";
      home.dataset.navKey = "getting-started";
      home.className = "desktop-only-nav flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors truncate";
      home.style.color = "var(--pw-text-secondary)";
      home.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"></path><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.87 12.87 0 0 1 22 2c0 2.72-.78 7.5-6.05 11a22.35 22.35 0 0 1-3.95 2z"></path><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"></path><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"></path></svg><span class="truncate" data-i18n="nav.gettingStarted"></span>';
      nav.insertBefore(home, nav.firstChild);
    }
    if (nav.querySelector('[data-nav-key="settings"]')) return;
    var link = document.createElement("a");
    link.href = "/pages/settings.html";
    link.dataset.navKey = "settings";
    link.className = "desktop-only-nav flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors truncate";
    link.style.color = "var(--pw-text-secondary)";
    link.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1z"></path></svg><span class="truncate" data-i18n="nav.settings"></span>';
    nav.appendChild(link);
    if (window.applyTranslations) window.applyTranslations(nav);
  }

  addSettingsNavigation();
  api.getPreferences().then(function (preferences) { applyTheme(preferences.theme || "system"); });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function () {
    api.getPreferences().then(function (preferences) { if (preferences.theme === "system") applyTheme("system"); });
  });
})();
