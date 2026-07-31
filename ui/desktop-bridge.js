(function () {
  var api = window.patchwardenDesktop;
  if (!api) return;

  var html = document.documentElement;
  html.classList.add("pw-desktop");

  var nativeFetch = window.fetch.bind(window);
  var GET_TIMEOUT_MS = 30000;
  var CONNECT_RETRY_DELAY_MS = 250;
  var CONNECT_RETRY_WINDOW_MS = 1000;

  function controlCenterError(code, message, cause) {
    var error = new Error(message);
    error.name = code === "control_center_timeout" ? "ControlCenterTimeoutError" : "ControlCenterUnavailableError";
    error.code = code;
    if (cause) error.cause = cause;
    return error;
  }

  function isAbortError(error) {
    return !!error && error.name === "AbortError";
  }

  function isConnectionFailure(error) {
    if (!error || isAbortError(error)) return false;
    var name = String(error.name || "");
    var code = String(error.code || "");
    var message = String(error.message || "");
    return name === "TypeError" || /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|network|fetch failed|connection/i.test(code + " " + message);
  }

  function fetchGetWithBudget(input, options) {
    var startedAt = Date.now();
    var retried = false;

    function attempt() {
      var remaining = GET_TIMEOUT_MS - (Date.now() - startedAt);
      if (remaining <= 0) {
        return Promise.reject(controlCenterError("control_center_timeout", "Control Center request timed out after 30 seconds."));
      }
      var controller = new AbortController();
      var timer = window.setTimeout(function () { controller.abort(); }, remaining);
      return nativeFetch(input, Object.assign({}, options, { signal: controller.signal })).catch(function (error) {
        var elapsed = Date.now() - startedAt;
        if (!retried && elapsed <= CONNECT_RETRY_WINDOW_MS && isConnectionFailure(error)) {
          retried = true;
          return new Promise(function (resolve) {
            window.setTimeout(resolve, CONNECT_RETRY_DELAY_MS);
          }).then(attempt);
        }
        if (isAbortError(error)) {
          throw controlCenterError("control_center_timeout", "Control Center request timed out after 30 seconds.", error);
        }
        if (isConnectionFailure(error)) {
          throw controlCenterError("control_center_unavailable", "Control Center is unavailable.", error);
        }
        throw error;
      }).finally(function () {
        window.clearTimeout(timer);
      });
    }

    return attempt();
  }

  window.fetch = function (input, init) {
    var options = init || {};
    var method = String(options.method || "GET").toUpperCase();
    if (method !== "GET" || options.signal) return nativeFetch(input, options);
    return fetchGetWithBudget(input, options);
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
