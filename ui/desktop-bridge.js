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
    localStorage.setItem("patchwarden.desktop.theme", theme || "system");
    html.style.backgroundColor = dark ? "#0f1413" : "#eef2f1";
  }

  window.patchwardenApplyTheme = applyTheme;

  api.getPreferences().then(function (preferences) { applyTheme(preferences.theme || "system"); });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function () {
    api.getPreferences().then(function (preferences) { if (preferences.theme === "system") applyTheme("system"); });
  });
})();
