(() => {
  const api = window.patchwardenDesktop;
  let workspaceRoot = null;
  let agents = [];
  let tunnelClientPath = null;

  const byId = (id) => document.getElementById(id);
  const panels = [byId("step1"), byId("step2"), byId("step3")];

  function showStep(step) {
    panels.forEach((panel, index) => panel.classList.toggle("hidden", index !== step - 1));
    document.querySelectorAll("[data-step]").forEach((item) => item.classList.toggle("active", Number(item.dataset.step) === step));
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
      const details = document.createElement("div");
      const title = document.createElement("div");
      title.className = "agent-name";
      title.textContent = agent.displayName || agent.name;
      const path = document.createElement("div");
      path.className = "agent-detail";
      path.textContent = agent.commandLabel || agent.reason || "未找到";
      details.append(title, path);
      const model = document.createElement("select");
      model.className = "agent-model";
      model.dataset.agentId = agent.id || agent.name;
      const defaultOption = document.createElement("option"); defaultOption.value = ""; defaultOption.textContent = "跟随 Agent 默认"; model.append(defaultOption);
      for (const item of agent.models || []) { const option = document.createElement("option"); option.value = item.id; option.textContent = item.label; model.append(option); }
      const customOption = document.createElement("option"); customOption.value = "__custom__"; customOption.textContent = "自定义模型 ID"; model.append(customOption);
      const custom = document.createElement("input"); custom.className = "agent-custom-model hidden"; custom.placeholder = "provider/model"; custom.spellcheck = false;
      model.addEventListener("change", () => custom.classList.toggle("hidden", model.value !== "__custom__"));
      const badge = document.createElement("span");
      badge.className = `badge${agent.available ? "" : " missing"}`;
      badge.textContent = agent.available ? "可用" : "未找到";
      const controls = document.createElement("div"); controls.className = "agent-model-controls"; controls.append(model, custom);
      row.append(checkbox, details, controls, badge);
      list.append(row);
    }
  }

  async function initialize() {
    if (!api) return;
    const state = await api.getState();
    if (state.mode === "blocked") {
      panels.forEach((panel) => panel.classList.add("hidden"));
      byId("blockedPanel").classList.remove("hidden");
      byId("blockedReason").textContent = state.reason || "未知启动错误";
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
      byId("tunnelStatus").textContent = "本地 MCP 路线已选择；可以跳过 Tunnel 配置";
    } else renderTunnel(results[1]);
  });

  function renderTunnel(result) {
    if (result && result.available) {
      tunnelClientPath = result.path;
      byId("tunnelStatus").textContent = result.path + "（" + result.source + "）";
    } else {
      tunnelClientPath = null;
      byId("tunnelStatus").textContent = "未找到；可选择文件，或稍后在设置中完成";
    }
  }

  byId("detectTunnel").addEventListener("click", async () => renderTunnel(await api.detectTunnelClient()));
  byId("chooseTunnel").addEventListener("click", async () => {
    const result = await api.chooseTunnelClient();
    if (result) renderTunnel(result.ok ? { available: true, path: result.path, source: "用户选择" } : { available: false });
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
      byId("workspaceError").textContent = result.error || "无法保存配置";
      return;
    }
    if (tunnelClientPath) await api.setRuntimeSettings({ tunnelClientPath });
    await api.setPreferences({ connectionMode: document.querySelector("input[name='connectionMode']:checked").value });
    showStep(3);
    const doctor = await api.runDoctor();
    byId("doctorStatus").innerHTML = doctor.ok ? "<span>检查完成，正在进入控制台…</span>" : "<span>检查发现需要处理的项目，仍可进入只读控制台。</span>";
    const counts = byId("doctorCounts");
    counts.classList.remove("hidden");
    counts.innerHTML = `<span class="count">OK ${doctor.counts.ok}</span><span class="count">WARN ${doctor.counts.warn}</span><span class="count">FAIL ${doctor.counts.fail}</span>`;
    const output = byId("doctorOutput");
    output.textContent = doctor.output || "检查没有返回文本。";
    output.classList.remove("hidden");
  });

  byId("openLogsBlocked").addEventListener("click", () => api.openPath("logs"));
  void initialize();
})();
