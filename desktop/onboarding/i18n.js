(() => {
  const messages = {
    "zh-CN": {
      title: "设置 PatchWarden", hero: "准备本地安全工作区", stepsLabel: "设置步骤",
      stepWorkspace: "选择工作区", stepAgents: "检测本地 Agent", stepDoctor: "健康检查",
      privacy: "配置只保存在本机，不读取或保存 Token、Cookie 与浏览器登录态。",
      blockedTitle: "桌面服务暂时无法启动", openLogs: "打开日志目录", step1of3: "步骤 1 / 3",
      workspaceTitle: "选择使用方式与工作区", routeLabel: "MCP 使用方式",
      chatgptHelp: "通过 Secure MCP Tunnel 在 ChatGPT Plugins（旧称 Connector）中使用。",
      localMcp: "本地 MCP", localHelp: "仅配置本地客户端，可跳过 Platform Tunnel。",
      workspaceHelp: "选择一个包含项目的专用目录。磁盘根目录、用户主目录、桌面、下载和文档目录不会被接受。",
      notSelected: "尚未选择", chooseWorkspace: "选择工作区", next: "下一步", step2of3: "步骤 2 / 3",
      agentsTitle: "检测本地 Agent", agentsHelp: "检测受支持的本地 CLI，并从安全的本地配置字段读取可选模型。WindowsApps 桌面别名不会被当作 CLI。",
      detecting: "正在检测…", detectAgain: "重新检测", chooseFile: "选择文件",
      tunnelHelp: "未找到时可以继续进入只读控制台。稍后可在“设置”中查看安装和 SHA256 校验步骤。",
      back: "上一步", saveCheck: "保存并检查", step3of3: "步骤 3 / 3", doctorTitle: "运行健康检查",
      doctorRunning: "正在运行只读检查…", finishNote: "检查完成后将自动进入控制台。",
      notFound: "未找到", followDefault: "跟随 Agent 默认", customModel: "自定义模型 ID", available: "可用",
      unknownStartup: "未知启动错误", localSelected: "本地 MCP 路线已选择；可以跳过 Tunnel 配置",
      tunnelMissing: "未找到；可选择文件，或稍后在设置中完成", userSelected: "用户选择",
      saveFailed: "无法保存配置", doctorPassed: "检查完成，正在进入控制台…",
      doctorNeedsAction: "检查发现需要处理的项目，仍可进入只读控制台。", doctorNoOutput: "检查没有返回文本。",
      agentToggle: "启用 {name}", modelLabel: "{name} 模型", customModelLabel: "{name} 自定义模型 ID",
    },
    en: {
      title: "Set up PatchWarden", hero: "Prepare a secure local workspace", stepsLabel: "Setup steps",
      stepWorkspace: "Choose workspace", stepAgents: "Detect local agents", stepDoctor: "Health check",
      privacy: "Configuration stays on this device. PatchWarden does not read or store tokens, cookies, or browser sessions.",
      blockedTitle: "Desktop services cannot start right now", openLogs: "Open logs folder", step1of3: "Step 1 of 3",
      workspaceTitle: "Choose a connection and workspace", routeLabel: "MCP connection method",
      chatgptHelp: "Use Secure MCP Tunnel with ChatGPT Plugins (formerly Connector).",
      localMcp: "Local MCP", localHelp: "Configure only a local client and skip Platform Tunnel.",
      workspaceHelp: "Choose a dedicated project directory. Drive roots, your home, Desktop, Downloads, and Documents are rejected.",
      notSelected: "Not selected", chooseWorkspace: "Choose workspace", next: "Next", step2of3: "Step 2 of 3",
      agentsTitle: "Detect local agents", agentsHelp: "Detect supported local CLIs and read optional model IDs from bounded local settings. WindowsApps aliases are not treated as CLIs.",
      detecting: "Detecting…", detectAgain: "Detect again", chooseFile: "Choose file",
      tunnelHelp: "You may continue to the read-only console if it is missing. Installation and SHA256 verification remain available in Settings.",
      back: "Back", saveCheck: "Save and check", step3of3: "Step 3 of 3", doctorTitle: "Run health checks",
      doctorRunning: "Running read-only checks…", finishNote: "The Control Center opens when checks finish.",
      notFound: "Not found", followDefault: "Use agent default", customModel: "Custom model ID", available: "Available",
      unknownStartup: "Unknown startup error", localSelected: "Local MCP selected; Tunnel setup can be skipped",
      tunnelMissing: "Not found; choose a file or finish setup later in Settings", userSelected: "User selected",
      saveFailed: "Could not save configuration", doctorPassed: "Checks complete. Opening Control Center…",
      doctorNeedsAction: "Some checks need attention. The read-only console is still available.", doctorNoOutput: "No check output was returned.",
      agentToggle: "Enable {name}", modelLabel: "{name} model", customModelLabel: "Custom model ID for {name}",
    },
  };
  let locale = "zh-CN";
  const normalize = (value) => String(value || "").toLowerCase().startsWith("en") ? "en" : "zh-CN";
  const tr = (key, vars = {}) => {
    const template = messages[locale][key] || messages["zh-CN"][key] || key;
    return template.replace(/\{([a-zA-Z]+)\}/g, (_match, name) => String(vars[name] ?? ""));
  };
  const apply = () => {
    document.documentElement.lang = locale;
    document.querySelectorAll("[data-i18n]").forEach((node) => { node.textContent = tr(node.dataset.i18n); });
    document.querySelectorAll("[data-i18n-title]").forEach((node) => { node.title = tr(node.dataset.i18nTitle); });
    document.querySelectorAll("[data-i18n-aria-label]").forEach((node) => { node.setAttribute("aria-label", tr(node.dataset.i18nAriaLabel)); });
  };
  window.PatchWardenOnboardingI18n = Object.freeze({
    tr,
    setLocale(value) { locale = normalize(value); apply(); return locale; },
    getLocale() { return locale; },
  });
})();
