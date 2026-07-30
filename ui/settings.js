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
  var agentSettingsDirty = false;
  var lastAgentLoadAt = 0;
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

  var SAFE_MODEL_REASONS = new Set([
    "ok", "not_checked", "catalog_empty", "agent_unavailable", "refresh_unsupported",
    "refresh_timed_out", "refresh_failed", "unsupported_safe_probe", "probe_timed_out",
    "authentication_failed", "model_rejected", "probe_failed", "probe_output_invalid",
    "invalid_model", "save_failed"
  ]);

  function reasonText(reason) {
    var safeReason = SAFE_MODEL_REASONS.has(reason) ? reason : "unexpected_result";
    return tr("settings.modelReason." + safeReason);
  }

  function stateLine(labelKey, value) {
    var line = document.createElement("small"); line.className = "agent-state-line";
    var label = document.createElement("span"); label.className = "agent-state-label"; label.textContent = tr(labelKey) + ": ";
    var state = document.createElement("span"); state.textContent = value;
    line.append(label, state); return { line: line, state: state };
  }

  function environmentNames(value) {
    var names = []; var seen = new Set();
    value.split(",").map(function (name) { return name.trim(); }).filter(Boolean).forEach(function (name) {
      var key = name.toUpperCase(); if (!seen.has(key)) { seen.add(key); names.push(name); }
    });
    return names;
  }

  function catalogText(agent) {
    var catalog = agent.catalog || {};
    var refreshedAt = catalog.refreshedAt ? new Date(catalog.refreshedAt) : null;
    if (catalog.state === "cached" && refreshedAt && !Number.isNaN(refreshedAt.getTime())) return tr("settings.modelCatalogCached", { time: refreshedAt.toLocaleString() });
    if (catalog.state === "fresh") return tr("settings.modelCatalogCount", { count: (agent.models || []).length });
    if (catalog.state === "empty") return tr("settings.modelCatalogEmpty");
    if (catalog.state === "configured") return tr("settings.modelCatalogConfigured");
    if (catalog.state === "unavailable" || catalog.state === "unsupported") return reasonText(catalog.reasonCode);
    return tr("settings.modelCatalogNotChecked");
  }

  function renderAgents(catalog) {
    agentCatalog = catalog;
    agentSettingsList.replaceChildren();
    catalog.forEach(function (agent) {
      var row = document.createElement("div"); row.className = "agent-setting-row"; row.dataset.agentId = agent.id;
      var identity = document.createElement("label"); identity.className = "agent-identity";
      var enabled = document.createElement("input"); enabled.type = "checkbox"; enabled.className = "agent-enabled"; enabled.checked = agent.enabled; enabled.disabled = !agent.available;
      var details = document.createElement("span"); details.className = "agent-state-list"; var title = document.createElement("strong"); title.textContent = agent.displayName;
      var cliLine = stateLine("settings.agentCliState", agent.available ? (agent.commandLabel || tr("settings.agentAvailable")) : tr("settings.agentMissing"));
      var configSources = (agent.configSources || []).join(", ");
      var configLine = stateLine("settings.modelConfigSourceState", configSources || tr("settings.modelConfigSourceMissing"));
      var catalogLine = stateLine("settings.modelCatalogState", catalogText(agent)); var modelSource = catalogLine.state;
      var effectiveLine = stateLine("settings.modelEffectiveState", agent.effectiveModel || tr("settings.followAgentDefault"));
      var probeSupported = agent.id === "codex" || agent.id === "opencode" || agent.id === "claude";
      var initialProviderText = !probeSupported
        ? tr("settings.modelProviderNotAvailable")
        : agent.providerStatus === "not_checked" ? tr("settings.modelProviderNotChecked") : reasonText(agent.providerReasonCode);
      var providerLine = stateLine("settings.modelProviderState", initialProviderText); var providerStatus = providerLine.state;
      details.append(title, cliLine.line, configLine.line, catalogLine.line, effectiveLine.line, providerLine.line); identity.append(enabled, details);
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
      var refreshSupported = Boolean(agent.catalog && agent.catalog.strategy !== "config_only" && agent.catalog.refreshSupported);
      var refresh = document.createElement("button"); refresh.type = "button"; refresh.className = "agent-refresh-models"; refresh.title = tr(refreshSupported ? "settings.refreshModels" : "settings.reloadModels"); refresh.setAttribute("aria-label", refresh.title); refresh.disabled = refreshSupported && !agent.available; refresh.innerHTML = '<i data-lucide="refresh-cw"></i>';
      refresh.addEventListener("click", async function () {
        refresh.disabled = true; agentSettingsStatus.textContent = tr(refreshSupported ? "settings.refreshingModels" : "settings.reloadingModels", { agent: agent.displayName });
        try {
          var result = await (refreshSupported ? api.refreshAgentModels(agent.id) : api.discoverAgentModels(agent.id));
          var selected = model.value; Array.from(model.options).filter(function (option) { return option.value && option.value !== "__custom__"; }).forEach(function (option) { option.remove(); });
          var models = (result.models || []).slice();
          if (selected && selected !== "__custom__" && !models.some(function (item) { return item.id === selected; })) models.push({ id: selected, label: selected });
          models.sort(function (left, right) { return left.id.localeCompare(right.id); }).forEach(function (item) { var option = document.createElement("option"); option.value = item.id; option.textContent = item.label; model.insertBefore(option, model.lastElementChild); });
          model.value = Array.from(model.options).some(function (option) { return option.value === selected; }) ? selected : "";
          modelSource.textContent = result.reasonCode && result.reasonCode !== "ok" ? reasonText(result.reasonCode) : (models.length > 0 ? tr("settings.modelCatalogCount", { count: models.length }) : tr("settings.modelCatalogEmpty"));
          agentSettingsStatus.textContent = result.ok === false ? reasonText(result.reasonCode) : tr(refreshSupported ? "settings.modelsRefreshed" : "settings.modelsReloaded", { count: models.length });
          syncModelControls();
        } catch (error) { agentSettingsStatus.textContent = reasonText("refresh_failed"); }
        finally { refresh.disabled = refreshSupported && !agent.available; }
      });
      var lastProbeModel = agent.effectiveModel || ""; var lastProbeText = initialProviderText;
      function selectedModelId() { return model.value === "__custom__" ? custom.value.trim() : (model.value || agent.effectiveModel || ""); }
      function syncModelControls() {
        custom.classList.toggle("hidden", model.value !== "__custom__");
        verify.disabled = !probeSupported || !agent.available || !selectedModelId();
        providerStatus.textContent = !probeSupported
          ? tr("settings.modelProviderNotAvailable")
          : selectedModelId() && selectedModelId() === lastProbeModel ? lastProbeText : tr("settings.modelProviderNotChecked");
      }
      model.addEventListener("change", syncModelControls); custom.addEventListener("input", syncModelControls);
      var verify = document.createElement("button"); verify.type = "button"; verify.className = "agent-verify-model"; verify.title = tr(probeSupported ? "settings.verifyModel" : "settings.modelProviderNotAvailable"); verify.setAttribute("aria-label", verify.title); verify.innerHTML = '<i data-lucide="shield-check"></i>';
      verify.addEventListener("click", async function () {
        var modelId = selectedModelId(); if (!probeSupported || !modelId) return;
        verify.disabled = true; agentSettingsStatus.textContent = tr("settings.verifyingModel", { agent: agent.displayName });
        try {
          var result = await api.verifyAgentModel({ agentId: agent.id, modelId: modelId });
          lastProbeModel = modelId; lastProbeText = result.result ? reasonText(result.result.reasonCode) : reasonText(result.reasonCode);
          providerStatus.textContent = lastProbeText; agentSettingsStatus.textContent = lastProbeText;
        } catch (error) { agentSettingsStatus.textContent = reasonText("probe_failed"); }
        finally { syncModelControls(); }
      });
      var environmentGroup = document.createElement("label"); environmentGroup.className = "agent-env-group";
      var environmentLabel = document.createElement("span"); environmentLabel.className = "agent-env-label"; environmentLabel.textContent = tr("settings.envAllowlistLabel");
      var environment = document.createElement("input"); environment.className = "agent-env-allowlist"; environment.placeholder = tr("settings.envAllowlistPlaceholder"); environment.setAttribute("autocomplete", "off"); environment.spellcheck = false; environment.value = (agent.envAllowlist || []).map(function (item) { return item.name; }).join(", "); environment.disabled = !agent.available;
      var presentCount = (agent.envAllowlist || []).filter(function (item) { return item.present; }).length;
      var environmentHelp = document.createElement("small"); environmentHelp.className = "agent-env-help"; environmentHelp.textContent = tr("settings.envAllowlistState", { present: presentCount, total: (agent.envAllowlist || []).length });
      environmentGroup.append(environmentLabel, environment, environmentHelp);
      [enabled, model, custom, environment].forEach(function (control) { control.addEventListener("change", function () { agentSettingsDirty = true; }); });
      custom.addEventListener("input", function () { agentSettingsDirty = true; });
      environment.addEventListener("input", function () { agentSettingsDirty = true; });
      syncModelControls(); controls.append(model, custom, refresh, verify, environmentGroup); row.append(identity, controls); agentSettingsList.append(row);
    });
    if (window.lucide) window.lucide.createIcons();
  }

  async function loadAgents(redetect) {
    agentSettingsStatus.textContent = tr(redetect ? "settings.detectingAgents" : "settings.loadingAgents");
    try { renderAgents(await (redetect ? api.detectAgents() : api.getAgentSettings())); agentSettingsStatus.textContent = ""; agentSettingsDirty = false; lastAgentLoadAt = Date.now(); }
    catch (error) { agentSettingsStatus.textContent = reasonText("refresh_failed"); }
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
  window.addEventListener("focus", function () {
    if (!agentSettingsDirty && Date.now() - lastAgentLoadAt > 2000) void loadAgents(false);
  });
  document.getElementById("detectAgents").addEventListener("click", function () { void loadAgents(true); });
  document.getElementById("saveAgents").addEventListener("click", async function () {
    var agents;
    try {
      agents = Array.from(agentSettingsList.querySelectorAll(".agent-setting-row")).map(function (row) {
        var select = row.querySelector(".agent-model"); var custom = row.querySelector(".agent-custom-model"); var environment = row.querySelector(".agent-env-allowlist");
        var names = environmentNames(environment.value);
        if (names.some(function (name) { return !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name); })) throw new Error("invalid_environment_name");
        return { id: row.dataset.agentId, enabled: row.querySelector(".agent-enabled").checked, model: select.value === "__custom__" ? custom.value.trim() : select.value || null, envAllowlist: names };
      });
    } catch (error) { agentSettingsStatus.textContent = tr("settings.envAllowlistInvalid"); return; }
    agentSettingsStatus.textContent = tr("settings.savingAgents");
    try { var result = await api.saveAgentSettings({ agents: agents }); if (result.ok === false) { agentSettingsStatus.textContent = reasonText(result.reasonCode); return; } agentSettingsStatus.textContent = tr(result.restartRequired ? "settings.savedRestart" : "settings.savedReload"); agentSettingsDirty = false; }
    catch (error) { agentSettingsStatus.textContent = reasonText("save_failed"); }
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
