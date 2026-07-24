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
  var agentCatalog = [];
  var agentSettingsList = document.getElementById("agentSettingsList");
  var agentSettingsStatus = document.getElementById("agentSettingsStatus");

  var runtimeMessage = null;
  function tr(key, params) { return i18n ? i18n.t(key, params) : key; }
  function setRuntimeMessage(key, params) {
    runtimeMessage = { key: key, params: params || {} };
    runtimeStatus.textContent = tr(key, params);
  }

  function addModelOption(select, value, label) {
    var option = document.createElement("option"); option.value = value; option.textContent = label; select.appendChild(option);
  }

  function renderAgents(catalog) {
    agentCatalog = catalog;
    agentSettingsList.replaceChildren();
    catalog.forEach(function (agent) {
      var row = document.createElement("div"); row.className = "agent-setting-row"; row.dataset.agentId = agent.id;
      var identity = document.createElement("label"); identity.className = "agent-identity";
      var enabled = document.createElement("input"); enabled.type = "checkbox"; enabled.className = "agent-enabled"; enabled.checked = agent.enabled; enabled.disabled = !agent.available;
      var details = document.createElement("span"); var title = document.createElement("strong"); title.textContent = agent.displayName;
      var status = document.createElement("small"); status.textContent = agent.available ? (agent.commandLabel || tr("settings.agentAvailable")) : (agent.reason || tr("settings.agentMissing"));
      details.append(title, status); identity.append(enabled, details);
      var controls = document.createElement("div"); controls.className = "agent-controls";
      var model = document.createElement("select"); model.className = "agent-model"; addModelOption(model, "", tr("settings.followAgentDefault"));
      (agent.models || []).forEach(function (item) { addModelOption(model, item.id, item.label); });
      addModelOption(model, "__custom__", tr("settings.customModel"));
      var custom = document.createElement("input"); custom.className = "agent-custom-model hidden"; custom.placeholder = tr("settings.modelIdPlaceholder"); custom.spellcheck = false;
      if (agent.selectedModel) {
        if ((agent.models || []).some(function (item) { return item.id === agent.selectedModel; })) model.value = agent.selectedModel;
        else { model.value = "__custom__"; custom.value = agent.selectedModel; custom.classList.remove("hidden"); }
      }
      model.disabled = !agent.available; custom.disabled = !agent.available;
      model.addEventListener("change", function () { custom.classList.toggle("hidden", model.value !== "__custom__"); });
      var refresh = document.createElement("button"); refresh.type = "button"; refresh.title = tr("settings.refreshModels"); refresh.disabled = !agent.available || !agent.supportsModelRefresh; refresh.innerHTML = '<i data-lucide="refresh-cw"></i>';
      refresh.addEventListener("click", async function () {
        refresh.disabled = true; agentSettingsStatus.textContent = tr("settings.refreshingModels", { agent: agent.displayName });
        try {
          var result = await api.refreshAgentModels(agent.id);
          var selected = model.value; Array.from(model.options).filter(function (option) { return option.value && option.value !== "__custom__"; }).forEach(function (option) { option.remove(); });
          (result.models || []).forEach(function (item) { var option = document.createElement("option"); option.value = item.id; option.textContent = item.label; model.insertBefore(option, model.lastElementChild); });
          model.value = Array.from(model.options).some(function (option) { return option.value === selected; }) ? selected : "";
          agentSettingsStatus.textContent = tr("settings.modelsRefreshed", { count: (result.models || []).length });
        } catch (error) { agentSettingsStatus.textContent = error.message; }
        finally { refresh.disabled = false; }
      });
      controls.append(model, custom, refresh); row.append(identity, controls); agentSettingsList.append(row);
    });
    if (window.lucide) window.lucide.createIcons();
  }

  async function loadAgents(redetect) {
    agentSettingsStatus.textContent = tr(redetect ? "settings.detectingAgents" : "settings.loadingAgents");
    try { renderAgents(await (redetect ? api.detectAgents() : api.getAgentSettings())); agentSettingsStatus.textContent = ""; }
    catch (error) { agentSettingsStatus.textContent = error.message; }
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

  async function initializeSettings() {
    try {
      var state = await api.getState();
      var settings = state.runtimeSettings || await api.getRuntimeSettings();
      renderRuntime(settings);
      document.getElementById("configPath").textContent = state.configPath || tr("settings.notConfigured");
      document.getElementById("workspacePath").textContent = state.workspaceRoot || tr("settings.workspaceHelp");
      theme.value = state.preferences.theme;
      language.value = state.preferences.language || "system";
      closeBehavior.value = state.preferences.closeBehavior;

      if (!settings.tunnelClientPath && state.tunnelClient && state.tunnelClient.available) {
        selectedTunnelPath = state.tunnelClient.path;
        tunnelClientPath.textContent = tr("settings.autoDetectedPath", { path: state.tunnelClient.path, source: state.tunnelClient.source });
        setRuntimeMessage("settings.autoDetected");
      } else if (!settings.tunnelClientPath) {
        setRuntimeMessage("settings.autoDetecting");
        var detected = await api.detectTunnelClient();
        if (detected.available) {
          selectedTunnelPath = detected.path;
          tunnelClientPath.textContent = tr("settings.autoDetectedPath", { path: detected.path, source: detected.source });
          setRuntimeMessage("settings.autoDetected");
        } else {
          setRuntimeMessage("settings.tunnelNotFound");
        }
      }
    } catch (error) {
      runtimeStatus.textContent = error && error.message ? error.message : tr("settings.loadFailed");
    }
  }
  void initializeSettings();
  void loadAgents(false);
  document.getElementById("detectAgents").addEventListener("click", function () { void loadAgents(true); });
  document.getElementById("saveAgents").addEventListener("click", async function () {
    var agents = Array.from(agentSettingsList.querySelectorAll(".agent-setting-row")).map(function (row) {
      var select = row.querySelector(".agent-model"); var custom = row.querySelector(".agent-custom-model");
      return { id: row.dataset.agentId, enabled: row.querySelector(".agent-enabled").checked, model: select.value === "__custom__" ? custom.value.trim() : select.value || null };
    });
    agentSettingsStatus.textContent = tr("settings.savingAgents");
    try { var result = await api.saveAgentSettings({ agents: agents }); agentSettingsStatus.textContent = tr(result.restartRequired ? "settings.savedRestart" : "settings.savedReload"); }
    catch (error) { agentSettingsStatus.textContent = error.message; }
  });
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
    var agents = await api.getAgentSettings();
    var enabled = agents.filter(function (a) { return a.enabled && a.available; });
    var models = {}; enabled.forEach(function (a) { models[a.id] = a.selectedModel || null; });
    var result = await api.saveSetup({ workspaceRoot: workspaceRoot, enabledAgents: enabled.map(function (a) { return a.id; }), agentModels: models });
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
