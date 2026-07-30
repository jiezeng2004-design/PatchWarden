(() => {
  const api = window.patchwardenDesktop;
  const i18n = window.PatchWardenOnboardingI18n;
  const tr = (key, vars) => i18n ? i18n.tr(key, vars) : key;
  let workspaceRoot = null;
  let agents = [];
  let tunnelClientPath = null;

  const byId = (id) => document.getElementById(id);
  const panels = [byId("step1"), byId("step2"), byId("step3")];

  function showStep(step) {
    panels.forEach((panel, index) => panel.classList.toggle("hidden", index !== step - 1));
    document.querySelectorAll("[data-step]").forEach((item) => {
      const active = Number(item.dataset.step) === step;
      item.classList.toggle("active", active);
      if (active) item.setAttribute("aria-current", "step");
      else item.removeAttribute("aria-current");
    });
    panels[step - 1]?.querySelector("h2")?.focus();
  }

  function renderAgents() {
    const list = byId("agentList");
    list.replaceChildren();
    for (const agent of agents) {
      const row = document.createElement("div");
      row.className = "agent-row";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.name = "agent";
      checkbox.value = agent.name;
      checkbox.checked = agent.available;
      checkbox.disabled = !agent.available;
      checkbox.setAttribute("aria-label", tr("agentToggle", { name: agent.displayName || agent.name }));
      const details = document.createElement("div");
      const title = document.createElement("div");
      title.className = "agent-name";
      title.textContent = agent.displayName || agent.name;
      const path = document.createElement("div");
      path.className = "agent-detail";
      path.textContent = agent.commandLabel || agent.reason || tr("notFound");
      details.append(title, path);
      const model = document.createElement("select");
      model.className = "agent-model";
      model.dataset.agentId = agent.id || agent.name;
      model.setAttribute("aria-label", tr("modelLabel", { name: agent.displayName || agent.name }));
      const defaultOption = document.createElement("option"); defaultOption.value = ""; defaultOption.textContent = tr("followDefault"); model.append(defaultOption);
      for (const item of agent.models || []) { const option = document.createElement("option"); option.value = item.id; option.textContent = item.label; model.append(option); }
      const customOption = document.createElement("option"); customOption.value = "__custom__"; customOption.textContent = tr("customModel"); model.append(customOption);
      const custom = document.createElement("input"); custom.className = "agent-custom-model hidden"; custom.placeholder = "provider/model"; custom.spellcheck = false;
      custom.setAttribute("aria-label", tr("customModelLabel", { name: agent.displayName || agent.name }));
      model.addEventListener("change", () => custom.classList.toggle("hidden", model.value !== "__custom__"));
      const badge = document.createElement("span");
      badge.className = `badge${agent.available ? "" : " missing"}`;
      badge.textContent = agent.available ? tr("available") : tr("notFound");
      const controls = document.createElement("div"); controls.className = "agent-model-controls"; controls.append(model, custom);
      row.append(checkbox, details, controls, badge);
      list.append(row);
    }
  }

  async function initialize() {
    if (!api) return;
    const state = await api.getState();
    i18n?.setLocale(state.resolvedLanguage);
    if (state.mode === "blocked") {
      panels.forEach((panel) => panel.classList.add("hidden"));
      byId("blockedPanel").classList.remove("hidden");
      byId("blockedReason").textContent = state.reason || tr("unknownStartup");
    } else {
      showStep(1);
    }
  }

  byId("chooseWorkspace").addEventListener("click", async () => {
    workspaceRoot = await api.chooseWorkspace();
    if (!workspaceRoot) return;
    byId("workspacePath").textContent = workspaceRoot;
    byId("workspaceError").textContent = "";
    byId("toAgents").disabled = false;
  });

  byId("toAgents").addEventListener("click", async () => {
    showStep(2);
    const connectionMode = document.querySelector("input[name='connectionMode']:checked").value;
    const results = await Promise.all([api.detectAgents(), connectionMode === "chatgpt" ? api.detectTunnelClient() : Promise.resolve({ available: false, localRoute: true })]);
    agents = results[0];
    renderAgents();
    if (results[1].localRoute) {
      tunnelClientPath = null;
      byId("tunnelStatus").textContent = tr("localSelected");
    } else renderTunnel(results[1]);
  });

  function renderTunnel(result) {
    if (result && result.available) {
      tunnelClientPath = result.path;
      byId("tunnelStatus").textContent = result.path + "（" + result.source + "）";
    } else {
      tunnelClientPath = null;
      byId("tunnelStatus").textContent = tr("tunnelMissing");
    }
  }

  byId("detectTunnel").addEventListener("click", async () => renderTunnel(await api.detectTunnelClient()));
  byId("chooseTunnel").addEventListener("click", async () => {
    const result = await api.chooseTunnelClient();
    if (result) renderTunnel(result.ok ? { available: true, path: result.path, source: tr("userSelected") } : { available: false });
  });

  document.querySelector("[data-back='1']").addEventListener("click", () => showStep(1));

  byId("saveSetup").addEventListener("click", async () => {
    const enabledAgents = Array.from(document.querySelectorAll("input[name='agent']:checked")).map((input) => input.value);
    const agentModels = {};
    document.querySelectorAll(".agent-model").forEach((select) => {
      const custom = select.parentElement.querySelector(".agent-custom-model");
      agentModels[select.dataset.agentId] = select.value === "__custom__" ? custom.value.trim() : select.value || null;
    });
    const result = await api.saveSetup({ workspaceRoot, enabledAgents, agentModels });
    if (!result.ok) {
      showStep(1);
      byId("workspaceError").textContent = result.error || tr("saveFailed");
      return;
    }
    if (tunnelClientPath) await api.setRuntimeSettings({ tunnelClientPath });
    await api.setPreferences({ connectionMode: document.querySelector("input[name='connectionMode']:checked").value });
    showStep(3);
    const doctor = await api.runDoctor();
    const doctorMessage = document.createElement("span");
    doctorMessage.textContent = doctor.ok ? tr("doctorPassed") : tr("doctorNeedsAction");
    byId("doctorStatus").replaceChildren(doctorMessage);
    const counts = byId("doctorCounts");
    counts.classList.remove("hidden");
    counts.replaceChildren(...[["OK", doctor.counts.ok], ["WARN", doctor.counts.warn], ["FAIL", doctor.counts.fail]].map(([label, value]) => {
      const item = document.createElement("span");
      item.className = "count";
      item.textContent = `${label} ${value}`;
      return item;
    }));
    const output = byId("doctorOutput");
    output.textContent = doctor.output || tr("doctorNoOutput");
    output.classList.remove("hidden");
  });

  byId("openLogsBlocked").addEventListener("click", () => api.openPath("logs"));
  void initialize();
})();
