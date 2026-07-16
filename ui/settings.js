(function () {
  var api = window.patchwardenDesktop;
  if (!api) { window.location.replace("/pages/dashboard.html"); return; }
  var theme = document.getElementById("theme");
  var language = document.getElementById("language");
  var closeBehavior = document.getElementById("closeBehavior");
  var doctorOutput = document.getElementById("doctorOutput");
  var tunnelClientPath = document.getElementById("tunnelClientPath");
  var enableDirectProfile = document.getElementById("enableDirectProfile");
  var proxyScope = document.getElementById("proxyScope");
  var coreProxyMode = document.getElementById("coreProxyMode");
  var coreProxyUrl = document.getElementById("coreProxyUrl");
  var directProxyMode = document.getElementById("directProxyMode");
  var directProxyUrl = document.getElementById("directProxyUrl");
  var directProxyEndpoint = document.getElementById("directProxyEndpoint");
  var runtimeStatus = document.getElementById("runtimeStatus");
  var selectedTunnelPath = null;
  var tunnelMode = document.getElementById("tunnelMode");
  var tunnelId = document.getElementById("tunnelId");
  var runtimeKey = document.getElementById("runtimeKey");
  var credentialState = document.getElementById("credentialState");
  var provisionStatus = document.getElementById("provisionStatus");
  var provisionTunnel = document.getElementById("provisionTunnel");
  var revalidateCredential = document.getElementById("revalidateCredential");
  var i18n = window.PatchWardenI18n;

  var runtimeMessage = null;
  function tr(key, params) { return i18n ? i18n.t(key, params) : key; }
  function setRuntimeMessage(key, params) {
    runtimeMessage = { key: key, params: params || {} };
    runtimeStatus.textContent = tr(key, params);
  }

  async function refreshTunnelStatus() {
    var status = await api.getTunnelSetupStatus(tunnelMode.value);
    credentialState.textContent = tr(status.credential_configured ? "settings.credentialConfigured" : "settings.credentialMissing");
    tunnelId.placeholder = status.tunnel_id_masked || "tun_...";
    provisionTunnel.querySelector("span").textContent = tr(tunnelMode.value === "direct" ? "settings.configureDirect" : "settings.configureCore");
    return status;
  }

  function syncProxyControls() {
    directProxyEndpoint.classList.toggle("hidden", proxyScope.value !== "separate");
    coreProxyUrl.disabled = coreProxyMode.value !== "manual";
    directProxyUrl.disabled = directProxyMode.value !== "manual";
  }

  function renderRuntime(settings) {
    selectedTunnelPath = settings.tunnelClientPath || null;
    tunnelClientPath.textContent = selectedTunnelPath || tr("settings.tunnelNotConfigured");
    enableDirectProfile.checked = settings.enableDirectProfile === true;
    proxyScope.value = settings.tunnelProxy.scope;
    coreProxyMode.value = settings.tunnelProxy.core.mode;
    coreProxyUrl.value = settings.tunnelProxy.core.url || "";
    directProxyMode.value = settings.tunnelProxy.direct.mode;
    directProxyUrl.value = settings.tunnelProxy.direct.url || "";
    syncProxyControls();
  }

  api.getState().then(function (state) {
    document.getElementById("configPath").textContent = state.configPath || tr("settings.notConfigured");
    theme.value = state.preferences.theme;
    language.value = state.preferences.language || "system";
    closeBehavior.value = state.preferences.closeBehavior;
    if (state.runtimeSettings) renderRuntime(state.runtimeSettings);
  });
  api.getRuntimeSettings().then(function (settings) {
    renderRuntime(settings);
    if (!settings.tunnelClientPath) {
      setRuntimeMessage("settings.autoDetecting");
      return api.detectTunnelClient().then(function (result) {
        if (result.available) {
          selectedTunnelPath = result.path;
          tunnelClientPath.textContent = tr("settings.autoDetectedPath", { path: result.path, source: result.source });
          setRuntimeMessage("settings.autoDetected");
        } else {
          setRuntimeMessage("settings.tunnelNotFound");
        }
      });
    }
  }).catch(function (error) { runtimeStatus.textContent = error.message; });
  theme.addEventListener("change", function () {
    api.setPreferences({ theme: theme.value }).then(function () {
      if (window.patchwardenApplyTheme) window.patchwardenApplyTheme(theme.value);
    });
  });
  language.addEventListener("change", function () { if (i18n) void i18n.setLanguage(language.value).then(refreshTunnelStatus); });
  closeBehavior.addEventListener("change", function () { api.setPreferences({ closeBehavior: closeBehavior.value }); });
  document.getElementById("openConfig").addEventListener("click", function () { api.openPath("config"); });
  document.getElementById("openLogs").addEventListener("click", function () { api.openPath("logs"); });
  document.getElementById("runDoctor").addEventListener("click", async function () {
    doctorOutput.textContent = tr("settings.doctorChecking"); doctorOutput.classList.remove("hidden");
    try { var result = await api.runDoctor(); doctorOutput.textContent = result.output || tr("settings.doctorDone"); }
    catch (error) { doctorOutput.textContent = tr("settings.doctorFailed", { error: error.message }); }
  });
  document.getElementById("detectTunnel").addEventListener("click", async function () {
    setRuntimeMessage("settings.detecting");
    var result = await api.detectTunnelClient();
    if (result.available) { selectedTunnelPath = result.path; tunnelClientPath.textContent = tr("settings.detectedPath", { path: result.path, source: result.source }); setRuntimeMessage("settings.tunnelFound"); }
    else setRuntimeMessage("settings.tunnelNotFound");
  });
  document.getElementById("chooseTunnel").addEventListener("click", async function () {
    var result = await api.chooseTunnelClient();
    if (!result) return;
    if (!result.ok) { runtimeStatus.textContent = result.error; return; }
    selectedTunnelPath = result.path; tunnelClientPath.textContent = result.path; setRuntimeMessage("settings.tunnelSelected");
  });
  [proxyScope, coreProxyMode, directProxyMode].forEach(function (element) { element.addEventListener("change", syncProxyControls); });
  document.getElementById("saveRuntime").addEventListener("click", async function () {
    setRuntimeMessage("settings.saving");
    try {
      var result = await api.setRuntimeSettings({
        tunnelClientPath: selectedTunnelPath,
        enableDirectProfile: enableDirectProfile.checked,
        tunnelProxy: {
          scope: proxyScope.value,
          core: { mode: coreProxyMode.value, url: coreProxyMode.value === "manual" ? coreProxyUrl.value : undefined },
          direct: { mode: directProxyMode.value, url: directProxyMode.value === "manual" ? directProxyUrl.value : undefined }
        }
      });
      setRuntimeMessage(result.restartRequired ? "settings.savedRestart" : "settings.savedReload");
    } catch (error) { setRuntimeMessage("settings.saveFailed", { error: error.message }); }
  });
  document.getElementById("changeWorkspace").addEventListener("click", async function () {
    var workspaceRoot = await api.chooseWorkspace();
    if (!workspaceRoot) return;
    var agents = await api.detectAgents();
    var result = await api.saveSetup({ workspaceRoot: workspaceRoot, enabledAgents: agents.filter(function (a) { return a.available; }).map(function (a) { return a.name; }) });
    document.getElementById("workspacePath").textContent = result.ok ? result.workspaceRoot : result.error;
  });
  tunnelMode.addEventListener("change", function () { tunnelId.value = ""; runtimeKey.value = ""; void refreshTunnelStatus(); });
  provisionTunnel.addEventListener("click", async function () {
    provisionStatus.textContent = tr("settings.provisioning");
    provisionTunnel.disabled = true;
    try {
      var result = await api.provisionTunnelProfile({ mode: tunnelMode.value, tunnelId: tunnelId.value, runtimeKey: runtimeKey.value });
      runtimeKey.value = "";
      if (result.ok) {
        tunnelId.value = "";
        provisionStatus.textContent = tr("settings.provisioned");
      } else {
        provisionStatus.textContent = tr("reason." + result.reason_code);
      }
      await refreshTunnelStatus();
    } catch (error) {
      runtimeKey.value = "";
      provisionStatus.textContent = error.message;
    } finally {
      provisionTunnel.disabled = false;
    }
  });
  revalidateCredential.addEventListener("click", async function () {
    provisionStatus.textContent = tr("settings.revalidating");
    revalidateCredential.disabled = true;
    provisionTunnel.disabled = true;
    try {
      var result = await api.revalidateTunnelProfile(tunnelMode.value);
      provisionStatus.textContent = result.ok ? tr("settings.revalidated") : tr("reason." + result.reason_code);
      await refreshTunnelStatus();
    } catch (error) {
      provisionStatus.textContent = error.message;
    } finally {
      revalidateCredential.disabled = false;
      provisionTunnel.disabled = false;
    }
  });
  document.getElementById("forgetCredential").addEventListener("click", async function () {
    if (!window.confirm(tr("settings.confirmForget"))) return;
    var result = await api.forgetTunnelCredential();
    provisionStatus.textContent = result.ok ? tr("settings.forgotten") : tr("reason.credential_forget_failed");
    runtimeKey.value = "";
    await refreshTunnelStatus();
  });
  window.addEventListener("patchwarden:i18nready", function () { language.value = i18n.getSelectedLanguage(); void refreshTunnelStatus(); });
  window.addEventListener("patchwarden:languagechange", function () {
    if (runtimeMessage) runtimeStatus.textContent = tr(runtimeMessage.key, runtimeMessage.params);
    void refreshTunnelStatus();
    void api.getRuntimeSettings().then(renderRuntime);
  });
  if (window.lucide) window.lucide.createIcons();
})();
