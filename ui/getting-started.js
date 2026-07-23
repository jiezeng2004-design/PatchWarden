(function () {
  var api = window.patchwardenDesktop;
  var i18n = window.PatchWardenI18n;
  var statusData = null;
  var tunnelData = null;
  var coreStarting = false;
  var lastCoreReady = false;
  function tr(key) { return i18n ? i18n.t(key) : key; }
  function item(name) { return document.querySelector('[data-check="' + name + '"]'); }
  function reasonText(reason, fallback) {
    if (!reason) return "";
    var key = "reason." + reason; var translated = tr(key);
    return translated === key ? (fallback || reason) : translated;
  }
  function render(name, state, message, reason, fallback) {
    var root = item(name); if (!root) return;
    root.dataset.state = state;
    root.querySelector("[data-status]").textContent = tr(state === "ready" ? "home.ready" : state === "manual" ? "home.manual" : "home.needsAction");
    root.querySelector("[data-message]").textContent = tr(message);
    var detail = root.querySelector("[data-reason]"); if (detail) detail.textContent = reasonText(reason, fallback);
  }
  function renderLiveCheck(name, check) {
    if (!check) return;
    var root = item(name); if (!root) return;
    var state = check.state === "ready" ? "ready" : check.state === "optional" ? "manual" : "action";
    root.dataset.state = state;
    root.querySelector("[data-status]").textContent = tr(state === "ready" ? "home.ready" : state === "manual" ? "home.manual" : "home.needsAction");
    root.querySelector("[data-message]").textContent = check.detail || "";
    var detail = root.querySelector("[data-reason]"); if (detail) detail.textContent = "";
  }
  function setPrimaryAction(name) {
    ["workspace", "core", "tunnel", "chatgpt"].forEach(function (key) {
      var root = item(key);
      if (root) root.dataset.primaryAction = key === name ? "true" : "false";
    });
  }
  function syncCoreButton() {
    var button = document.getElementById("startCore");
    button.disabled = coreStarting || lastCoreReady;
    button.textContent = tr(coreStarting ? "home.startingCore" : lastCoreReady ? "home.coreRunning" : "home.startCore");
  }
  async function fetchJson(url, options) {
    var response = await fetch(url, options); var body = await response.json().catch(function () { return {}; });
    if (!response.ok || body.ok === false) { var error = new Error(body.error || "Request failed"); error.reasonCode = body.reason_code; error.nextSteps = body.next_steps || []; throw error; }
    return body;
  }
  async function refresh() {
    statusData = await fetchJson("/api/status");
    var agents = Array.isArray(statusData.agents) ? statusData.agents : [];
    var workspaceReady = !!statusData.workspace_root && agents.some(function (agent) { return agent && agent.available; });
    var coreAvailable = !!(statusData.core && statusData.core.available);
    var watcherReady = !!(statusData.watcher && statusData.watcher.status === "healthy");
    var coreReady = coreAvailable && watcherReady;
    var coreTunnel = statusData.tunnel && statusData.tunnel.core ? statusData.tunnel.core : {};
    var tunnelReady = coreTunnel.ready === true;

    render("workspace", workspaceReady ? "ready" : "action", workspaceReady ? "home.workspaceReady" : "home.workspaceMissing", workspaceReady ? null : "workspace_agent_missing");
    render("core", coreReady ? "ready" : "action", coreReady ? "home.coreReady" : "home.coreMissing", coreReady ? null : (statusData.watcher && statusData.watcher.reason) || (statusData.core && statusData.core.reason) || "watcher_unhealthy");
    render("tunnel", tunnelReady ? "ready" : "action", tunnelReady ? "home.tunnelReady" : "home.tunnelMissing", tunnelReady ? null : coreTunnel.reason_code || "tunnel_not_ready");
    render("chatgpt", "manual", "home.chatgptManual", null);

    lastCoreReady = coreReady;
    syncCoreButton();
    setPrimaryAction(!workspaceReady ? "workspace" : !coreReady ? "core" : !tunnelReady ? "tunnel" : "chatgpt");
  }
  async function startCore() {
    coreStarting = true;
    syncCoreButton();
    render("core", "action", "home.coreStarting");
    try {
      var token = await fetchJson("/control-token.json");
      await fetchJson("/api/core/start", { method: "POST", headers: { "X-PatchWarden-Control-Token": token.token } });
      await refresh();
    } catch (error) {
      lastCoreReady = false;
      var fallback = error.message + (error.nextSteps && error.nextSteps[0] ? " " + error.nextSteps[0] : "");
      render("core", "action", "home.startFailed", error.reasonCode || "start_failed", fallback);
      toastText(reasonText(error.reasonCode || "start_failed", fallback));
    } finally {
      coreStarting = false;
      syncCoreButton();
    }
  }
  function toastText(value) { var node = document.getElementById("toast"); node.textContent = value; node.classList.add("visible"); setTimeout(function () { node.classList.remove("visible"); }, 4000); }
  function toast(key) { toastText(tr(key)); }
  document.getElementById("startCore").addEventListener("click", startCore);
  document.getElementById("copyPrompt").addEventListener("click", function () { navigator.clipboard.writeText("Call health_check and report Core readiness, Watcher health, active profile, and the discovered tool count.").then(function () { toast("home.copied"); }); });
  var language = document.getElementById("language");
  window.addEventListener("patchwarden:i18nready", function () { language.value = i18n.getSelectedLanguage(); void refresh(); });
  language.addEventListener("change", function () { void i18n.setLanguage(language.value).then(refresh); });
  window.addEventListener("patchwarden:languagechange", function () { if (statusData) void refresh(); });
  if (window.lucide) window.lucide.createIcons();
})();
