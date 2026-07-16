(function () {
  "use strict";
  var STORAGE_KEY = "patchwarden.language";
  var dictionaries = {
    "zh-CN": {
      "app.title": "PatchWarden",
      "nav.gettingStarted": "开始使用",
      "nav.dashboard": "高级控制台",
      "nav.tasks": "任务面板",
      "nav.workspace": "工作区",
      "nav.audit": "审计日志",
      "nav.direct": "Direct 会话",
      "nav.logs": "日志",
      "nav.settings": "设置",
      "language.label": "语言",
      "language.system": "跟随 Windows",
      "language.zh": "简体中文",
      "language.en": "English",
      "home.title": "开始使用 PatchWarden",
      "home.subtitle": "按顺序完成四项检查。Direct 是可选高级能力，不会阻止 Core 启动。",
      "home.workspace": "工作区与 Agent",
      "home.platform": "Platform / Tunnel",
      "home.core": "Core 服务",
      "home.chatgpt": "ChatGPT App",
      "home.checking": "正在检查…",
      "home.ready": "已就绪",
      "home.needsAction": "需要操作",
      "home.manual": "需要人工验证",
      "home.workspaceReady": "工作区有效，至少一个本地 Agent 可用。",
      "home.workspaceMissing": "请先选择安全工作区并注册可用 Agent。",
      "home.tunnelReady": "程序、Core profile 与 DPAPI 凭据均已配置。",
      "home.tunnelMissing": "请配置 tunnel-client、Tunnel ID 和专用 runtime API key。",
      "home.localRoute": "本地 MCP 路线无需配置 Platform Tunnel。",
      "home.coreReady": "Core、Tunnel 与 Watcher 均已就绪。",
      "home.coreMissing": "Core 尚未完全就绪。请启动并查看具体失败原因。",
      "home.chatgptManual": "在 ChatGPT Settings → Plugins 创建 developer-mode app，选择 Tunnel，并在新对话调用 health_check。",
      "home.openSettings": "打开设置",
      "home.openPlatform": "打开 Platform Tunnel",
      "home.startCore": "启动 Core",
      "home.coreRunning": "Core 已启动",
      "home.startingCore": "正在启动…",
      "home.coreStarting": "启动命令已提交，正在等待 Tunnel 和 Watcher 通过就绪检查。",
      "home.startFailed": "Core 启动失败，请按下方原因处理后重试。",
      "home.copyPrompt": "复制测试提示",
      "home.copied": "已复制 health_check 测试提示",
      "home.docs": "官方与项目指南",
      "home.secureGuide": "Secure MCP Tunnel 官方指南",
      "home.pluginsGuide": "ChatGPT Plugins",
      "home.readmeZh": "中文 README",
      "home.readmeEn": "English README",
      "settings.title": "设置",
      "settings.pageTitle": "设置 — PatchWarden",
      "settings.appearance": "外观与窗口",
      "settings.localAgents": "本地 Agent 与模型",
      "settings.localAgentsHelp": "只注册检测到的受支持 CLI；模型来自本地安全配置字段，联网刷新需手动触发。",
      "settings.detectAgents": "重新检测",
      "settings.loadingAgents": "正在读取本地 Agent…",
      "settings.detectingAgents": "正在重新检测本地 Agent…",
      "settings.saveAgents": "保存 Agent 设置",
      "settings.savingAgents": "正在保存 Agent 设置…",
      "settings.agentAvailable": "CLI 可用",
      "settings.agentMissing": "未找到 CLI",
      "settings.followAgentDefault": "跟随 Agent 默认",
      "settings.customModel": "自定义模型 ID",
      "settings.modelIdPlaceholder": "provider/model",
      "settings.refreshModels": "刷新模型列表",
      "settings.refreshingModels": "正在刷新 {agent} 模型…",
      "settings.modelsRefreshed": "已发现 {count} 个模型",
      "settings.theme": "主题",
      "settings.themeHelp": "跟随 Windows，或固定使用浅色、深色。",
      "settings.themeSystem": "跟随系统",
      "settings.themeLight": "浅色",
      "settings.themeDark": "深色",
      "settings.languageHelp": "首次跟随 Windows；手动选择后跨页面和重启保留。",
      "settings.closeWindow": "关闭窗口",
      "settings.closeWindowHelp": "默认隐藏到系统托盘，后台服务保持可用。",
      "settings.closeToTray": "最小化到托盘",
      "settings.closeQuit": "退出桌面应用",
      "settings.mcpTunnel": "MCP 与隧道",
      "settings.tunnelUndetected": "尚未检测",
      "settings.detect": "检测",
      "settings.choose": "选择",
      "settings.directHelp": "启用后才会暴露 Direct 编辑工具并允许启动 Direct 隧道。",
      "settings.enable": "启用",
      "settings.proxy": "代理配置",
      "settings.proxyHelp": "使用环境代理、不使用代理，或填写不含凭据的代理 URL。",
      "settings.proxyShared": "Core / Direct 共用",
      "settings.proxySeparate": "分别配置",
      "settings.proxyEnvironment": "使用环境代理",
      "settings.proxyNone": "不使用代理",
      "settings.proxyManual": "手动代理",
      "settings.saveRuntime": "保存运行设置",
      "settings.installSummary": "没有 tunnel-client.exe？查看安装步骤",
      "settings.installStep1": "从项目文档标明的可信发布页下载 Windows x64 版本。",
      "settings.installStep2": "核对发布页提供的 SHA256，再解压到仅当前用户可写的目录。",
      "settings.installStep3": "点击上方“选择”，定位到文件名严格为 tunnel-client.exe 的程序。",
      "settings.installStep4": "保存后运行健康检查；本应用不会自动下载或运行新软件。",
      "settings.workspaceDiagnostics": "工作区与诊断",
      "settings.currentConfig": "当前配置",
      "settings.loading": "加载中…",
      "settings.openConfig": "打开配置文件",
      "settings.workspace": "工作区",
      "settings.workspaceHelp": "通过安全目录选择器更新。",
      "settings.change": "更改",
      "settings.openLogs": "打开日志",
      "settings.runDoctor": "运行健康检查",
      "settings.notConfigured": "未配置",
      "settings.tunnelNotConfigured": "未配置，请自动检测或选择文件",
      "settings.autoDetecting": "正在自动检测 tunnel-client.exe…",
      "settings.autoDetectedPath": "{path}（{source}，保存后固定使用）",
      "settings.autoDetected": "已自动找到，点击保存运行设置即可持久化",
      "settings.tunnelNotFound": "未找到，请选择文件或查看安装步骤",
      "settings.doctorChecking": "正在检查…",
      "settings.doctorDone": "检查完成。",
      "settings.doctorFailed": "健康检查失败：{error}",
      "settings.detecting": "正在检测…",
      "settings.detectedPath": "{path}（{source}）",
      "settings.tunnelFound": "已找到 tunnel-client.exe",
      "settings.tunnelSelected": "已选择，保存后生效",
      "settings.saving": "正在保存…",
      "settings.savedRestart": "设置已保存；当前外部 Control Center 需手动重启后生效",
      "settings.savedReload": "设置已保存，Control Center 正在重新载入",
      "settings.saveFailed": "保存失败：{error}",
      "settings.tunnelCredentials": "Core Tunnel 凭据",
      "settings.tunnelId": "Tunnel ID",
      "settings.runtimeKey": "Tunnel runtime API key",
      "settings.runtimeKeyHelp": "这是 CONTROL_PLANE_API_KEY 对应的专用 Tunnel runtime key，不是 OPENAI_API_KEY。仅经 stdin 交给一次性 provisioning 进程。",
      "settings.configureCore": "配置并验证 Core",
      "settings.configureDirect": "配置并验证 Direct",
      "settings.forgetCredential": "忘记已保存凭据",
      "settings.revalidate": "重新验证",
      "settings.revalidating": "正在使用已保存凭据运行 Tunnel doctor…",
      "settings.revalidated": "重新验证成功，已保存凭据保持不变。",
      "settings.credentialConfigured": "已配置",
      "settings.credentialMissing": "未配置",
      "settings.provisioning": "正在初始化 profile 并运行 tunnel-client doctor --explain…",
      "settings.provisioned": "验证成功，凭据已用 Windows DPAPI 保存。",
      "settings.confirmForget": "确定忘记已保存的 Tunnel runtime API key？Core 和 Direct 将无法启动，直到重新配置。",
      "settings.forgotten": "已忘记保存的 Tunnel 凭据。",
      "reason.tunnel_client_missing": "缺少 tunnel-client.exe。请先检测或选择程序。",
      "reason.tunnel_profile_missing": "缺少 Tunnel profile。请在设置中输入 Tunnel ID 和 runtime key。",
      "reason.tunnel_credential_missing": "缺少已验证的 Tunnel runtime 凭据。",
      "reason.authentication_failed": "认证失败。请核对专用 Tunnel runtime key。",
      "reason.auth_failed": "认证失败。请核对专用 Tunnel runtime key。",
      "reason.proxy_unreachable": "代理或网络不可达。请检查 HTTP/Mixed 代理。",
      "reason.region_unsupported": "当前区域不支持 Secure MCP Tunnel。",
      "reason.unsupported_region": "当前区域不支持 Secure MCP Tunnel。",
      "reason.doctor_failed": "Tunnel doctor 验证失败，请查看设置和网络。",
      "reason.tunnel_not_ready": "Tunnel 尚未 ready。",
      "reason.watcher_unhealthy": "Watcher 不健康，请运行诊断并查看日志。",
      "reason.chatgpt_reconnect": "请在 ChatGPT 重新连接 app，或新建对话后再试。"
      ,"reason.credential_forget_failed": "无法删除已保存凭据，请关闭正在使用它的进程后重试。"
      ,"reason.startup_timeout": "启动命令已执行，但 Core 未在等待时间内就绪。请检查代理、Tunnel doctor 和日志。"
      ,"reason.supervisor_exited": "Tunnel supervisor 在 Core 就绪前退出。请检查代理、凭据和 Tunnel 日志。"
      ,"reason.manager_failed": "本地启动管理器执行失败，请运行诊断并查看 Control Center 日志。"
      ,"reason.start_failed": "Core 启动失败，请运行诊断并查看具体原因。"
      ,"reason.revalidation_failed": "使用已保存凭据重新验证失败，请检查代理和 Tunnel 状态。"
      ,"reason.tool_manifest_check_failed": "Core 工具目录校验失败。请运行诊断并查看 supervisor 日志。"
      ,"reason.tool_manifest_invalid": "Core 工具目录返回了无效结果。请重新构建后再试。"
      ,"reason.supervisor_permission_denied": "系统阻止了 Core 子进程启动。请从正常桌面会话运行 PatchWarden。"
      ,"reason.supervisor_launch_failed": "无法启动 Tunnel supervisor。请检查本地 PowerShell 权限。"
      ,"reason.config_error": "Tunnel profile、配置或启动器无效。请在设置中重新验证。"
    },
    en: {
      "app.title": "PatchWarden",
      "nav.gettingStarted": "Getting Started",
      "nav.dashboard": "Advanced Console",
      "nav.tasks": "Tasks",
      "nav.workspace": "Workspace",
      "nav.audit": "Audit Log",
      "nav.direct": "Direct Sessions",
      "nav.logs": "Logs",
      "nav.settings": "Settings",
      "language.label": "Language",
      "language.system": "Use Windows language",
      "language.zh": "简体中文",
      "language.en": "English",
      "home.title": "Get Started with PatchWarden",
      "home.subtitle": "Complete these four checks in order. Direct is optional and never blocks Core startup.",
      "home.workspace": "Workspace and Agent",
      "home.platform": "Platform / Tunnel",
      "home.core": "Core service",
      "home.chatgpt": "ChatGPT App",
      "home.checking": "Checking…",
      "home.ready": "Ready",
      "home.needsAction": "Action required",
      "home.manual": "Manual verification",
      "home.workspaceReady": "The workspace is valid and at least one local Agent is available.",
      "home.workspaceMissing": "Choose a safe workspace and register an available Agent.",
      "home.tunnelReady": "The executable, Core profile, and DPAPI credential are configured.",
      "home.tunnelMissing": "Configure tunnel-client, the Tunnel ID, and the dedicated runtime API key.",
      "home.localRoute": "The local MCP route does not require a Platform Tunnel.",
      "home.coreReady": "Core, Tunnel, and Watcher are ready.",
      "home.coreMissing": "Core is not fully ready. Start it and review the specific failure.",
      "home.chatgptManual": "In ChatGPT Settings → Plugins, create a developer-mode app, choose the Tunnel, then call health_check in a new chat.",
      "home.openSettings": "Open Settings",
      "home.openPlatform": "Open Platform Tunnel",
      "home.startCore": "Start Core",
      "home.coreRunning": "Core is running",
      "home.startingCore": "Starting…",
      "home.coreStarting": "The start command was submitted. Waiting for Tunnel and Watcher readiness checks.",
      "home.startFailed": "Core failed to start. Address the reason below and retry.",
      "home.copyPrompt": "Copy test prompt",
      "home.copied": "Copied the health_check test prompt",
      "home.docs": "Official and project guides",
      "home.secureGuide": "Official Secure MCP Tunnel guide",
      "home.pluginsGuide": "ChatGPT Plugins",
      "home.readmeZh": "中文 README",
      "home.readmeEn": "English README",
      "settings.title": "Settings",
      "settings.pageTitle": "Settings — PatchWarden",
      "settings.appearance": "Appearance and window",
      "settings.localAgents": "Local agents and models",
      "settings.localAgentsHelp": "Only detected supported CLIs are registered. Models come from safe local config fields; online refresh is always manual.",
      "settings.detectAgents": "Detect again",
      "settings.loadingAgents": "Loading local agents…",
      "settings.detectingAgents": "Detecting local agents…",
      "settings.saveAgents": "Save agent settings",
      "settings.savingAgents": "Saving agent settings…",
      "settings.agentAvailable": "CLI available",
      "settings.agentMissing": "CLI not found",
      "settings.followAgentDefault": "Follow agent default",
      "settings.customModel": "Custom model ID",
      "settings.modelIdPlaceholder": "provider/model",
      "settings.refreshModels": "Refresh model list",
      "settings.refreshingModels": "Refreshing {agent} models…",
      "settings.modelsRefreshed": "Found {count} models",
      "settings.theme": "Theme",
      "settings.themeHelp": "Follow Windows or always use the light or dark theme.",
      "settings.themeSystem": "Use system theme",
      "settings.themeLight": "Light",
      "settings.themeDark": "Dark",
      "settings.languageHelp": "Initially follows Windows; a manual choice persists across pages and restarts.",
      "settings.closeWindow": "Close window",
      "settings.closeWindowHelp": "By default the window hides to the system tray while background services remain available.",
      "settings.closeToTray": "Minimize to tray",
      "settings.closeQuit": "Quit desktop app",
      "settings.mcpTunnel": "MCP and Tunnel",
      "settings.tunnelUndetected": "Not detected yet",
      "settings.detect": "Detect",
      "settings.choose": "Choose",
      "settings.directHelp": "Direct editing tools and the Direct Tunnel are available only when this profile is enabled.",
      "settings.enable": "Enable",
      "settings.proxy": "Proxy configuration",
      "settings.proxyHelp": "Use the environment proxy, no proxy, or a credential-free proxy URL.",
      "settings.proxyShared": "Shared by Core / Direct",
      "settings.proxySeparate": "Configure separately",
      "settings.proxyEnvironment": "Use environment proxy",
      "settings.proxyNone": "No proxy",
      "settings.proxyManual": "Manual proxy",
      "settings.saveRuntime": "Save runtime settings",
      "settings.installSummary": "Missing tunnel-client.exe? View installation steps",
      "settings.installStep1": "Download the Windows x64 build from the trusted release page linked by the project documentation.",
      "settings.installStep2": "Verify the SHA256 from the release page, then extract it to a directory writable only by the current user.",
      "settings.installStep3": "Choose the file whose exact name is tunnel-client.exe.",
      "settings.installStep4": "Save and run the health check. This app never downloads or runs new software automatically.",
      "settings.workspaceDiagnostics": "Workspace and diagnostics",
      "settings.currentConfig": "Current configuration",
      "settings.loading": "Loading…",
      "settings.openConfig": "Open configuration file",
      "settings.workspace": "Workspace",
      "settings.workspaceHelp": "Update it through the secure directory picker.",
      "settings.change": "Change",
      "settings.openLogs": "Open logs",
      "settings.runDoctor": "Run health check",
      "settings.notConfigured": "Not configured",
      "settings.tunnelNotConfigured": "Not configured. Detect or choose a file.",
      "settings.autoDetecting": "Automatically detecting tunnel-client.exe…",
      "settings.autoDetectedPath": "{path} ({source}; save to keep using it)",
      "settings.autoDetected": "Found automatically. Save runtime settings to persist it.",
      "settings.tunnelNotFound": "Not found. Choose a file or view the installation steps.",
      "settings.doctorChecking": "Checking…",
      "settings.doctorDone": "Check complete.",
      "settings.doctorFailed": "Health check failed: {error}",
      "settings.detecting": "Detecting…",
      "settings.detectedPath": "{path} ({source})",
      "settings.tunnelFound": "Found tunnel-client.exe",
      "settings.tunnelSelected": "Selected. Save to apply.",
      "settings.saving": "Saving…",
      "settings.savedRestart": "Settings saved. The external Control Center must be restarted manually.",
      "settings.savedReload": "Settings saved. Control Center is reloading.",
      "settings.saveFailed": "Save failed: {error}",
      "settings.tunnelCredentials": "Core Tunnel credentials",
      "settings.tunnelId": "Tunnel ID",
      "settings.runtimeKey": "Tunnel runtime API key",
      "settings.runtimeKeyHelp": "This is the dedicated Tunnel runtime key used as CONTROL_PLANE_API_KEY, not OPENAI_API_KEY. It is sent only over stdin to a one-time provisioning process.",
      "settings.configureCore": "Configure and verify Core",
      "settings.configureDirect": "Configure and verify Direct",
      "settings.forgetCredential": "Forget saved credential",
      "settings.revalidate": "Revalidate",
      "settings.revalidating": "Running Tunnel doctor with the saved credential…",
      "settings.revalidated": "Revalidation passed. The saved credential was not changed.",
      "settings.credentialConfigured": "Configured",
      "settings.credentialMissing": "Not configured",
      "settings.provisioning": "Initializing the profile and running tunnel-client doctor --explain…",
      "settings.provisioned": "Verification passed. The credential is saved with Windows DPAPI.",
      "settings.confirmForget": "Forget the saved Tunnel runtime API key? Core and Direct cannot start until it is configured again.",
      "settings.forgotten": "The saved Tunnel credential was forgotten.",
      "reason.tunnel_client_missing": "tunnel-client.exe is missing. Detect or choose it first.",
      "reason.tunnel_profile_missing": "The Tunnel profile is missing. Enter a Tunnel ID and runtime key in Settings.",
      "reason.tunnel_credential_missing": "A verified Tunnel runtime credential is missing.",
      "reason.authentication_failed": "Authentication failed. Check the dedicated Tunnel runtime key.",
      "reason.auth_failed": "Authentication failed. Check the dedicated Tunnel runtime key.",
      "reason.proxy_unreachable": "The proxy or network is unreachable. Check the HTTP/Mixed proxy.",
      "reason.region_unsupported": "Secure MCP Tunnel is not supported in the current region.",
      "reason.unsupported_region": "Secure MCP Tunnel is not supported in the current region.",
      "reason.doctor_failed": "Tunnel doctor failed. Review the settings and network.",
      "reason.tunnel_not_ready": "The Tunnel is not ready yet.",
      "reason.watcher_unhealthy": "The Watcher is unhealthy. Run diagnostics and review the logs.",
      "reason.chatgpt_reconnect": "Reconnect the app in ChatGPT, or start a new chat and try again."
      ,"reason.credential_forget_failed": "The saved credential could not be removed. Close any process using it and retry."
      ,"reason.startup_timeout": "The start command ran, but Core did not become ready in time. Check the proxy, Tunnel doctor, and logs."
      ,"reason.supervisor_exited": "The Tunnel supervisor exited before Core was ready. Check the proxy, credential, and Tunnel logs."
      ,"reason.manager_failed": "The local start manager failed. Run diagnostics and review the Control Center logs."
      ,"reason.start_failed": "Core failed to start. Run diagnostics and review the specific cause."
      ,"reason.revalidation_failed": "Revalidation with the saved credential failed. Check the proxy and Tunnel status."
      ,"reason.tool_manifest_check_failed": "Core tool catalog validation failed. Run diagnostics and review the supervisor log."
      ,"reason.tool_manifest_invalid": "Core tool catalog validation returned an invalid result. Rebuild and retry."
      ,"reason.supervisor_permission_denied": "Windows blocked the Core child process. Run PatchWarden from a normal desktop session."
      ,"reason.supervisor_launch_failed": "The Tunnel supervisor could not start. Check local PowerShell permissions."
      ,"reason.config_error": "The Tunnel profile, configuration, or launcher is invalid. Revalidate it in Settings."
    }
  };
  var sourceKeys = {
    "控制台": "nav.dashboard", "Dashboard": "nav.dashboard", "任务面板": "nav.tasks", "Tasks": "nav.tasks",
    "工作区": "nav.workspace", "Workspace": "nav.workspace", "审计日志": "nav.audit", "Audit Log": "nav.audit",
    "Direct 会话": "nav.direct", "Direct Sessions": "nav.direct", "日志": "nav.logs", "Logs": "nav.logs",
    "设置": "nav.settings", "Settings": "nav.settings", "开始使用": "nav.gettingStarted", "Getting Started": "nav.gettingStarted"
  };
  var literalEnglish = {
    "全部启动": "Start all", "全部停止": "Stop all", "全部重启": "Restart all", "刷新": "Refresh",
    "工作区根目录": "Workspace root", "Core 隧道": "Core Tunnel", "Direct 隧道": "Direct Tunnel", "日志目录": "Logs folder",
    "健康评分": "Health score", "任务监视器": "Task monitor", "隧道就绪": "Tunnel readiness", "本地 Agent": "Local Agents",
    "过期任务": "Stale tasks", "失败任务": "Failed tasks", "安全策略": "Security policy", "发布检查": "Release check",
    "Direct 配置": "Direct configuration", "启动准备": "Startup readiness", "健康建议": "Health suggestions",
    "任务链路": "Task lineages", "项目策略": "Project policy", "证据包": "Evidence packs", "最近任务": "Recent tasks",
    "系统状态": "System status", "活动日志": "Activity log", "活动时间线": "Activity timeline",
    "Core + Direct 输出摘要": "Core + Direct output summary", "复制诊断": "Copy diagnostics", "查看详情": "View details",
    "查看": "View", "隐藏": "Hide", "执行": "Run", "处理": "Resolve", "正常": "Ready", "有效": "Valid", "已启用": "Enabled",
    "暂无任务": "No tasks", "暂无任务链路": "No task lineages", "创建受控任务链": "Create controlled task lineage", "查看最近运行": "View recent runs",
    "选择具体 repo 以读取 version": "Select a repository to read its version",
    "已可供桌面启动和重启使用。": "Available for desktop start and restart.",
    "PatchWarden 任务仅在此工作区内运行。": "PatchWarden tasks run only inside this workspace.",
    "Core 未运行，建议启动 Core profile": "Core is stopped. Start the Core profile.",
    "Direct 未运行，建议启动 Direct profile": "Direct is stopped. Start the Direct profile if needed.",
    "Tunnel 未就绪，建议重启 profile 或检查代理": "Tunnel is not ready. Restart the profile or check the proxy.",
    "任务心跳已过期，watcher 可能未运行或任务已僵死，建议 reconcile 或 kill。": "The task heartbeat is stale. The Watcher may be stopped or the task may be stuck; reconcile or kill it.",
    "查看 Core / Direct 本次日志尾部": "Show Core / Direct log tails", "重建任务": "Rebuild task", "正在加载…": "Loading…",
    "仓库": "Repository", "全部仓库": "All repositories", "状态": "Status", "全部状态": "All statuses", "验收": "Acceptance", "全部验收": "All acceptance states",
    "警告类型": "Warning type", "全部警告": "All warnings", "全部 Agent": "All Agents", "更新从": "Updated from", "更新至": "Updated to",
    "应用筛选": "Apply filters", "清空筛选": "Clear filters", "无筛选": "No filters", "加载中...": "Loading...", "加载失败": "Load failed", "重试": "Retry",
    "任务ID": "Task ID", "标题": "Title", "验证": "Verification", "阶段": "Phase", "创建时间": "Created", "更新时间": "Updated", "下一步": "Next step", "操作": "Actions",
    "排队中": "Queued", "已完成": "Completed", "收集产物": "Collecting artifacts",
    "工作区路径": "Workspace path", "项目列表": "Projects", "暂无项目": "No projects", "检查": "Check", "配置预览": "Configuration preview",
    "Agent 注册": "Agent registration", "未注册任何 Agent": "No Agents registered", "可用": "Available", "安全边界": "Security boundaries",
    "工作区隔离": "Workspace confinement", "workspaceRoot 路径限制": "workspaceRoot path restrictions", "命令白名单": "Command allow-list",
    "精确匹配 allowedTestCommands": "Exact allowedTestCommands matching", "敏感文件": "Sensitive files", ".env / credentials 已屏蔽": ".env / credentials are blocked",
    "Repo Clean 状态": "Repository clean status", "按需 git status（点击检查）": "On-demand git status (click Check)",
    "总审计": "Total audits", "通过": "Passed", "失败": "Failed", "警告聚合": "Warning summary", "加载警告中...": "Loading warnings...",
    "警告加载失败": "Warning load failed", "暂无警告": "No warnings", "暂无审计记录": "No audit records", "裁定": "Verdict", "范围变更": "Scope changes", "审计时间": "Audit time", "审计证据": "Audit evidence",
    "暂无 Direct 会话": "No Direct sessions", "已过期": "Expired", "点击展开 / 折叠": "Click to expand / collapse", "自动刷新": "Auto refresh",
    "任务详情": "Task details", "复制 ID": "Copy ID", "打开目录": "Open folder", "运行审计": "Run audit", "返回任务列表": "Back to tasks",
    "任务不存在": "Task not found", "任务疑似僵死": "Task may be stuck", "测试命令": "Test command", "超时(秒)": "Timeout (seconds)", "安全摘要": "Safe summary",
    "默认仅展示脱敏后的安全摘要。完整结果、diff、测试日志请见下方「高级」区域。": "Only redacted safe summaries are shown by default. Full results, diffs, and test logs are available under Advanced.",
    "结果概览 (safe_result)": "Result overview (safe_result)", "测试摘要 (safe_test_summary)": "Test summary (safe_test_summary)", "变更摘要 (safe_diff_summary)": "Diff summary (safe_diff_summary)", "审计结论 (safe_audit)": "Audit result (safe_audit)",
    "高级": "Advanced", "以下内容仅在点击时按需加载，可能包含完整 stdout/stderr/diff 等较大输出。": "The following content loads only when requested and may include large stdout, stderr, or diff output.",
    "加载完整结果 (get_result)": "Load full result (get_result)", "加载完整测试日志 (get_test_log)": "Load full test log (get_test_log)", "加载完整 diff (get_diff)": "Load full diff (get_diff)", "运行 audit_task 完整审计": "Run full audit_task audit"
  };
  var literalChinese = Object.fromEntries(Object.entries(literalEnglish).map(function (entry) { return [entry[1], entry[0]]; }));
  Object.assign(literalChinese, {
    blocked: "已阻止", missing: "缺失", unavailable: "不可用", unknown: "未知", healthy: "健康", stale: "已过期",
    "Watcher heartbeat has not been observed. Start or restart the PatchWarden watcher.": "尚未检测到 Watcher 心跳。请启动或重启 PatchWarden Watcher。"
  });
  var selected = "system";
  var language = /^zh(?:-|$)/i.test(navigator.language || "") ? "zh-CN" : "en";

  function resolve(value, fallback) {
    if (value === "zh-CN" || value === "en") return value;
    return fallback || (/^zh(?:-|$)/i.test(navigator.language || "") ? "zh-CN" : "en");
  }
  function t(key, params) {
    var value = dictionaries[language][key] || dictionaries.en[key] || key;
    Object.keys(params || {}).forEach(function (name) { value = value.replace(new RegExp("\\{" + name + "\\}", "g"), String(params[name])); });
    return value;
  }
  function translateLiteral(text) {
    if (language === "en") {
      if (literalEnglish[text]) return literalEnglish[text];
      var match = text.match(/^(\d+) 个可用$/); if (match) return match[1] + " available";
      match = text.match(/^(\d+) 项需要处理$/); if (match) return match[1] + " item(s) need attention";
      match = text.match(/^共 (\d+) 条 · 显示 (\d+)$/); if (match) return match[1] + " total · showing " + match[2];
      match = text.match(/^共 (\d+) 条$/); if (match) return match[1] + " total";
      match = text.match(/^存在 (\d+) 个 stale 任务，建议查看并 reconcile$/); if (match) return match[1] + " stale task(s); review and reconcile";
      match = text.match(/^Core (未就绪|就绪) \/ Direct (未就绪|就绪)$/); if (match) return "Core " + (match[1] === "就绪" ? "ready" : "not ready") + " / Direct " + (match[2] === "就绪" ? "ready" : "not ready");
      match = text.match(/^更新于 (.+)$/); if (match) return "Updated " + match[1];
      match = text.match(/^(\d+) 个目录$/); if (match) return match[1] + " folders";
      match = text.match(/^(\d+) 个 Agent$/); if (match) return match[1] + " Agents";
    } else {
      if (literalChinese[text]) return literalChinese[text];
      var zhMatch = text.match(/^(\d+) available$/); if (zhMatch) return zhMatch[1] + " 个可用";
      zhMatch = text.match(/^(\d+) item\(s\) need attention$/); if (zhMatch) return zhMatch[1] + " 项需要处理";
      zhMatch = text.match(/^(\d+) total · showing (\d+)$/); if (zhMatch) return "共 " + zhMatch[1] + " 条 · 显示 " + zhMatch[2];
      zhMatch = text.match(/^(\d+) total$/); if (zhMatch) return "共 " + zhMatch[1] + " 条";
      zhMatch = text.match(/^Updated (.+)$/); if (zhMatch) return "更新于 " + zhMatch[1];
      zhMatch = text.match(/^(\d+) folders$/); if (zhMatch) return zhMatch[1] + " 个目录";
      zhMatch = text.match(/^(\d+) Agents$/); if (zhMatch) return zhMatch[1] + " 个 Agent";
    }
    return text;
  }
  function applyTranslations(root) {
    var scope = root && root.querySelectorAll ? root : document;
    var keyed = Array.from(scope.querySelectorAll("[data-i18n]")); if (scope.matches && scope.matches("[data-i18n]")) keyed.unshift(scope);
    keyed.forEach(function (node) { var value = t(node.dataset.i18n); if (node.textContent !== value) node.textContent = value; });
    scope.querySelectorAll("[data-i18n-title]").forEach(function (node) { var value = t(node.dataset.i18nTitle); if (node.title !== value) node.title = value; });
    scope.querySelectorAll("[data-i18n-placeholder]").forEach(function (node) { var value = t(node.dataset.i18nPlaceholder); if (node.placeholder !== value) node.placeholder = value; });
    var walker = document.createTreeWalker(scope === document ? document.body : scope, NodeFilter.SHOW_TEXT);
    var node;
    while ((node = walker.nextNode())) {
      var text = node.nodeValue.trim(); var key = sourceKeys[text]; var translated = key ? t(key) : translateLiteral(text);
      if (translated !== text) node.nodeValue = node.nodeValue.replace(text, translated);
    }
    document.documentElement.lang = language;
  }
  async function setLanguage(value) {
    selected = value === "zh-CN" || value === "en" ? value : "system";
    localStorage.setItem(STORAGE_KEY, selected);
    if (window.patchwardenDesktop) {
      var prefs = await window.patchwardenDesktop.setPreferences({ language: selected });
      var state = await window.patchwardenDesktop.getState();
      language = resolve(prefs.language, state.resolvedLanguage);
    } else {
      localStorage.setItem(STORAGE_KEY, selected);
      language = resolve(selected);
    }
    applyTranslations(document);
    window.dispatchEvent(new CustomEvent("patchwarden:languagechange", { detail: { language: language, selected: selected } }));
    return language;
  }
  async function initialize() {
    if (window.patchwardenDesktop) {
      selected = localStorage.getItem(STORAGE_KEY) || "system";
      language = resolve(selected);
      addLanguageSwitcher();
      applyTranslations(document);
      var state = await window.patchwardenDesktop.getState();
      selected = state.preferences.language || "system";
      language = resolve(selected, state.resolvedLanguage);
      localStorage.setItem(STORAGE_KEY, selected);
    } else {
      selected = localStorage.getItem(STORAGE_KEY) || "system";
      language = resolve(selected);
    }
    addLanguageSwitcher();
    applyTranslations(document);
    var observer = new MutationObserver(function (mutations) {
      mutations.forEach(function (mutation) {
        mutation.addedNodes.forEach(function (node) {
          if (node.nodeType === Node.ELEMENT_NODE) applyTranslations(node);
          else if (node.nodeType === Node.TEXT_NODE) {
            var source = node.nodeValue.trim(); var key = sourceKeys[source]; var translated = key ? t(key) : translateLiteral(source);
            if (translated !== source) node.nodeValue = node.nodeValue.replace(source, translated);
          }
        });
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
    window.dispatchEvent(new CustomEvent("patchwarden:i18nready", { detail: { language: language, selected: selected } }));
  }
  function addLanguageSwitcher() {
    if (document.getElementById("language") || document.getElementById("pw-language-switcher")) return;
    var header = document.querySelector("header"); if (!header) return;
    var select = document.createElement("select"); select.id = "pw-language-switcher"; select.className = "pw-language-switcher"; select.setAttribute("aria-label", "Language");
    [["system", "language.system"], ["zh-CN", "language.zh"], ["en", "language.en"]].forEach(function (entry) { var option = document.createElement("option"); option.value = entry[0]; option.dataset.i18n = entry[1]; option.textContent = t(entry[1]); select.appendChild(option); });
    select.value = selected;
    select.addEventListener("change", function () { void setLanguage(select.value); });
    var target = document.querySelector("aside") || header;
    target.appendChild(select);
  }
  window.PatchWardenI18n = Object.freeze({ t: t, applyTranslations: applyTranslations, setLanguage: setLanguage, getLanguage: function () { return language; }, getSelectedLanguage: function () { return selected; }, dictionaries: dictionaries });
  window.t = t;
  window.applyTranslations = applyTranslations;
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { void initialize(); });
  else void initialize();
})();
