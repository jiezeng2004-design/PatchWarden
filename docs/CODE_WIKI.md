# PatchWarden Code Wiki

> 本文档是对 PatchWarden 仓库的结构化代码导览，覆盖项目整体架构、主要模块职责、关键类与函数说明、依赖关系、运行方式，以及现有缺陷分析。
> 源码版本：**v1.6.0** · Schema Epoch：`2026-07-19-v15` · License：MIT

## 目录

- [1. 项目概览](#1-项目概览)
- [2. 整体架构](#2-整体架构)
- [3. 目录结构](#3-目录结构)
- [4. 核心模块职责](#4-核心模块职责)
- [5. 关键类与函数说明](#5-关键类与函数说明)
- [6. 数据流与状态机](#6-数据流与状态机)
- [7. 依赖关系](#7-依赖关系)
- [8. 项目运行方式](#8-项目运行方式)
- [9. 安全设计](#9-安全设计)
- [10. 测试与发布](#10-测试与发布)
- [11. 现有缺陷与改进建议](#11-现有缺陷与改进建议)

---

## 1. 项目概览

PatchWarden 是一个面向本地编程 Agent 的**安全 MCP（Model Context Protocol）桥接器**。上游的 ChatGPT、Codex、OpenCode 或其他 MCP 客户端负责规划与验收，PatchWarden 负责把计划保存成工作区内任务，再由预先配置的本地 Agent 执行，并返回结果、代码差异和独立测试记录。

**核心定位**：

> PatchWarden is a local-first MCP safety and verification layer for AI coding agents, with workspace confinement, command allowlists, scope-violation detection, and auditable task evidence.

**关键特性**：

- MCP 工具不提供通用 Shell，上游模型只能调用明确的 MCP 工具
- 每个任务必须指定位于 `workspaceRoot` 内的 `repo_path`
- Agent 启动命令来自本地配置，不来自模型输入
- 测试命令必须精确匹配 `allowedTestCommands` 白名单
- 任务完成后保存结构化结果、有界且脱敏的差异、文件统计和独立验证记录
- 工作区外出现变化时标记为作用域违规，而非悄悄接受
- `.env`、Token、SSH 密钥、Cookie、凭据文件等敏感路径默认不可读
- v1.6.0 引入 Electron 桌面应用，支持 8 种本地 Agent 自动检测与模型发现

**技术栈**：TypeScript + Node.js（≥18）；主仓只有一个直接运行时依赖 `@modelcontextprotocol/sdk`（`^1.29.0`），`desktop/` 子包的直接运行时依赖为 `jsonc-parser`、`smol-toml`、`yaml` 三个解析器。

---

## 2. 整体架构

### 2.1 角色与数据流

```text
ChatGPT / Codex / OpenCode / 其他 MCP 客户端
                    │
                    ▼
          PatchWarden MCP Server（stdio / HTTP）
                    │
          save_plan / create_task / run_task_loop
                    │
                    ▼
       .patchwarden/tasks/<task_id>/
                    │
              Watcher 发现任务
                    │
                    ▼
        本地 Agent（OpenCode / Codex / Claude Code / Gemini / ...）
                    │
                    ▼
 result.json / diff.patch / verify.json / status.json
                    │
                    ▼
       MCP 客户端读取 safe 摘要、审计证据并人工验收
                    │
                    ▼
       Control Center Dashboard / Desktop Tray（可选）
```

### 2.2 三种运行角色

一次完整运行通常包含三个独立角色：

| 角色 | 职责 | 入口 |
| --- | --- | --- |
| **MCP Server** | 暴露受限的 planning/task/summary/audit 工具 | `dist/index.js`（stdio）或 `dist/httpServer.js`（HTTP） |
| **Watcher** | 轮询 queued 任务并启动本地 Agent | `dist/runner/watch.js` |
| **本地 Agent** | 真正修改代码，必须在配置中预先登记 | 由 Watcher 通过 `spawn` 启动 |
| **Control Center**（可选） | 本地 Dashboard HTTP 服务，聚合任务/会话/lineage/证据包 | `dist/controlCenter.js`（127.0.0.1:8090） |
| **Desktop App**（可选） | Electron 外壳，引导配置、监督后端、托盘管理 | `desktop/src/main.ts` |

> ⚠️ "MCP 已连接"不等于"任务一定会执行"。如果 Watcher 没有运行，`create_task` 仍能保存任务，但任务会保持 `queued` 并返回 `execution_blocked: true`。

### 2.3 四种工具 Profile

| Profile | 工具数 | 用途 |
| --- | --- | --- |
| `full` | 64 | 本地完整开发目录，包含核心、管理、Direct 工具 |
| `chatgpt_core` | 26 | ChatGPT Tunnel 固定的核心工具集 |
| `chatgpt_direct` | 14 | ChatGPT 直接编辑模式，需 `enableDirectProfile: true` |
| `chatgpt_search` | 5 | 动态工具发现场景（discover/explain/invoke） |

### 2.4 两种执行模式

| 模式 | 流程 |
| --- | --- |
| **Agent 委托模式** | ChatGPT 编写计划 → 本地 Agent 执行 → PatchWarden 审计 |
| **Direct 模式** | ChatGPT 创建 session → 读取/搜索文件 → 应用 JSON 补丁 → 运行白名单验证 → finalize → audit |

### 2.5 v1.6.0 Desktop 架构

```text
┌──────────────────────────────────────────────────┐
│ PatchWarden Desktop (Electron)                   │
│  ┌────────────────────────────────────────────┐  │
│  │ main.mjs (主进程)                          │  │
│  │  ├─ agent-adapters.mjs (8 种 Agent 检测)   │  │
│  │  ├─ model-discovery.mjs (本地模型发现)     │  │
│  │  ├─ config-store.mjs (DPAPI / 原子写入)    │  │
│  │  ├─ tunnel-provisioner.mjs (隧道下发)      │  │
│  │  ├─ runtime-settings.mjs (tunnel-client)   │  │
│  │  ├─ backend-probe.mjs (后端探测)           │  │
│  │  └─ runtime-root.mjs (主仓定位)            │  │
│  └────────────────────────────────────────────┘  │
│            │ utilityProcess.fork                  │
│            ▼                                      │
│  PatchWarden Core (dist/controlCenter.js:8090)    │
│  + Control Center UI (ui/pages/*)                 │
└──────────────────────────────────────────────────┘
```

桌面应用是薄壳，所有业务逻辑在主仓 `dist/`，桌面只负责安装/检测/拉起/托盘/tunnel 下发。依赖极简（3 个运行时包），采用 `contextIsolation` + `sandbox` + IPC sender 校验。

---

## 3. 目录结构

```text
PatchWarden/
├── src/                          # TypeScript 源码（主仓）
│   ├── index.ts                  # stdio MCP Server 入口
│   ├── httpServer.ts             # HTTP MCP Server 入口（127.0.0.1 only）
│   ├── controlCenter.ts          # Control Center 启动入口（调用 control/server.ts）
│   ├── doctor.ts                 # 只读诊断脚本
│   ├── config.ts                 # 配置加载与校验
│   ├── errors.ts                 # PatchWardenError 错误模型
│   ├── logging.ts                # 审计日志
│   ├── version.ts                # 版本与 Schema Epoch
│   ├── watcherStatus.ts          # Watcher 心跳状态
│   ├── smoke-test.ts             # 烟雾测试入口
│   ├── agents/                   # Agent 路由
│   │   └── agentRouter.ts
│   ├── assessments/              # 风险评估
│   │   ├── agentAssessor.ts
│   │   ├── assessmentStore.ts
│   │   └── confirmCli.ts
│   ├── control/                  # Control Center 后端（v1.5.1 拆分）
│   │   ├── server.ts             # HTTP 服务、路由分发、生命周期
│   │   ├── shared.ts             # 共享配置、令牌、HTTP/文件 helper
│   │   ├── runtime.ts            # 健康探测、stale 分类、事件时间线
│   │   ├── middleware/
│   │   │   ├── auth.ts           # control token 校验
│   │   │   └── static.ts         # 静态文件服务
│   │   └── routes/               # 路由 handler（10 个领域）
│   │       ├── audit.ts  evidence.ts  lineage.ts  policy.ts
│   │       ├── process.ts  sessions.ts  status.ts
│   │       └── taskActions.ts  tasks.ts  workspace.ts
│   ├── direct/                   # Direct 直接编辑模式
│   │   ├── directSessionStore.ts
│   │   ├── directGuards.ts
│   │   ├── directPatch.ts
│   │   ├── directAudit.ts
│   │   └── directVerification.ts
│   ├── goal/                     # Goal Session 多任务编排
│   │   ├── goalStore.ts  goalGraph.ts  goalStatus.ts
│   │   ├── goalProgress.ts  goalReport.ts  handoffExport.ts
│   │   ├── specKitImport.ts  subgoalSync.ts
│   │   ├── acceptanceEngine.ts  acceptanceTemplate.ts
│   │   └── worktreeManager.ts
│   ├── policy/                   # 项目级策略
│   │   └── projectPolicy.ts
│   ├── release/                  # 发布门控
│   │   └── releaseGate.ts
│   ├── runner/                   # 任务执行核心
│   │   ├── cli.ts  runTask.ts  watch.ts
│   │   ├── agentInvocation.ts  changeCapture.ts
│   │   ├── postTaskCleanup.ts  simpleProcess.ts  processSecurity.ts
│   │   └── taskRuntime.ts  taskProgress.ts  taskStatusStore.ts
│   ├── security/                 # 纵深防御守卫
│   │   ├── commandGuard.ts  pathGuard.ts  sensitiveGuard.ts
│   │   ├── planGuard.ts  riskEngine.ts  runtimeGuard.ts
│   │   ├── contentRedaction.ts  toolInvocationGuard.ts
│   │   ├── discoveryTokenStore.ts  workspaceRootGuard.ts
│   ├── tools/                    # MCP 工具实现（49 个工具文件）
│   │   ├── registry.ts           # 工具注册中枢
│   │   ├── toolCatalog.ts        # Profile 与 Manifest
│   │   ├── toolRegistry.ts       # 工具元数据
│   │   ├── toolSearch.ts         # 工具搜索（v0.9.0 5 维混合排序）
│   │   ├── schemaDriftCheck.ts   # Schema 漂移自检
│   │   ├── toolUsageStats.ts     # 工具调用统计
│   │   ├── dispatch/             # 工具分派层（v1.5.1 拆分）
│   │   │   ├── types.ts          # ToolHandler / ToolHandlerMap / toResult
│   │   │   ├── coreDispatch.ts   # 30+ 核心工具
│   │   │   ├── diagnosticDispatch.ts  # discover/explain/invoke
│   │   │   ├── directDispatch.ts # Direct session 工具
│   │   │   ├── goalDispatch.ts   # Goal 工具
│   │   │   └── releaseDispatch.ts # Release mode 工具
│   │   ├── createTask.ts  runTaskLoop.ts  taskLineage.ts
│   │   ├── evidencePack.ts  auditTask.ts  safeViews.ts
│   │   ├── healthCheck.ts  waitForTask.ts
│   │   ├── applyPatch.ts  searchWorkspace.ts  syncFile.ts
│   │   ├── androidDoctor.ts  releaseMode.ts  explainTool.ts
│   │   ├── mergeWorktree.ts  discardWorktree.ts  goalSubgoalTask.ts
│   │   ├── runVerification.ts  runDirectVerificationBundle.ts
│   │   └── ... (30+ 其他工具文件)
│   └── test/unit/                # 单元测试（45+ 测试文件）
├── desktop/                      # Electron 桌面应用子包（v1.6.0）
│   ├── package.json              # 独立依赖（jsonc-parser/smol-toml/yaml）
│   ├── src/                      # 9 个 .mjs 模块
│   │   ├── main.mjs              # Electron 入口、Tray、IPC、后端生命周期
│   │   ├── agent-adapters.mjs    # 8 种 Agent 适配器
│   │   ├── agent-detection.mjs   # 门面 re-export
│   │   ├── backend-probe.mjs     # /api/diagnostics 探测
│   │   ├── config-store.mjs      # 配置/DPAPI/原子写入
│   │   ├── model-discovery.mjs   # 各 Agent 配置文件模型抽取
│   │   ├── runtime-root.mjs      # 主仓定位
│   │   ├── runtime-settings.mjs  # tunnel-client 检测
│   │   └── tunnel-provisioner.mjs # 隧道下发
│   ├── onboarding/               # 首次引导 UI
│   ├── scripts/                  # stage/checksum/icon/test
│   └── test/                     # 桌面单元测试
├── ui/                           # Control Center 前端
│   ├── pages/                    # dashboard/tasks/audit 等 8 个页面
│   ├── partials/
│   └── vendor/                   # tailwindcss / lucide
├── scripts/                      # 运维脚本
│   ├── checks/                   # 烟雾测试与 manifest 校验
│   ├── control/                  # PowerShell 进程管理
│   ├── launchers/                # Windows 一键启动器
│   ├── mcp/                      # MCP 启动包装
│   └── release/                  # 发布打包
├── docs/                         # 文档
├── examples/                     # 配置与 Tunnel 示例
├── package.json                  # v1.6.0，单一直接运行时依赖
├── tsconfig.json
└── PatchWarden.cmd               # Windows 统一控制入口
```

---

## 4. 核心模块职责

### 4.1 入口层

| 文件 | 职责 |
| --- | --- |
| [src/index.ts](../src/index.ts) | stdio MCP Server 入口，加载配置、注册工具、连接 `StdioServerTransport` |
| [src/httpServer.ts](../src/httpServer.ts) | HTTP MCP Server，绑定 `127.0.0.1:7331`，每请求独立 MCP 实例，支持 owner token 与 `/admin/tasks/:id/accept` 验收端点 |
| [src/controlCenter.ts](../src/controlCenter.ts) | 本地 Dashboard 启动入口，仅 `import { startServer } from "./control/server.js"` |
| [src/doctor.ts](../src/doctor.ts) | 只读诊断脚本，检查 15+ 项：Node/npm/Git 版本、配置、工作区、路径保护、敏感文件、Agent 命令、工具 Manifest、HTTP 端口、Watcher 目录、构建产物 |

### 4.2 配置与基础

| 文件 | 职责 |
| --- | --- |
| [src/config.ts](../src/config.ts) | 加载并校验 `patchwarden.config.json`，提供 `loadConfig`/`getConfig`/`getTasksDir`/`getPlansDir`/`resolveWorkspaceRoot`/`getRepoAllowedTestCommands` 等路径解析；严格校验 `workspaceRoot`、`agents`、`allowedTestCommands`、`watcherStaleSeconds`、`toolProfile` 等字段；含 `normalizeRepoKey` 工具 |
| [src/errors.ts](../src/errors.ts) | 定义 `PatchWardenError`（含 `reason`/`suggestion`/`blocked`/`details`）与 `errorPayload` 序列化 |
| [src/version.ts](../src/version.ts) | 导出 `PATCHWARDEN_VERSION = "1.6.1"` 与 `TOOL_SCHEMA_EPOCH = "2026-07-19-v15"` |
| [src/logging.ts](../src/logging.ts) | `Logger` 类输出 stderr JSON 日志，记录 `audit`/`info`/`warn`/`error`；`logToolInvocation` 仅写参数 digest，不写原参数，并通过跨进程锁有界追加到 5 MiB；`installGlobalHandlers` 捕获未处理异常但不吞错 |

### 4.3 安全模块（src/security/）

PatchWarden 的纵深防御核心，所有写操作前都会经过这些守卫。

| 文件 | 职责 |
| --- | --- |
| [commandGuard.ts](../src/security/commandGuard.ts) | 命令白名单守卫：`guardAgentCommand` 校验 agent 已配置且命令无 shell 元字符；`guardTestCommand` 精确匹配测试白名单；`guardDirectCommand` 校验 Direct 白名单；`sanitizePromptArg` 清洗控制字符 |
| [pathGuard.ts](../src/security/pathGuard.ts) | 路径横移守卫：`guardPath`/`guardReadPath`/`guardWorkspacePath` 确保路径解析后都在 `workspaceRoot` 内，用 `realpath` 防符号链接逃逸，Windows 下做盘符一致性检查 |
| [sensitiveGuard.ts](../src/security/sensitiveGuard.ts) | 敏感文件守卫：`isSensitivePath` 匹配 `.env`/SSH 私钥/`credentials`/`.npmrc`/`cookies`/`.kube/config` 等；没有 `.patchwarden/` 前缀豁免，敏感名称在任意目录深度都阻断 |
| [planGuard.ts](../src/security/planGuard.ts) | 计划内容守卫：`guardPlanContent` 扫描 plan 文本，拦截"读取密钥/破坏性删除/植入后门"等危险指令，支持中英文否定语境检测 |
| [riskEngine.ts](../src/security/riskEngine.ts) | 综合风险评估：`assessRisk` 串联各 guard 输出 `risk_level`（low/medium/high）+ `decision`（allow/needs_confirm/blocked）+ `reason_codes`；`collectRiskHints` 仅做关键词提示，不影响决策 |
| [runtimeGuard.ts](../src/security/runtimeGuard.ts) | 阻止任务把 `repo_path` 指向运行中的 PatchWarden 自身目录（`dist`/`src`/`scripts`/`release`） |
| [contentRedaction.ts](../src/security/contentRedaction.ts) | 输出脱敏：`redactSensitiveContent`/`redactSensitiveValue` 按正则替换私钥、bearer token、npm token、凭据赋值、已知 token 格式 |
| [loopbackHost.ts](../src/security/loopbackHost.ts) | 回环 HTTP Host 白名单：仅接受当前端口的 `127.0.0.1`/`localhost`，供 HTTP MCP 与 Control Center 共同阻断 DNS rebinding |
| [toolInvocationGuard.ts](../src/security/toolInvocationGuard.ts) | `invoke_discovered_tool` 调用前 8 项校验：token 匹配、profile 允许、风险等级、敏感路径、assessment 必需、命令元字符、release 确认、credential 拒绝 |
| [discoveryTokenStore.ts](../src/security/discoveryTokenStore.ts) | 服务端 discovery token 存储：`issueToken`/`consumeToken`（单次使用）/`peekToken`/`revokeToken`，纯内存、10 分钟 TTL、不持久化 |
| [workspaceRootGuard.ts](../src/security/workspaceRootGuard.ts) | `validateWorkspaceRoot` 校验工作区根目录合法性（被桌面应用动态 import 复用） |

### 4.4 Runner 模块（src/runner/）

任务执行的核心，编排从启动到产出 artifact 的完整生命周期。

| 文件 | 职责 |
| --- | --- |
| [cli.ts](../src/runner/cli.ts) | Runner 子进程入口，从 argv 或 `PATCHWARDEN_TASK_ID` 读取 taskId 并调用 `runTask` |
| [runTask.ts](../src/runner/runTask.ts) | **执行主循环**：`runTask(taskId)` 编排 preparing → executing_agent → running_tests → collecting_artifacts → done/failed；管理心跳（2s）、超时、cancel/kill；产出 16+ artifact 文件；区分 `failed_scope_violation`/`failed_policy_violation` |
| [watch.ts](../src/runner/watch.ts) | 常驻 watcher，每 4 秒轮询 `pending` 任务，执行 pre-flight 安全校验后调用 `runTask`；原子写心跳文件；通过 env 注入 `WATCHER_INSTANCE_ID`/`WATCHER_LAUNCHER_PID` 支持所有权判定 |
| [agentInvocation.ts](../src/runner/agentInvocation.ts) | 构建 agent 调用参数与 prompt：`buildAgentInvocation`/`buildExecutionPrompt`/`buildAssessmentPrompt`；占位符 `{repo}`/`{prompt}`/`{prompt_file}` 替换；Windows npm shim 解析为原生 exe 或已验证的 package `bin`，不启用 shell；Agent 必须显式注册，子进程只接收该 Agent 的 `envAllowlist` 环境变量 |
| [changeCapture.ts](../src/runner/changeCapture.ts) | 仓库快照与变更证据：`captureRepoSnapshot` 并行跑 5 个 git 命令；`buildChangeArtifacts` 比对快照生成最多 20 MiB、写前脱敏的 diff；凭据型内容记录 redaction 元数据；`extractExternalDirtyFiles` 建立外部脏文件基线；`buildArtifactManifest` 生成带 sha256 的产物清单 |
| [postTaskCleanup.ts](../src/runner/postTaskCleanup.ts) | 任务后清理：仅删除未被 git 跟踪且被忽略的临时产物（`__pycache__`/`dist`/`*.pyc`），三道闸门保护受控文件 |
| [simpleProcess.ts](../src/runner/simpleProcess.ts) | 轻量进程执行器：`runSimpleProcess`/`runSimpleProcessSync`，使用最小子进程环境、受信 PATH 可执行文件绑定、无 shell 的 npm/npx/pnpm 解析，以及有界脱敏日志捕获 |

### 4.5 Tools 模块（src/tools/）

MCP 工具实现与注册中枢，共 49 个工具文件。

| 文件 | 职责 |
| --- | --- |
| [registry.ts](../src/tools/registry.ts) | **工具注册中枢**（约 170 行）：`registerTools` 绑定 `ListToolsRequestSchema`/`CallToolRequestSchema`，`handleToolCall` 分派到领域 handler map；工具定义由 `definitions/toolDefs.ts` 提供 |
| [toolCatalog.ts](../src/tools/catalog/toolCatalog.ts) | Profile 与 Manifest：`resolveToolProfile`/`selectToolsForProfile` 按 profile 过滤工具；`buildToolCatalogSnapshot` 计算 `tool_manifest_sha256` 用于漂移检测；导出 `CHATGPT_CORE_TOOL_NAMES`(26)/`CHATGPT_DIRECT_TOOL_NAMES`(14)/`CHATGPT_SEARCH_TOOL_NAMES`(5) |
| [toolRegistry.ts](../src/tools/catalog/toolRegistry.ts) | 工具元数据：`buildToolRegistry` 为每个工具补全 risk/modes/tags/aliases/schema_digest；稳定 JSON 实现来自 `src/utils/stableJson.ts` |
| [toolSearch.ts](../src/tools/catalog/toolSearch.ts) | SafeToolSearch 搜索引擎（v0.9.0）：混合排序、意图分类、风险调整与历史成功率反馈 |
| [schemaDriftCheck.ts](../src/tools/diagnostics/schemaDriftCheck.ts) | Schema 漂移自检，供 doctor 消费 |
| [toolUsageStats.ts](../src/tools/catalog/toolUsageStats.ts) | 从 `invocation.log` 聚合工具调用统计 |
| [createTask.ts](../src/tools/tasks/createTask.ts) | `createTask` 任务创建：支持 saved/inline/template 来源及 `assess_only` 风险预评估 |
| [runTaskLoop.ts](../src/tools/tasks/runTaskLoop.ts) | **安全编排入口**：组合 create_task → wait_for_task → safe summaries → audit_task，支持 worktree 隔离和 Direct 验证 |
| [taskLineage.ts](../src/tools/tasks/taskLineage.ts) | 链路记录，写入 `.patchwarden/lineages/<lineage_id>/` |
| [evidencePack.ts](../src/tools/tasks/evidencePack.ts) | 证据包导出，不含 stdout/stderr、完整 diff 或敏感内容 |
| [auditTask.ts](../src/tools/diagnostics/auditTask.ts) | 独立审计，区分 confirmed failures、possible false positives 与 manual verification；文档扫描最多 200 个 Markdown、4 MiB 总内容，证据读取有界且超限产生 warning |
| [safeViews.ts](../src/tools/diagnostics/safeViews.ts) | `safe_*` 系列有界摘要；其中 audit/finalize 包装器会写审计或会话状态，风险元数据为 `workspace_write` |
| [healthCheck.ts](../src/tools/diagnostics/healthCheck.ts) | 返回 MCP catalog、watcher、workspace 与 agents 状态 |
| [waitForTask.ts](../src/tools/tasks/waitForTask.ts) | 长轮询任务，返回 continuation 或终态 acceptance 证据 |
| [androidDoctor.ts](../src/tools/workspace/androidDoctor.ts) | 只读诊断 Android 构建环境 |
| [releaseMode.ts](../src/tools/release/releaseMode.ts) | 发布模式四件套与项目策略入口 |
| [explainTool.ts](../src/tools/discovery/explainTool.ts) | 展开单个工具详情并做 schema drift 检测 |
| [syncFile.ts](../src/tools/workspace/syncFile.ts) | Direct 会话仓库内复制文件，统一校验会话状态、真实路径、UTF-8/大小、敏感路径/内容与 sha256，并在写入前复核源/目标未变化 |
| [goalSubgoalTask.ts](../src/tools/goals/goalSubgoalTask.ts) | 在 Goal mutation lock 内创建 subgoal 并关联新任务；以 Goal 保存的 `repo_path` 为权威，拒绝调用方仓库不一致，隔离 worktree 也从该仓库创建 |
| [mergeWorktree.ts](../src/tools/workspace/mergeWorktree.ts) | 合并隔离 worktree 的 branch 回主工作区 |
| [discardWorktree.ts](../src/tools/workspace/discardWorktree.ts) | 丢弃隔离 worktree并归档状态 |
| [runVerification.ts](../src/tools/tasks/runVerification.ts) | Direct 会话跑单条白名单验证命令 |
| [runDirectVerificationBundle.ts](../src/tools/direct/runDirectVerificationBundle.ts) | Direct 会话批量跑多个白名单验证命令并返回有界状态 |
| 其他工具 | `applyPatch.ts`/`searchWorkspace.ts`/`readWorkspaceFile.ts`/`savePlan.ts`/`getPlan.ts`/`listAgents.ts`/`listTasks.ts`/`listWorkspace.ts`/`cancelTask.ts`/`killTask.ts`/`retryTask.ts`/`reconcileTasks.ts`/`recommendAgentForTask.ts`/`diagnoseTask.ts`/`getTaskStatus.ts`/`getTaskSummary.ts`/`getTaskProgress.ts`/`getTaskStdoutTail.ts`/`getTaskFile.ts`/`taskOutputs.ts`/`taskTemplates.ts`/`auditSession.ts`/`createDirectSession.ts`/`finalizeDirectSession.ts`/`discoverTools.ts`/`invokeDiscoveredTool.ts`/`safeStatus.ts`/`checkReleaseGate.ts` 等 |

### 4.6 Dispatch 子模块（src/tools/dispatch/）

v1.5.1 引入的按业务领域分组的工具分派层，将原先 `registry.ts` 中庞大的 switch 拆分为 5 个 handler map。

| 文件 | 职责 |
| --- | --- |
| [types.ts](../src/tools/dispatch/types.ts) | 定义 `ToolHandler`、`ToolHandlerMap` 类型与 `toResult` 辅助函数（将任意数据 JSON 序列化为 MCP `CallToolResult` 信封） |
| [coreDispatch.ts](../src/tools/dispatch/coreDispatch.ts) | 核心任务管理 handler（30+ 工具）：`save_plan`/`get_plan`/`create_task`/`run_task_loop`/`wait_for_task`/`audit_task`/`safe_*`/`list_*`/`cancel_task`/`kill_task`/`retry_task`/`reconcile_tasks`/`check_release_gate`/`health_check` 等；导出条件注册的 `runTaskHandler` |
| [diagnosticDispatch.ts](../src/tools/dispatch/diagnosticDispatch.ts) | 诊断/发现类 handler：`discover_tools`/`explain_tool`/`invoke_discovered_tool`；后者通过 `dispatch` 回调把请求转回 `handleToolCall` 实现"发现 → 调用"闭环 |
| [directDispatch.ts](../src/tools/dispatch/directDispatch.ts) | Direct session handler（9 个）：所有 handler 前置 `guardDirectProfileEnabled()` 守卫；`create_direct_session`/`search_workspace`/`apply_patch`/`run_verification`/`run_direct_verification_bundle`/`finalize_direct_session`/`audit_session`/`sync_file`/`safe_direct_*` |
| [goalDispatch.ts](../src/tools/dispatch/goalDispatch.ts) | Goal Session handler（12 个）：`create_goal`/`list_goals`/`read_goal`/`create_subgoal_task`/`accept_subgoal`/`reject_subgoal`/`suggest_next_subgoal`/`summarize_goal_progress`/`export_handoff`/`export_goal_report`/`import_speckit_tasks`/`merge_worktree`/`discard_worktree` |
| [releaseDispatch.ts](../src/tools/dispatch/releaseDispatch.ts) | Release mode handler（4 个）：`release_check`/`release_prepare`/`release_verify`/`release_cleanup` |

**集成方式**：`registry.ts` 的 `buildDispatchMap()` 通过对象 spread 合并 5 个 handler map，并在 `enableRunTaskTool===true` 时条件加入 `runTaskHandler`。`registerTools` 启动时校验"每个已注册工具必有 handler"，但反向不校验。`handleToolCallInternal` 通过 `dispatchMap[name]` 查表分派。

### 4.7 Goal 模块（src/goal/）

v0.8.0 引入的多任务编排层。

| 文件 | 职责 |
| --- | --- |
| [goalStore.ts](../src/goal/goalStore.ts) | Goal Session 目录 CRUD；同步/异步状态变更共享跨进程 mutation lock 并原子替换，非空 Goal 的全部子目标 accepted 后自动转为 `completed`；目录结构 `.patchwarden/goals/{goal_id}/` 含 `GOAL.md`/`GOALS.md`/`goal_status.json`/`tasks/`/`artifacts/` |
| [goalGraph.ts](../src/goal/goalGraph.ts) | 依赖图：`suggestNextSubgoal` 返回依赖已满足的下一个子目标 |
| [goalStatus.ts](../src/goal/goalStatus.ts) | `GoalStatus`/`Subgoal` 类型与 `createInitialGoalStatus` |
| [goalProgress.ts](../src/goal/goalProgress.ts) | `acceptSubgoal`/`rejectSubgoal`/`summarizeGoalProgress` |
| [goalReport.ts](../src/goal/goalReport.ts) | `exportGoalReport` 导出结构化最终报告（v1.5.1） |
| [handoffExport.ts](../src/goal/handoffExport.ts) | `exportHandoff` 导出 `handoff.md` 用于会话交接 |
| [specKitImport.ts](../src/goal/specKitImport.ts) | `parseSpecKitJson`/`importSpecKitTasks` 导入 Spec Kit 任务（v1.5.1） |
| [subgoalSync.ts](../src/goal/subgoalSync.ts) | 子目标与任务关联同步 |
| [acceptanceEngine.ts](../src/goal/acceptanceEngine.ts) | 验收引擎 |
| [acceptanceTemplate.ts](../src/goal/acceptanceTemplate.ts) | 验收模板 |
| [worktreeManager.ts](../src/goal/worktreeManager.ts) | `createWorktree`/`mergeWorktree`/`discardWorktree` 管理 git worktree 隔离；三类仓库变更共享跨进程 repository lifecycle lock |

### 4.8 Direct 模块（src/direct/）

v0.6.0 引入的 ChatGPT 直接编辑模式。

| 文件 | 职责 |
| --- | --- |
| [directSessionStore.ts](../src/direct/directSessionStore.ts) | Direct Session CRUD：原子创建/更新记录，锁内追加 operations/verification_runs；workspace mutation 锁串行化 patch/sync/verify/finalize/audit；审计后持久化 `audited=true` |
| [directGuards.ts](../src/direct/directGuards.ts) | Direct 守卫：`guardDirectSessionActive`/`guardDirectSessionFinalized`/`guardDirectPath`/`guardDirectReadPath`/`guardDirectWritePath`/`guardDirectPatchSize`/`isBinaryFile` |
| [directPatch.ts](../src/direct/directPatch.ts) | JSON patch 应用：支持 `replace_exact`/`insert_before`/`insert_after`/`replace_whole_file`；同一次读取校验 `expected_sha256`、UTF-8、文件大小和敏感内容，原子替换前复核路径/内容未变化 |
| [directAudit.ts](../src/direct/directAudit.ts) | 17 项确定性审计，包含 diff 凭据型内容检查，返回 pass/warn/fail 并原子写入审计证据 |
| [directVerification.ts](../src/direct/directVerification.ts) | 白名单验证命令执行 |

### 4.9 Control 模块（src/control/）

v1.5.1 将原 `controlCenter.ts` 拆分为聚焦的路由/中间件/运行时/共享模块，保持入口和 HTTP 行为不变。

```text
shared.ts (配置 bootstrap / 路径常量 / controlToken / HTTP helper)
  ├─ runtime.ts (健康探测 / stale 分类 / 事件时间线 / 隐藏 ID)
  ├─ middleware/
  │   ├─ auth.ts   (control token 校验)
  │   └─ static.ts (ui/ 静态文件服务)
  └─ routes/
      ├─ 只读: audit / evidence / lineage / policy / sessions / status / tasks / workspace
      └─ 变更: process / taskActions
```

| 文件 | 职责 |
| --- | --- |
| [server.ts](../src/control/server.ts) | HTTP 服务创建、回环 Host/DNS rebinding 前置校验、防嵌入响应头、`handleRequest` 路由分发、POST control-token 校验、bootstrap/shutdown 生命周期 |
| [shared.ts](../src/control/shared.ts) | 共享基础设施：容错配置加载、路径常量、内存 `controlToken = randomUUID()`、端口解析、`sendJson`/`readBody`/`readJsonFileSafe`/`readJsonFileSafeUnder`（带 realpath 校验）/`readFileTail`/`findLatestLog`/`isPathInside` |
| [runtime.ts](../src/control/runtime.ts) | `probeHealthStatus`/`probeRuntimeHealth` 健康探测；`classifyStaleTask`/`augmentTaskWithStale` 四条 stale 规则；`writeStatusFile`/`recordEvent`/`readEvents`；`isValidTaskId`/`isValidDirectSessionId` 校验；`readHiddenStaleIds`/`readHiddenDirectSessionIds` 隐藏 ID |
| [middleware/auth.ts](../src/control/middleware/auth.ts) | `checkControlToken` 校验 `x-patchwarden-control-token`；复用 `security/loopbackHost.ts` 拒绝非回环 Host |
| [middleware/static.ts](../src/control/middleware/static.ts) | `serveStatic`/`serveFavicon`，三层路径遍历防护（NUL 拒绝、`..` 段拒绝、`relative()` 词法校验） |
| [routes/audit.ts](../src/control/routes/audit.ts) | `handleLogs`（core/direct/watcher/control-center 四类日志，经 `redactSensitiveContent` 脱敏）；`handleAudit`（聚合 audit.json 限 50 条）；`handleWarnings`（7 类警告桶） |
| [routes/evidence.ts](../src/control/routes/evidence.ts) | 证据包列表/详情/导出（POST） |
| [routes/lineage.ts](../src/control/routes/lineage.ts) | lineage 列表/详情（限 50，`toSafeTaskLineage` 投影） |
| [routes/policy.ts](../src/control/routes/policy.ts) | 项目策略 + release 就绪状态（只读，`remote_write_performed` 始终 false） |
| [routes/process.ts](../src/control/routes/process.ts) | 进程生命周期代理：start/stop/restart core/direct/all；preflight + spawn + waitForStartup；`classifySupervisorFailure` 8 类失败归类 |
| [routes/sessions.ts](../src/control/routes/sessions.ts) | Direct session 列表/详情/安全摘要/finalize/audit/hide |
| [routes/status.ts](../src/control/routes/status.ts) | 主轮询端点 `/api/status`：10 路 Promise.all 并发探测 + 6 类建议；`/api/control-center-status`/`/api/events`/`/api/tunnel-ui-url`/`/api/diagnostics` |
| [routes/taskActions.ts](../src/control/routes/taskActions.ts) | 变更性任务操作：reconcile/audit_task/open-task-folder/hide-stale |
| [routes/tasks.ts](../src/control/routes/tasks.ts) | 只读任务查询：列表过滤/stale 任务/任务详情/safe 视图（safe-result/audit/test-summary/diff-summary） |
| [routes/workspace.ts](../src/control/routes/workspace.ts) | 工作区列表、repo 列表（含 package.json 元数据）、单 repo `git status --short` |

### 4.10 Desktop 子包（desktop/）

v1.6.0 引入的 Electron 桌面应用，作为 Control Center 的 Windows GUI 外壳。

| 文件 | 职责 |
| --- | --- |
| [desktop/src/main.ts](../desktop/src/main.ts) | 入口：单实例锁、BrowserWindow（1280x800，`contextIsolation`/`sandbox`/`nodeIntegration:false`）、Tray、IPC 注册、后端生命周期（`utilityProcess.fork` 拉起主仓 `dist/controlCenter.js`）；模式机 `starting/setup/setup-check/ready/blocked`；`allowedSender` 限制 IPC 来源 |
| [desktop/src/agent-adapters.ts](../desktop/src/agent-adapters.ts) | `AGENT_ADAPTERS` 8 个适配器（codex/opencode/claude/gemini/copilot/qwen/kimi/aider）；`detectAgents()` 用 `where.exe`/`which` 查找；`selectAgentLaunch()` 安全选择原生 exe（Win 跳 `WindowsApps`、强制 `.exe/.com`）或验证 npm 包 bin 入口；`refreshAgentModels()` 跑 `refreshArgs` 过滤模型 token；`validateModelId()` |
| [desktop/src/agent-detection.ts](../desktop/src/agent-detection.ts) | 纯 re-export 门面，把 `selectAgentLaunch` 以 `selectAgentExecutable` 别名导出 |
| [desktop/src/backend-probe.ts](../desktop/src/backend-probe.ts) | `probeControlCenter()` GET `/api/diagnostics`，返回 `kind: patchwarden/foreign/absent/mismatched_patchwarden`；`configIdentity()` = 规范化路径 sha256；`mayStopBackend()` 校验 owned child 身份一致性 |
| [desktop/src/backend-lifecycle.ts](../desktop/src/backend-lifecycle.ts) | owned backend 停止时等待 `exit` 或有界超时；配置变更触发的 restart 由 generation scheduler 串行化、合并 debounce 请求且不丢活动重启期间的新请求 |
| [desktop/src/child-environment.ts](../desktop/src/child-environment.ts) | 为 Desktop-owned utility/spawn 子进程构造最小运行环境；provider 变量必须显式 allow-list，Control/Tunnel owner credential 始终阻断；Windows PowerShell 与 `where.exe` 固定解析到仓库外的系统目录 |
| [desktop/src/config-store.ts](../desktop/src/config-store.ts) | 配置/偏好/运行时设置持久化：`resolveDesktopPaths()`（`%LOCALAPPDATA%\PatchWarden`）；`buildConfig()` 生成 `patchwarden.config.json`；`normalizeProxyEndpoint()` 校验 http/https/socks5 禁止 URL 凭证；`atomicWriteJson()` 带 `.bak-{stamp}` 备份 + `.tmp-{pid}` 原子 rename |
| [desktop/src/model-discovery.ts](../desktop/src/model-discovery.ts) | `discoverModelsForAgent(id, workspaceRoot)`：读取各 Agent 的 home/工作区配置（TOML/JSONC/YAML），`safeRead()` 拒绝符号链接、>1MB、project-scoped 逃逸（`realpathSync` 比对 workspaceRoot）；`MAX_CONFIG_BYTES=1MB`；按适配器抽取模型字段；只读 |
| [desktop/src/runtime-root.ts](../desktop/src/runtime-root.ts) | `resolveCoreRoot()`：打包态 → `resourcesPath/core`，开发态 → `desktopRoot/..`；`utilityProcessOptions()` 提供 cwd/env/stdio/serviceName |
| [desktop/src/runtime-settings.ts](../desktop/src/runtime-settings.ts) | `validateTunnelClientPath()` 强制绝对路径 + 文件名 `tunnel-client.exe` + 存在；`detectTunnelClient()` 多源查找（config/env/PATH/LOCALAPPDATA/APPDATA/USERPROFILE）；`boundedSiblingSearch()` BFS 深度≤2、≤2000 条目 |
| [desktop/src/tunnel-provisioner.ts](../desktop/src/tunnel-provisioner.ts) | `getTunnelSetupStatus()` 报告程序/profile/凭证/tunnel_id 掩码/doctor 状态；`provisionTunnelProfile()` spawn PowerShell `scripts/control/provision-patchwarden-tunnel.ps1`，runtimeKey 走 stdin，60s 超时，输出 key 被 `[REDACTED]` 替换，env 剥离 `CONTROL_PLANE_API_KEY`；`revalidateTunnelProfile()`/`forgetTunnelCredential()`/`maskTunnelId()` |

**支持的 8 种 Agent 适配器**：

| id | displayName | npmPackage / nativePackage | buildArgs | refreshArgs |
| --- | --- | --- | --- | --- |
| `codex` | Codex CLI | `@openai/codex` | `exec --cd {repo} --model <m> {prompt}` | — |
| `opencode` | OpenCode | native `opencode-ai` | `run --model <m> {prompt}` | `models` |
| `claude` | Claude Code | `@anthropic-ai/claude-code` | `--print --permission-mode acceptEdits --model <m> {prompt}` | — |
| `gemini` | Gemini CLI | `@google/gemini-cli` | `--prompt {prompt} --approval-mode auto_edit --model <m>` | — |
| `copilot` | GitHub Copilot CLI | `@github/copilot` | `-p {prompt} --allow-tool write --deny-tool shell --model <m>` | `help` |
| `qwen` | Qwen Code | `@qwen-code/qwen-code` | `--prompt {prompt} --approval-mode auto_edit --model <m>` | — |
| `kimi` | Kimi Code | —（仅原生） | `--prompt {prompt} --work-dir {repo} --model <m>` | — |
| `aider` | Aider | —（仅原生） | `--message {prompt} --model <m>` | `--list-models ""` |

### 4.11 其他模块

| 文件 | 职责 |
| --- | --- |
| [src/agents/agentRouter.ts](../src/agents/agentRouter.ts) | Agent 路由：`routeAgent` 按 scope 文件数与关键词推荐 agent（largeScope→opencode、singleFile→direct、audit→patchwarden-audit、refactor→codex、documentation→claude） |
| [src/policy/projectPolicy.ts](../src/policy/projectPolicy.ts) | 仓库级策略：`getProjectPolicySummary` 解析 `.patchwarden/project-policy.json`；`commandAllowedByProjectPolicy`/`isProtectedByProjectPolicy`；含 `DANGEROUS_COMMAND_RE` 防护 |
| [src/release/releaseGate.ts](../src/release/releaseGate.ts) | v1.0.0 五阶段发布门：`local_ready` → `packed_ready` → `published_verified` → `github_release_verified` → `ci_verified`；远程阶段仅用 `node:https` GET，网络错误返回 `not_checked` |
| [src/assessments/agentAssessor.ts](../src/assessments/agentAssessor.ts) | `runAgentAssessment` 调用 agent 执行只读风险评估，输出 `===ASSESSMENT_JSON===` 标记后的结构化结果 |
| [src/assessments/assessmentStore.ts](../src/assessments/assessmentStore.ts) | Assessment 记录存储与 freshness 校验 |
| [src/runner/taskRuntime.ts](../src/runner/taskRuntime.ts) | `runtime.json` 浅合并读写，含 PID 重用与孤儿任务检测字段 |
| [src/runner/taskProgress.ts](../src/runner/taskProgress.ts) | `progress.md` 生成，6 阶段标记（`[x]`/`[>]`/`[ ]`） |
| [src/watcherStatus.ts](../src/watcherStatus.ts) | `readWatcherStatus` 心跳读取 + task heartbeat fallback + watcher ownership 检测 |

---

## 5. 关键类与函数说明

### 5.1 核心类型

#### `PatchWardenConfig`（[src/config.ts](../src/config.ts)）

```typescript
interface PatchWardenConfig {
  workspaceRoot: string;              // 工作区根目录（唯一允许访问）
  plansDir: string;                   // 计划目录，相对 workspaceRoot
  tasksDir: string;                   // 任务目录，相对 workspaceRoot
  assessmentsDir: string;             // 评估目录
  assessmentTtlSeconds: number;       // 评估 TTL（60-86400）
  agents: Record<string, AgentConfig>; // Agent 白名单
  allowedTestCommands: string[];      // 全局测试命令白名单（精确匹配）
  repoAllowedTestCommands?: Record<string, string[]>; // 仓库专属命令
  maxReadFileBytes: number;           // 单次文件读取上限
  defaultTaskTimeoutSeconds: number;  // 默认任务超时
  maxTaskTimeoutSeconds: number;      // 最大任务超时
  watcherStaleSeconds: number;        // Watcher 心跳过期阈值（5-3600）
  toolProfile?: "full" | "chatgpt_core" | "chatgpt_direct" | "chatgpt_search";
  enableDirectProfile?: boolean;      // 是否启用 Direct 模式
  enableRunTaskTool?: boolean;        // 是否暴露 run_task 工具
  directSessionsDir: string;
  directSessionTtlSeconds: number;
  directMaxPatchBytes: number;
  directMaxFileBytes: number;
  directAllowedCommands?: string[];
  repoDirectAllowedCommands?: Record<string, string[]>;
  tunnelProxy?: { core?: { url: string }; direct?: { url: string } };
  httpPort?: number;
  http?: { ownerTokenEnv?: string };
  // ... 其他可选字段
}
```

#### `TaskStatus`（[src/tools/tasks/createTask.ts](../src/tools/tasks/createTask.ts)）

```typescript
type TaskStatus =
  | "pending" | "running" | "collecting_artifacts"
  | "done_by_agent"      // agent 自报完成，待验收
  | "accepted" | "rejected" | "needs_fix" | "blocked"  // v0.7.2 验收状态
  | "done"               // legacy 终态
  | "failed" | "failed_verification"
  | "failed_scope_violation" | "failed_policy_violation"
  | "failed_stale" | "orphaned"  // v0.7.0 进程死亡/孤儿
  | "canceled";
```

#### `PatchWardenError`（[src/errors.ts](../src/errors.ts)）

```typescript
class PatchWardenError extends Error {
  constructor(
    public readonly reason: string,      // 机器可读的错误码，如 "workspace_path_escape"
    message: string,                     // 人类可读描述
    public readonly suggestion: string,  // 修复建议
    public readonly blocked = true,      // 是否阻断操作
    public readonly details: Record<string, unknown> = {}
  );
}
```

#### `ToolCatalogSnapshot`（[src/tools/catalog/toolCatalog.ts](../src/tools/catalog/toolCatalog.ts)）

```typescript
interface ToolCatalogSnapshot {
  server_version: string;          // PATCHWARDEN_VERSION
  schema_epoch: string;            // TOOL_SCHEMA_EPOCH
  tool_profile: ToolProfile;
  tool_count: number;
  tool_names: string[];
  tool_manifest_sha256: string;    // 工具清单哈希，用于漂移检测
}
```

#### `ToolHandlerMap`（[src/tools/dispatch/types.ts](../src/tools/dispatch/types.ts)）

```typescript
type ToolHandler = (args?: unknown) => Promise<{ content: Array<{ type: string; text: string }> }>;
type ToolHandlerMap = Record<string, ToolHandler>;
function toResult(data: unknown): { content: Array<{ type: "text"; text: string }> };
```

### 5.2 核心函数

#### 配置加载

```typescript
// src/config.ts
function loadConfig(configPath?: string): PatchWardenConfig;  // 单例加载
function reloadConfig(configPath?: string): PatchWardenConfig; // 强制重载
function getConfig(): PatchWardenConfig;
function getTasksDir(config: PatchWardenConfig): string;
function getPlansDir(config: PatchWardenConfig): string;
function resolveWorkspaceRoot(config: PatchWardenConfig): string;
function getRepoAllowedTestCommands(config, repoPath): string[];
function normalizeRepoKey(value: string): string;
function comparablePath(value: string): string; // Windows 下以小写绝对路径比较 repo key
```

#### 安全守卫

```typescript
// src/security/commandGuard.ts
function guardAgentCommand(agent: string, config: PatchWardenConfig): AllowedCommand;
function guardTestCommand(testCommand: string, config, repoPath?): string;
function guardDirectCommand(command: string, config, repoPath?): string;
function sanitizePromptArg(prompt: string): string;

// src/security/pathGuard.ts
function guardPath(requestedPath, workspaceRoot, allowedPrefix?): string;
function guardReadPath(requestedPath, workspaceRoot, allowedPrefix?): string;
function guardWorkspacePath(inputPath, workspaceRoot): string;  // 用于 repo_path

// src/security/sensitiveGuard.ts
function isSensitivePath(filePath: string): boolean;
function guardSensitivePath(filePath: string): void;

// src/security/planGuard.ts
function guardPlanContent(title: string, content: string): void;

// src/security/riskEngine.ts
function assessRisk(input: RiskAssessmentInput): RiskAssessmentResult;
function collectRiskHints(input: RiskAssessmentInput): string[];

// src/security/runtimeGuard.ts
function guardRuntimeSelfModification(resolvedRepoPath: string): void;
// 使用平台感知的同路径/子路径比较，Windows 下忽略大小写

// src/security/contentRedaction.ts
function redactSensitiveContent(input: string): RedactionResult;
function redactSensitiveValue<T>(input: T): StructuredRedactionResult<T>;
```

#### 任务执行

```typescript
// src/runner/runTask.ts
async function runTask(taskId: string): Promise<TaskRunResult>;
// 编排完整生命周期，产出 16+ artifact

// src/runner/watch.ts（脚本入口，无导出）
// 每 4 秒轮询 pending 任务，pre-flight 校验后调用 runTask
// watcher owner lock + task claim lock 防止多实例重复执行

// src/runner/changeCapture.ts
async function captureRepoSnapshot(repoPath: string): Promise<RepoSnapshot>;
async function buildChangeArtifacts(repoPath, before, after): Promise<ChangeArtifacts>;
function extractExternalDirtyFiles(snapshot, repoPath, workspaceRoot): ExternalDirtyFile[];
function findNewExternalDirtyFiles(baseline, current): ExternalDirtyFile[];
async function buildArtifactManifest(changedFiles, repoPath, taskId?): Promise<ArtifactManifest>;
// 通过 nullDevice 在 Windows 使用 NUL、其他平台使用 /dev/null
```

#### MCP 工具

```typescript
// src/tools/registry.ts
function getToolDefs(): ToolDef[];  // 生成完整工具定义
function registerTools(server: Server): void;  // 绑定到 MCP Server
async function handleToolCall(name: string, args?): Promise<{ content }>;
function getToolCatalogSnapshot(): ToolCatalogSnapshot;
// dispatchMap 由 buildDispatchMap() 在模块加载时构造

// src/tools/dispatch/*.ts
export const coreHandlers: ToolHandlerMap;       // 30+ 核心工具
function buildDiagnosticHandlers(dispatchTool): ToolHandlerMap; // 注入 audited dispatcher，避免循环依赖
export const directHandlers: ToolHandlerMap;     // 9 个 Direct 工具
export const goalHandlers: ToolHandlerMap;       // 12 个 Goal 工具
export const releaseHandlers: ToolHandlerMap;    // 4 个 Release 工具
export const runTaskHandler: ToolHandler;        // 条件注册

// src/tools/tasks/createTask.ts
async function createTask(input: CreateTaskInput): Promise<CreateTaskResult>;
// 支持 assess_only 预评估与 execute 执行

// src/tools/tasks/runTaskLoop.ts
async function runTaskLoop(input: RunTaskLoopInput): Promise<RunTaskLoopOutput>;
// 安全编排入口，最多 5 轮迭代

// src/tools/diagnostics/auditTask.ts
function auditTask(taskId: string): AuditTaskOutput;
// 16+ 确定性检查，区分 confirmed_failures/possible_false_positives

// src/tools/tasks/waitForTask.ts
async function waitForTask(taskId: string, waitSeconds?: number): Promise<WaitResult>;
// 长轮询，返回 continuation_required 或终态证据

// src/tools/catalog/toolSearch.ts
function discoverTools(input, registry, tokenIssuer?, usageStatsProvider?): DiscoverToolsOutput;
function explainTool(input, registry, toolDefs?, tokenPeeker?): ExplainToolOutput | null;
function classifyQueryIntent(query): QueryIntent;
```

#### Goal Session

```typescript
// src/goal/goalStore.ts
function createGoal(repoPath, title, description, workspaceRoot?): { goal_id, goal_dir };
function listGoals(workspaceRoot?): GoalSummary[];
function readGoal(goalId, workspaceRoot?): GoalDetail;
function writeGoalStatus(goalId, status, workspaceRoot?): void;
function readGoalStatus(goalId, workspaceRoot?): GoalStatus;
function mutateGoalStatus<R>(goalId, mutation, workspaceRoot?): R;
async function mutateGoalStatusAsync<R>(goalId, mutation, workspaceRoot?): Promise<R>;
function generateGoalId(title: string, existingIds: string[]): string;  // goal_{YYYYMMDD}_{slug}

// src/goal/goalGraph.ts
function suggestNextSubgoal(goalStatus: GoalStatus): SubgoalSuggestion;

// src/goal/worktreeManager.ts
function createWorktree(goalId, subgoalId, workspaceRoot): WorktreeInfo;
function mergeWorktree(worktreeId, workspaceRoot): MergeResult;
function discardWorktree(worktreeId, workspaceRoot): DiscardResult;
```

#### Direct Session

```typescript
// src/direct/directSessionStore.ts
function generateDirectSessionId(): string;  // direct_{YYYYMMDD_HHMMSS}_{randomHex32}
function createDirectSession(input: DirectSessionCreateInput): DirectSessionRecord;
function readDirectSession(sessionId: string): DirectSessionRecord;
function updateDirectSession(sessionId, patch): DirectSessionRecord;
function appendDirectSessionOperation(sessionId, operation): DirectSessionRecord; // 锁内 mutation + 原子替换
function finalizeDirectSessionRecord(sessionId, artifacts): DirectSessionRecord;
function validateDirectSessionFreshness(session): DirectSessionValidationResult;

// src/direct/directGuards.ts
function guardDirectSessionActive(session: DirectSessionRecord): void;
function guardDirectPath(filePath, resolvedRepoPath, workspaceRoot): string;
function guardDirectReadPath(session, requestedPath): string;
function guardDirectWritePath(session, requestedPath): string;
function guardDirectPatchSize(patchBytes: number): void;
function isBinaryFile(filePath: string): boolean;
```

#### Discovery Token

```typescript
// src/security/discoveryTokenStore.ts
function issueToken(input: IssueTokenInput): string;  // dst_{YYYYMMDD}_{randomHex12}
function consumeToken(tokenId: string): DiscoveryTokenRecord;  // 单次使用，消费后删除
function peekToken(tokenId: string): DiscoveryTokenRecord | null;
function revokeToken(tokenId: string): boolean;
// 签发时清理过期记录，活动 token 上限为 1024
```

#### Control Center

```typescript
// src/control/server.ts
function startServer(): Server;  // 启动 HTTP 服务，绑定 127.0.0.1

// src/control/runtime.ts
function probeHealthStatus(url: string): Promise<HealthProbe>;
function classifyStaleTask(task, watcher, nowMs): StaleClassification;
function recordEvent(type: string, payload: object): void;
function readEvents(limit: number): EventRecord[];
function isValidTaskId(taskId: string): boolean;
function isValidDirectSessionId(sessionId: string): boolean;
// append 与 trim 在同一跨进程文件锁内执行，裁剪结果使用原子替换提交

// src/control/middleware/auth.ts
function checkControlToken(req: IncomingMessage): boolean;
// 使用 crypto.timingSafeEqual，并先校验 Buffer 长度
```

---

## 6. 数据流与状态机

### 6.1 标准任务工作流

```text
1. health_check          → 确认版本、工作区、Watcher、工具目录
2. list_agents           → 确认本地 Agent 命令可用
3. list_workspace        → 确定 repo_path
4. save_plan             → 保存计划（或使用 inline_plan/template）
5. create_task           → 明确 Agent、仓库、验证命令
6. wait_for_task         → 短任务用 timeout_seconds:25；长任务用 list_tasks 轮询
7. get_task_summary(compact) → 先看有界结构化总结
8. get_result_json / get_diff / get_test_log → 按需查看细节
9. audit_task            → 独立核对执行结果
10. 人工决定接受/提交/发布
```

### 6.2 任务状态机

```text
pending ──(Watcher 拉取)──▶ running ──(agent 退出)──▶ collecting_artifacts
                                                                  │
                                  ┌───────────────────────────────┤
                                  ▼                               ▼
                          done_by_agent                    failed / failed_verification
                                  │                               │
                  ┌───────────────┼───────────────┐               │
                  ▼               ▼               ▼               ▼
              accepted       rejected        needs_fix    failed_scope_violation
                                                              failed_policy_violation
                                                              failed_stale / orphaned
                                                              canceled
```

### 6.3 任务产物

| 文件 | 用途 |
| --- | --- |
| `status.json` | 当前状态、阶段、心跳和错误信息 |
| `progress.md` | Agent 写入的进度记录 |
| `result.md` | 人类可读的执行报告 |
| `result.json` | 结构化结果、路径、变更、警告和后续建议 |
| `diff.patch` | 最多 20 MiB 的任务差异证据；疑似凭据在落盘前脱敏，超限显式标记截断 |
| `artifact_manifest.json` | 构建或发布产物的路径、类型、大小与 SHA-256 |
| `file-stats.json` | 文件级增删统计 |
| `verify.json` | 每条独立验证命令的结构化记录 |
| `verify.log` | 独立验证的可读日志 |
| `test.log` | Agent 执行过程中产生的测试输出 |
| `git-before.json` / `git-after.json` | 任务前后仓库快照 |
| `changed-files.json` | 变更文件列表 |
| `independent-review.md` | `audit_task` 写入的独立审计报告 |
| `runtime.json` | 子进程 PID、心跳、deadline |
| `error.log` | 错误日志 |
| `post-task-cleanup.json` | 清理报告 |
| `reconcile.json` | Control Center reconcile 写入的注解 |

资源边界也适用于读取和持续日志：普通任务产物受 `maxReadFileBytes` 限制，
diff/summary/log tail 使用有界前缀或尾部读取；`audit_task` 的 Markdown 扫描上限为
200 个文件、4 MiB 总内容。`invocation.log` 与 `reconcile.log` 在跨进程锁内有界追加，
达到上限后保留最近内容并写入截断标记，避免无界内存和磁盘增长。

### 6.4 run_task_loop 编排流

`run_task_loop` 是 v1.2 引入的安全编排入口，它只组合现有工具，不绕过任何守卫：

```text
runTaskLoop(input)
  │
  ├─ guardWorkspacePath(repo_path)
  ├─ resolveAgentRouting(agent="auto" → recommendAgentForTask)
  ├─ createLineageId + 初始化 lineage 记录
  │
  └─ for round in 1..max_iterations:
       ├─ create_task(template, goal, verify_commands, agent)
       ├─ waitForTask(task_id, timeout)
       ├─ safeResult + safeTestSummary + safeAudit
       │
       ├─ if high_risk && stop_on_high_risk → break
       ├─ if failed_verification && auto_fix_tests → 下一轮用 fix_tests 模板
       ├─ if done_by_agent/accepted → break
       └─ writeTaskLineage(round_record)
  │
  ├─ if direct_verify: createDirectSession → runDirectVerificationBundle → safeFinalize → safeAudit
  └─ writeTaskLineage(final) → 返回 SafeTaskLineage
```

---

## 7. 依赖关系

### 7.1 外部依赖

**主仓**（`package.json`）：

```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.29.0"
  },
  "devDependencies": {
    "@types/node": "^18.19.0",
    "typescript": "^6.0.3"
  },
  "engines": { "node": ">=18.0.0" }
}
```

**Desktop 子包**（`desktop/package.json`）：

```json
{
  "dependencies": {
    "jsonc-parser": "3.3.1",
    "smol-toml": "1.6.1",
    "yaml": "2.8.3"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "electron": "43.1.1",
    "electron-builder": "26.15.3"
  }
}
```

主仓运行时**仅依赖 MCP SDK**，所有其他功能使用 Node.js 内置模块：

- `node:fs` / `node:path` / `node:crypto` / `node:http` / `node:child_process` / `node:os` / `node:url` / `node:net` / `node:timers/promises`

### 7.2 模块依赖图（简化）

```text
index.ts / httpServer.ts
        │
        ▼
   tools/registry.ts ──────────┬── tools/dispatch/*.ts ── tools/tasks/*
        │                      │                          ├── tools/diagnostics/*
        │                      │                          ├── tools/workspace/*
        │                      │                          ├── tools/discovery/*
        │                      │                          ├── tools/catalog/*
        │                      │                          ├── tools/goals/*
        │                      │                          ├── direct/* (Direct 工具)
        │                      │                          ├── goal/* (Goal 工具)
        │                      │                          └── release/releaseGate.ts
        │
        ▼
   config.ts ──── security/* (所有守卫)
        │
        ▼
   runner/watch.ts ──▶ runner/runTask.ts ──▶ runner/changeCapture.ts
                                          ├── runner/agentInvocation.ts
                                          ├── runner/postTaskCleanup.ts
                                          └── runner/simpleProcess.ts

controlCenter.ts ──▶ control/server.ts ──┬── control/shared.ts
                                          ├── control/runtime.ts
                                          ├── control/middleware/{auth,static}.ts
                                          └── control/routes/*.ts (10 个领域)

desktop/main.mjs ──▶ desktop/{agent-adapters,model-discovery,config-store,
                                tunnel-provisioner,runtime-settings,runtime-root,
                                backend-probe}.mjs
                  └─ utilityProcess.fork ──▶ dist/controlCenter.js (主仓)
```

### 7.3 关键依赖关系

- **所有写操作** → 必须经 `security/*` 守卫
- **`createTask`** → `riskEngine.assessRisk` → `pathGuard` + `commandGuard` + `planGuard` + `runtimeGuard` + `sensitiveGuard`
- **`runTask`** → `agentInvocation.buildAgentInvocation` → `commandGuard.guardAgentCommand`
- **`runTask`** → `changeCapture.captureRepoSnapshot` + `buildChangeArtifacts`
- **`runTaskLoop`** → 组合 `createTask` + `waitForTask` + `safeViews` + `auditTask`，不直接调用 `runTask`
- **`watch.ts`** → pre-flight 调用 `guardWorkspacePath` + `guardAgentCommand` + `guardTestCommand` 后才调用 `runTask`
- **`invokeDiscoveredTool`** → `discoveryTokenStore.consumeToken` + `toolInvocationGuard.checkInvocation` + 实际 handler 内二次校验
- **`registry.ts`** → 模块加载时 `buildDispatchMap()` 一次性合并 5 个 handler map（配置热重载后不会刷新）
- **`control/server.ts`** → POST 路由统一前置 `checkControlToken`，route 文件本身不重复校验
- **`desktop/main.mjs`** → `utilityProcess.fork` 拉起主仓 `dist/controlCenter.js`，通过 `127.0.0.1:8090` 通信

---

## 8. 项目运行方式

### 8.1 环境要求

- Node.js ≥ 18
- npm
- Git（可选，但无 Git 无法生成可靠 `git.diff`）
- 至少一个本地编程 Agent（OpenCode / Codex / Claude Code / Gemini / Copilot / Qwen / Kimi / Aider）
- Windows Tunnel 模式还需 `tunnel-client.exe`、Tunnel ID、运行时 API Key
- 桌面打包需要 Windows x64 + Electron

### 8.2 从源码运行（推荐）

```powershell
git clone https://github.com/jiezeng2004-design/PatchWarden.git
cd .\PatchWarden
npm.cmd ci
npm.cmd run build
Copy-Item .\examples\config.example.json .\patchwarden.config.json
```

编辑 `patchwarden.config.json`，至少修改 `workspaceRoot`、`agents`、`allowedTestCommands`。

### 8.3 配置文件

配置路径通过 `PATCHWARDEN_CONFIG` 环境变量指定：

```powershell
$env:PATCHWARDEN_CONFIG = "D:\path\to\patchwarden.config.json"
```

查找顺序：
1. `PATCHWARDEN_CONFIG` 环境变量指定的路径
2. `{cwd}/patchwarden.config.json`
3. `{cwd}/.patchwarden.json`

最小配置示例：

```json
{
  "workspaceRoot": "D:/ai_agent/codex_program",
  "plansDir": ".patchwarden/plans",
  "tasksDir": ".patchwarden/tasks",
  "toolProfile": "full",
  "agents": {
    "opencode": { "command": "opencode", "args": ["run", "{prompt}"], "envAllowlist": [] },
    "codex": { "command": "codex", "args": ["exec", "--cd", "{repo}", "{prompt}"], "envAllowlist": [] }
  },
  "allowedTestCommands": ["npm test", "npm run build", "npm run lint", "pytest"],
  "maxReadFileBytes": 200000,
  "defaultTaskTimeoutSeconds": 900,
  "maxTaskTimeoutSeconds": 3600,
  "watcherStaleSeconds": 30,
  "httpPort": 7331
}
```

`agents` 是显式执行白名单；未登记的 Agent 不可启动。Agent 子进程默认不继承 provider 环境变量，仅转发对应 `envAllowlist` 中明确列出的变量，Tunnel/HTTP owner credential 始终禁止转发。`workspaceRoot` 在配置加载时 fail closed：路径缺失、不可访问、不是目录，或指向盘符根目录、用户主目录、Desktop、Downloads、Documents 时都会拒绝启动。

### 8.4 核心命令

| 命令 | 用途 |
| --- | --- |
| `npm.cmd run build` | TypeScript 编译到 `dist/` |
| `npm.cmd run doctor` | 只读诊断（检查 15+ 项） |
| `npm.cmd run doctor:ci` | CI 诊断（允许默认配置） |
| `npm.cmd run watch` | 启动 Watcher（轮询 pending 任务） |
| `npm.cmd start` | 启动 stdio MCP Server |
| `npm.cmd run start:http` | 启动 HTTP MCP Server（127.0.0.1:7331） |
| `npm.cmd run start:control` | 启动 Control Center Dashboard（127.0.0.1:8090） |
| `npm.cmd test` | 完整测试链（smoke + unit + lifecycle + doctor + tunnel + watcher + control + mcp + brand） |
| `npm.cmd run test:unit` | 仅单元测试 |
| `npm.cmd run test:mcp` | MCP 烟雾测试 |
| `npm.cmd run test:http-mcp` | HTTP MCP 烟雾测试 |
| `npm.cmd run check:tool-manifest` | 工具 Manifest 校验 |
| `npm.cmd run pack:clean` | 打包清理 |
| `npm.cmd run verify:package` | 包清单校验 |
| `npm.cmd run desktop:install` | 安装 desktop 子包依赖 |
| `npm.cmd run desktop:test` | desktop 单元测试 |
| `npm.cmd run desktop:package` | 打包 Windows NSIS 安装包 + ZIP |

### 8.5 启动顺序

完整链路需要三个独立进程：

**终端 1 — Watcher**：

```powershell
$env:PATCHWARDEN_CONFIG = (Resolve-Path .\patchwarden.config.json)
npm.cmd run watch
```

**终端 2 — MCP Server**（stdio 或 HTTP 二选一）：

```powershell
# stdio（供 OpenCode/Codex 直接连）
$env:PATCHWARDEN_CONFIG = (Resolve-Path .\patchwarden.config.json)
npm.cmd start

# 或 HTTP（供 Tunnel 或远程客户端）
npm.cmd run start:http
```

**终端 3 — Control Center**（可选）：

```powershell
npm.cmd run start:control
```

### 8.6 Windows 一键启动

```text
PatchWarden.cmd start core      # 启动 Core Agent 模式（chatgpt_core + Watcher + Tunnel）
PatchWarden.cmd start direct    # 启动 Direct 模式（chatgpt_direct + Tunnel，无 Watcher）
PatchWarden.cmd stop all        # 停止所有受控进程
PatchWarden.cmd restart all     # 重启所有受控进程
PatchWarden.cmd status all      # 查看运行状态
PatchWarden.cmd health          # 深度健康检查
PatchWarden.cmd kill all        # 强制清理
scripts\launchers\PatchWarden-Desktop.cmd         # 启动 Desktop 应用（托盘 + Control Center）
```

### 8.7 MCP 客户端接入

**OpenCode**（`%USERPROFILE%\.config\opencode\opencode.jsonc`）：

```jsonc
{
  "mcp": {
    "patchwarden": {
      "type": "local",
      "command": ["node", "D:/path/to/PatchWarden/dist/index.js"],
      "environment": {
        "PATCHWARDEN_CONFIG": "D:/path/to/PatchWarden/patchwarden.config.json",
        "PATCHWARDEN_TOOL_PROFILE": "full"
      },
      "enabled": true
    }
  }
}
```

**Codex**（`%USERPROFILE%\.codex\config.toml`）：

```toml
[mcp_servers.patchwarden]
command = "node"
args = ["D:\\path\\to\\PatchWarden\\dist\\index.js"]

[mcp_servers.patchwarden.env]
PATCHWARDEN_CONFIG = "D:\\path\\to\\patchwarden.config.json"
PATCHWARDEN_TOOL_PROFILE = "full"
```

### 8.8 HTTP MCP 端点

| 端点 | 方法 | 用途 |
| --- | --- | --- |
| `/mcp` | POST | MCP 请求（需 owner token） |
| `/healthz` | GET | 健康检查 |
| `/readyz` | GET | 就绪检查（不就绪返回 503） |
| `/admin/tasks/:id/accept` | POST | 人工接受任务 |
| `/admin/tasks/:id/reject` | POST | 人工拒绝任务 |
| `/admin/tasks/:id/acceptance` | GET | 读取验收状态 |

### 8.9 Control Center API 端点（127.0.0.1:8090）

| 端点 | 方法 | 用途 |
| --- | --- | --- |
| `/api/status` | GET | 主轮询端点（10 路并发探测 + 6 类建议） |
| `/api/tasks` | GET | 任务列表（支持 repo_path/status/acceptance_status/agent/warning_type 过滤） |
| `/api/tasks/:id` | GET | 任务详情（含配置上限内的脱敏 diff/test_log） |
| `/api/tasks/:id/safe-result` | GET | safe 任务结果摘要 |
| `/api/tasks/:id/safe-audit` | GET | safe 审计摘要 |
| `/api/tasks/:id/safe-test-summary` | GET | safe 测试摘要 |
| `/api/tasks/:id/safe-diff-summary` | GET | safe 差异摘要 |
| `/api/tasks/stale` | GET | stale 任务列表 |
| `/api/tasks/:id/reconcile` | POST | reconcile 任务状态 |
| `/api/tasks/:id/audit` | POST | 运行 audit_task |
| `/api/tasks/:id/hide-stale` | POST | 隐藏 stale 任务 |
| `/api/direct-sessions` | GET | Direct session 列表 |
| `/api/direct-sessions/:id/finalize` | POST | finalize Direct session |
| `/api/direct-sessions/:id/audit` | POST | audit Direct session |
| `/api/direct-sessions/:id/hide` | POST | 隐藏 Direct session |
| `/api/lineages` | GET | lineage 列表 |
| `/api/lineages/:id` | GET | lineage 详情 |
| `/api/evidence-packs` | GET | 证据包列表 |
| `/api/evidence-packs/:id/export` | POST | 导出证据包 |
| `/api/workspace` | GET | 工作区信息 |
| `/api/workspace/repos` | GET | 工作区 repo 列表 |
| `/api/workspace/:repo/status` | GET | 单 repo git status |
| `/api/project-policy` | GET | 项目策略 |
| `/api/release/status` | GET | release 就绪状态 |
| `/api/diagnostics` | GET | 诊断信息（脱敏） |
| `/api/warnings` | GET | 警告聚合（7 类） |
| `/api/audit` | GET | 审计聚合 |
| `/api/logs/:category` | GET | 日志 tail（core/direct/watcher/control-center） |
| `/api/events` | GET | 事件时间线 |
| `/api/control-center-status` | GET | Control Center 自身状态 |
| `/api/start-all` `/stop-all` `/restart-all` | POST | 进程管理（需 control token） |
| `/api/core/start` `/core/stop` | POST | Core 进程管理 |
| `/api/direct/start` `/direct/stop` | POST | Direct 进程管理 |

---

## 9. 安全设计

### 9.1 安全分层

```text
┌─────────────────────────────────────────────────┐
│  MCP 客户端（ChatGPT/Codex/OpenCode）            │  ← 模型指令被视为不可信输入
├─────────────────────────────────────────────────┤
│  tools/registry.ts                              │  ← 工具注册 + Profile 过滤
│  tools/dispatch/*.ts                            │  ← 按领域分派
│  toolInvocationGuard (8 项调用前校验)            │
├─────────────────────────────────────────────────┤
│  security/pathGuard     ← 路径横移防护           │
│  security/commandGuard  ← 命令白名单             │
│  security/sensitiveGuard ← 敏感文件阻断          │
│  security/planGuard     ← 计划内容审查           │
│  security/runtimeGuard  ← 运行时自修改阻断       │
│  security/riskEngine    ← 综合风险评估           │
├─────────────────────────────────────────────────┤
│  runner/runTask.ts       ← 心跳/超时/cancel      │
│  runner/changeCapture.ts ← 作用域违规检测        │
│  runner/postTaskCleanup.ts ← 受控清理            │
├─────────────────────────────────────────────────┤
│  security/contentRedaction ← 输出脱敏            │
│  tools/diagnostics/safeViews.ts ← safe_* 有界摘要 │
└─────────────────────────────────────────────────┘
```

### 9.2 安全不变量

PatchWarden 的硬性约束（在 `watch.ts` 与 `runTask.ts` 中声明）：

- `repo_path` 必须在 `workspaceRoot` 内，不能通过 `..` 跳出
- Agent 必须在 `agents` 配置白名单中，命令来自本地配置而非模型输入
- `test_command` / `verify_commands` 必须逐字匹配全局或仓库专属白名单
- 每个任务最多运行一次（无自动重试循环）
- 不自动 commit、不自动 push、不删除文件、不发布、不重置仓库
- 敏感文件名（`.env`/SSH 私钥/`credentials`/`cookies` 等）默认不可读，`.patchwarden/` 不构成豁免
- 任务产物中的疑似密钥值会被脱敏
- Goal 状态 mutation 与 worktree create/merge/discard 都使用跨进程锁；Goal 的非空子目标全部 accepted 后自动完成
- 子目标任务只能使用 Goal 记录的 `repo_path`，仓库不一致时拒绝创建
- audit、任务产物和日志读取/追加都有明确的字节、行数或文件数预算
- HTTP Server 只绑定 `127.0.0.1`
- Windows DPAPI 加密 Tunnel 凭据，不写入仓库
- Desktop 应用 `contextIsolation` + `sandbox` + IPC sender 校验

### 9.3 作用域违规检测

`changeCapture.ts` 实现"双快照 + 外部脏文件基线"机制：

1. 任务执行前：`captureRepoSnapshot(repoPath)` + `extractExternalDirtyFiles(workspaceSnapshot)` 建立基线
2. 任务执行后：`captureRepoSnapshot(repoPath)` + `buildChangeArtifacts`
3. `findNewExternalDirtyFiles(baseline, current)` 只标记任务期间**新增**的外部脏文件
4. 任务期间新增越界改动 → `failed_scope_violation`，写入 rollback 计划但**不自动回滚**
5. `change_policy: "no_changes"` 模式下出现任何改动 → `failed_policy_violation`

### 9.4 capability 模型（v0.8.1）

`invoke_discovered_tool` 采用"discover 发 token、invoke 凭 token 调用"的模型：

```text
discover_tools(query) ──▶ issueToken(toolName, risk, profile)
                                    │
                                    ▼
invoke_discovered_tool(toolName, args, discoveryToken)
                                    │
                    ┌───────────────┤
                    ▼               ▼
          consumeToken      toolInvocationGuard.checkInvocation
          (单次使用)         (8 项校验)
                                    │
                                    ▼
                          handler 内二次校验
                          (如 commandGuard)
```

### 9.5 需要保护的本地路径

| 路径 | 内容 | 是否应提交 Git |
| --- | --- | --- |
| `patchwarden.config.json` | 私人路径、Agent 和命令白名单 | 否 |
| `.patchwarden/` | 计划、任务、差异和日志 | 否 |
| `%APPDATA%\patchwarden` | DPAPI 加密的 Tunnel 凭据 | 否 |
| `%LOCALAPPDATA%\patchwarden` | 运行时状态和隔离配置 | 否 |
| `%LOCALAPPDATA%\PatchWarden` | Desktop 应用 userData | 否 |

---

## 10. 测试与发布

### 10.1 测试体系

| 测试类型 | 命令 | 覆盖范围 |
| --- | --- | --- |
| 完整测试链 | `npm.cmd test` | smoke + unit + lifecycle + doctor + tunnel + watcher + control + mcp + brand |
| 单元测试 | `npm.cmd run test:unit` | `src/test/unit/*.test.ts`（45+ 测试文件） |
| MCP 烟雾测试 | `npm.cmd run test:mcp` | stdio MCP 工具调用 |
| HTTP MCP 烟雾测试 | `npm.cmd run test:http-mcp` | HTTP MCP 端点 |
| 生命周期测试 | `npm.cmd run test:lifecycle` | 任务完整生命周期 |
| Doctor 烟雾测试 | `npm.cmd run test:doctor` | 诊断脚本 |
| Tunnel 监督测试 | `npm.cmd run test:tunnel-supervisor` | Tunnel 启动器 |
| Watcher 监督测试 | `npm.cmd run test:watcher-supervisor` | Watcher 心跳与所有权 |
| Control 烟雾测试 | `npm.cmd run test:control` | Control Center API |
| 工具 Manifest 校验 | `npm.cmd run check:tool-manifest` | 工具清单一致性 |
| 品牌检查 | `npm.cmd run check:brand` | 品牌命名一致性 |
| Desktop 测试 | `npm.cmd run desktop:test` | 桌面应用单元测试 |

### 10.2 发布验证流程

发布前必须依次完成：

```powershell
npm.cmd run build
npm.cmd test
npm.cmd run test:mcp
npm.cmd run test:http-mcp
npm.cmd run doctor
npm.cmd run check:tool-manifest
npm.cmd run check:brand
npm.cmd run test:tunnel-supervisor
npm.cmd run test:watcher-supervisor
npm.cmd run pack:clean
npm.cmd run verify:package
```

发布后还需分别核验：
- npm Registry（`patchwarden` 包）
- GitHub Release 与 Tag
- `dist-tags.latest`

### 10.3 发布门控（Release Gate）

`releaseGate.ts` 实现五阶段顺序校验：

| 阶段 | 检查内容 | 远程? |
| --- | --- | --- |
| `local_ready` | 本地构建、版本、Git 状态、配置 | 否 |
| `packed_ready` | 打包产物完整性、SHA-256 | 否 |
| `published_verified` | npm Registry 包与版本存在 | 是（`node:https` GET） |
| `github_release_verified` | GitHub Release 与资产存在 | 是（`node:https` GET） |
| `ci_verified` | CI 工作流状态 | 是（`node:https` GET） |

远程阶段网络错误返回 `not_checked`（不是 `failed`），不执行 shell 命令。

### 10.4 打包排除

`pack:clean` 只重建 `release/package/` staging 和根目录的 tar/zip 包，不删除
`release/desktop*` 产物；它与 `verify:package` 都会排除：

- `node_modules/`
- `.patchwarden/`
- `*.log`
- `.env`
- `patchwarden.config.json`
- 本地凭据和运行时状态

### 10.5 Desktop 打包

```powershell
npm.cmd run desktop:install   # 安装 desktop 依赖（隔离缓存）
npm.cmd run desktop:test      # 运行桌面单元测试
npm.cmd run desktop:package   # 打包：先 stage 主仓 dist/，再 electron-builder
```

输出到 `release/desktop/`：NSIS 安装包 + 免安装 ZIP + SHA256 校验和清单。首版不含自动更新或代码签名，Windows SmartScreen 可能提示未知发布者。

---

## 11. 现有缺陷与改进建议

> 以下按严重性分级。CRITICAL 涉及安全/数据损坏；HIGH 影响功能；MEDIUM 影响可靠性/代码质量；LOW 影响可维护性。
> 本节保留原审计编号以便追踪；标为“已修复（2026-07-19 复核）”的条目已按当前源码与仓库内对应测试核对，不再属于开放缺陷。未标记条目仍需单独验证或处理。

### 11.1 跨平台缺陷（Windows + POSIX）

#### [已修复（2026-07-19 复核）] 11.1.1 `runtimeGuard.ts` 的 Windows 路径判断

- **现状**：[src/security/runtimeGuard.ts](../src/security/runtimeGuard.ts) 从模块位置解析 package root，并通过 `isSamePath`/`isPathChildOf` 做平台感知的父子路径判断，不再使用 `resolve("/")[0]`。
- **覆盖**：[src/test/unit/runtime-guard-windows.test.ts](../src/test/unit/runtime-guard-windows.test.ts) 覆盖 Windows 大小写和运行时关键子目录阻断。

#### [已修复（2026-07-19 复核）] 11.1.2 `changeCapture.ts` 的空设备路径

- **现状**：[src/runner/changeCapture.ts](../src/runner/changeCapture.ts) 使用平台辅助常量 `nullDevice`，Windows 为 `NUL`，其他平台为 `/dev/null`。
- **覆盖**：[src/test/unit/change-capture-null-device.test.ts](../src/test/unit/change-capture-null-device.test.ts) 验证平台映射。

#### [已修复（2026-07-19 复核）] 11.1.3 Windows 快照路径大小写比较

- **现状**：[src/runner/changeCapture.ts](../src/runner/changeCapture.ts) 保留原始规范化路径用于证据展示，但在 Windows 下使用小写比较键处理 before/after 快照、tracked/ignored 集合、dirty path 和外部脏文件基线；POSIX 仍保持大小写敏感。
- **覆盖**：[src/test/unit/runner/change-capture.test.ts](../src/test/unit/runner/change-capture.test.ts) 覆盖 Windows 大小写重命名/修改、大小写敏感目录碰撞、POSIX 重命名和外部基线匹配。

#### [已修复（2026-07-19 复核）] 11.1.4 Windows repo key 大小写匹配

- **现状**：[src/config.ts](../src/config.ts) 的存储 key 仍保留用户书写形式，但 `getRepoAllowedTestCommands` 与 `getRepoDirectAllowedCommands` 均通过 `comparablePath` 比较；Windows 下会转为小写绝对路径，因此 `MyRepo`/`myrepo` 不再导致 allowlist 失配。

#### [已修复（2026-07-19 复核）] 11.1.5 Windows Agent npm shim 无 shell 启动

- **现状**：[src/runner/agentInvocation.ts](../src/runner/agentInvocation.ts) 对 OpenCode 优先解析原生 `opencode.exe`；对 Codex、Claude、Gemini、Copilot、Qwen 等已知 npm adapter，验证受信 PATH 下的包名和 `package.json#bin` 后，使用受信 Node 可执行文件直接启动 CLI。未知 `.cmd`/`.bat`/`.ps1` wrapper 继续拒绝，不会回退到 shell。
- **覆盖**：[src/test/unit/runner/agent-invocation.test.ts](../src/test/unit/runner/agent-invocation.test.ts) 覆盖原生 OpenCode、已知 npm shim、未知 wrapper 拒绝和 repo-local 同名 executable 排除。

#### [已修复（2026-07-19 复核）] 11.1.6 `postTaskCleanup.ts` 不再调用 `cmd rmdir`

- **现状**：[src/runner/postTaskCleanup.ts](../src/runner/postTaskCleanup.ts) 使用 `fs.rmSync` 的有界重试；Windows 失败时只对目标树清除只读属性后再重试，不再启动 `cmd.exe /c rmdir`。Git 分类探测仍是同步且有界的本地命令，清理仅在任务收尾阶段执行。

### 11.2 安全缺陷

#### [HIGH] 11.2.1 `pathGuard.ts` 的 TOCTOU 竞争窗口

- **文件**：[src/security/pathGuard.ts:28-31](../src/security/pathGuard.ts#L28)
- **问题**：`realCandidate` 解析时刻与后续文件操作（read/write）之间存在 TOCTOU 窗口；攻击者可在校验通过后用符号链接替换目标路径逃逸工作区。
- **影响**：在多用户/共享环境下可被利用绕过工作区限制。
- **修复建议**：使用 `fs.open()` + `fstat()` + `O_NOFOLLOW`（POSIX）或 `FILE_FLAG_BACKUP_SEMANTICS`（Windows）确保文件描述符不被替换。

#### [已修复（2026-07-19 复核）] 11.2.2 `sensitiveGuard.ts` token/credentials 误匹配

- **现状**：[src/security/sensitiveGuard.ts](../src/security/sensitiveGuard.ts) 已把 `credentials`、`token` 收紧为完整 basename、受限扩展名或明确的 token-store/API-key 形态；`tokenizer.ts`、`credentials-handler.ts` 不再命中。NTFS ADS、NUL 和伪 `.patchwarden` 前缀也会被拒绝。
- **保守策略**：basename 恰为 `config.json` 仍被阻止，这是对常见本地凭据文件的有意保守策略，不再归因于子串正则缺陷。

#### [已复核（非缺陷）] 11.2.3 `commandGuard.ts` 元字符校验

- `\x00-\x1F` 已包含换行、回车和制表符；配置命令 basename 还必须匹配 `[a-zA-Z0-9._-]+`。任务子进程不启用 shell，且实际可执行文件会从移除 repo cwd 的受信 PATH 解析，因此 `*`/`?` 不会获得 shell 通配语义。

#### [已复核（非缺陷）] 11.2.4 验证命令保持精确匹配

- `guardTestCommand`/`guardDirectCommand` 仅做首尾空白清理后与本地 allowlist 精确比较。`npm.cmd` 与 `NPM.CMD` 不自动等价是 fail-closed 设计，避免模型通过“近似命令”扩大授权；Windows npm/npx/pnpm 的实际无 shell 解析由进程安全层处理。

#### [已修复（2026-07-19 复核）] 11.2.5 `contentRedaction.ts` 常见 token 格式覆盖

- **现状**：[src/security/contentRedaction.ts](../src/security/contentRedaction.ts) 已覆盖 GitLab `glpat-`、Slack `xox*`、AWS access key、Google API key 和 JWT 形态。
- **覆盖**：[src/test/unit/security/content-redaction.test.ts](../src/test/unit/security/content-redaction.test.ts) 使用合成凭据形态验证脱敏与普通文本不误报。

#### [已修复（2026-07-19 复核）] 11.2.6 `directPatch.ts` 原子替换

- **现状**：[src/direct/directPatch.ts](../src/direct/directPatch.ts) 在目标文件同目录写入随机临时文件后 `renameSync` 替换，并保留原文件权限；失败时清理临时文件。
- **覆盖**：[src/test/unit/workspace/apply-patch.test.ts](../src/test/unit/workspace/apply-patch.test.ts) 检查补丁结果及成功后无残留临时文件。

#### [已修复（2026-07-19 复核）] 11.2.7 `discoveryTokenStore.ts` 有界存储

- **现状**：[src/security/discoveryTokenStore.ts](../src/security/discoveryTokenStore.ts) 在签发时清理过期记录，并将活动 token 数限制为 1024；达到上限时淘汰最旧记录。
- **覆盖**：[src/test/unit/discovery/discovery-token-store.test.ts](../src/test/unit/discovery/discovery-token-store.test.ts) 覆盖未消费过期 token 清理和容量上限。

#### [已修复（2026-07-19 复核）] 11.2.8 Control token 常量时间比较

- **现状**：[src/control/middleware/auth.ts](../src/control/middleware/auth.ts) 将 header 与 control token 转为 Buffer，先比较长度，再使用 `crypto.timingSafeEqual`。

### 11.3 错误处理缺陷

#### [已复核（非缺陷）] 11.3.1 `release_prepare`/`release_cleanup` 的同步调用

- **结论**：[src/tools/release/releaseMode.ts](../src/tools/release/releaseMode.ts) 中 `releasePrepare` 与 `releaseCleanup` 均为同步函数并直接返回 `ReleaseModeResult`，dispatch 不需要 `await`；`releaseCheck` 与 `releaseVerify` 才是异步函数。

#### [已修复（2026-07-19 复核）] 11.3.2 `watch.ts` 报告损坏的任务状态

- **现状**：[src/runner/watch.ts](../src/runner/watch.ts) 对非对象或无法解析的 `status.json` 记录带 `task_id` 和错误摘要的 warning 后跳过，不再静默吞掉。

#### [已修复（2026-07-19 复核）] 11.3.3 Watcher 与任务领取并发保护

- **现状**：[src/runner/watch.ts](../src/runner/watch.ts) 以排他创建的 watcher lock 拒绝活动重复实例，支持 stale PID 接管且只允许 owner 释放；tick 通过 non-overlapping runner 串行化。
- **任务级保护**：[src/runner/taskStatusStore.ts](../src/runner/taskStatusStore.ts) 以同目录硬链接锁和原子 JSON 替换实现 `pending -> running` 单次领取；`cancelTask` 与 runner 共享同一状态锁。
- **覆盖**：[src/test/unit/watcher-lock.test.ts](../src/test/unit/watcher-lock.test.ts)、[src/test/unit/watcher-runtime.test.ts](../src/test/unit/watcher-runtime.test.ts)、[src/test/unit/runner/task-status-store.test.ts](../src/test/unit/runner/task-status-store.test.ts) 和 [src/test/unit/runner/run-task-claim.test.ts](../src/test/unit/runner/run-task-claim.test.ts) 覆盖重复实例、stale lock、多进程领取、重复 runner 与取消竞态。

#### [已复核（非缺陷）] 11.3.4 `watch.ts` 保持轮询定时器引用

- **结论**：Watcher 是常驻进程，轮询定时器必须保持引用，才能在空闲时继续存活；SIGINT/SIGTERM handler 会显式释放 owner lock 并退出。`watcher-runtime.test.ts` 已覆盖空闲 watcher 常驻行为。

#### [已修复（2026-07-19 复核）] 11.3.5 `simpleProcess.ts` 追加写入

- **现状**：[src/runner/simpleProcess.ts](../src/runner/simpleProcess.ts) 与 [src/runner/processSecurity.ts](../src/runner/processSecurity.ts) 使用 `SecureProcessLogCapture` 有界收集、写前脱敏并最终 `appendFileSync`，不再执行 read-modify-write；异步完成以 child `close` 为准，避免在 stdio 排空前返回。

#### [LOW] 11.3.6 `logging.ts` fatal handler 立即退出

- **现状**：[src/logging.ts](../src/logging.ts) 在 `uncaughtException` 记录结构化错误后调用 `process.exit(1)`，避免进程在未知状态继续运行。Direct patch、session/status JSON 等关键状态已使用原子替换，因此旧文档所称“中断 directPatch 非原子写入”不再成立。
- **残余风险**：尚未 flush 的异步遥测或第三方输出可能丢失；若未来增加异步日志 sink，应在 fatal 路径增加有界 flush。

#### [LOW] 11.3.7 best-effort cleanup 仍有静默 catch

- **现状**：锁临时文件、失败后的清理和证据日志写入仍有少量 best-effort catch；关键状态更新会显式报错，但低价值清理失败可能只通过后续存在性检查暴露。
- **建议**：增加有界 debug 计数，避免把潜在磁盘/权限问题长期静默化。

### 11.4 代码质量问题

#### [已修复（2026-07-19 复核）] 11.4.1 TaskEntry 重建逻辑复用

- **现状**：[src/control/runtime.ts](../src/control/runtime.ts) 导出 `reconstructTaskEntry`，`routes/tasks.ts` 与 `routes/taskActions.ts` 均调用该 helper；旧的 `VALID_ACCEPTANCE2`/`taskStatus2` 复制代码已删除。

#### [MEDIUM] 11.4.2 `runTask.ts` 仍承担较多职责

- **现状**：[src/tools/registry.ts](../src/tools/registry.ts) 已缩减至约 170 行，定义、catalog 与领域 dispatch 均已拆分，旧“1412 行 registry”结论失效。[src/runner/runTask.ts](../src/runner/runTask.ts) 仍超过 1300 行，包含生命周期编排和 managed process 控制。
- **建议**：继续把 task context、managed process 与 artifact collection 按稳定边界拆分，同时保持任务状态机和安全检查顺序不变。

#### [已复核（非缺陷）] 11.4.3 `dispatchMap` 为配置无关 handler map

- **结论**：[src/tools/registry.ts](../src/tools/registry.ts) 的 `dispatchMap` 只组合领域 handler；profile/feature gate 由 `getToolDefs()` 和 handler 内运行时守卫决定。`registerTools` 有意冻结一次连接的 active tool list，避免同一 MCP 连接的 list/call 漂移；配置变化应通过重连生效。

#### [MEDIUM] 11.4.4 `any` 仍集中在测试夹具和少量 dispatch 转换

- **现状**：`watch.ts` 的旧 `statusData: any` 已移除；剩余显著使用主要集中在大型 smoke harness，以及少量 dispatch 输入适配。
- **建议**：优先为 MCP 输入和 smoke fixture 定义共享类型，逐步改为 `unknown` + 类型守卫；不要用一次性全局替换破坏现有测试意图。

#### [MEDIUM] 11.4.5 `coreDispatch.ts`/`directDispatch.ts`/`goalDispatch.ts`/`releaseDispatch.ts` 多处 `as any` 绕过校验

- **文件**：`src/tools/dispatch/*.ts` 多处
- **问题**：`template as any`、`file as "stdout" | "stderr" | ...`、`target_stage as any`、`operations as any` 等类型断言绕过校验，依赖底层工具函数自行校验。
- **修复建议**：在 dispatch 层做参数 schema 校验，或在底层加显式校验。

#### [已修复（2026-07-19 复核）] 11.4.6 共享稳定 JSON 实现

- **现状**：[src/utils/stableJson.ts](../src/utils/stableJson.ts) 提供唯一 `stableJsonStringify`；catalog 与 registry 均导入该实现。

#### [LOW] 11.4.7 Control URL 解码策略仍未完全统一

- **现状**：多数路径参数通过 `control/shared.ts` helper 处理；`routeTable.ts` 的 repo path 与静态文件 middleware 仍分别实现严格 400 错误语义，不能直接用“失败后返回原文”的 helper 替换。
- **建议**：若继续抽象，应显式区分 strict decode 与 fallback decode 两种策略。

#### [已修复（2026-07-19 复核）] 11.4.8 Task safe handler 冗余 catch

- **现状**：[src/control/routes/tasks.ts](../src/control/routes/tasks.ts) 的四个 safe handler 各保留单层 try/catch 与统一 ID 校验，旧的嵌套死代码已删除。

### 11.5 架构问题

#### [MEDIUM] 11.5.1 模块级可变状态过多

- **位置**：
  - `src/security/discoveryTokenStore.ts`：进程内 token store
  - `src/config.ts`：`_config` 模块级单例
  - `src/runner/watch.ts`：`executedTasks` 与连续失败计数
  - `src/control/runtime.ts`：状态摘要缓存
  - `src/tools/catalog/toolCatalog.ts`：最近 catalog snapshot
- **影响**：测试需显式 reset，且多实例语义依赖进程隔离。`dispatchMap` 已确认配置无关，不再作为热重载缺陷证据。

#### [已修复（2026-07-19 复核）] 11.5.2 Watcher 重复 tick 失败升级

- **现状**：[src/runner/watch.ts](../src/runner/watch.ts) 记录连续 tick 失败；达到 3 次后心跳写为 `degraded` 并带有截断的 `last_error`。[src/watcherStatus.ts](../src/watcherStatus.ts) 将 degraded 视为不可用，并向 pending task 返回 `queued_but_watcher_degraded`。

#### [已修复（2026-07-19 复核）] 11.5.3 Diagnostic dispatch 循环依赖

- **现状**：[src/tools/dispatch/diagnosticDispatch.ts](../src/tools/dispatch/diagnosticDispatch.ts) 导出 `buildDiagnosticHandlers(dispatchTool)`；registry 注入 audited dispatcher，不再由 diagnostic 模块反向 import registry。

### 11.6 测试覆盖差距

#### [部分修复（2026-07-19 复核）] 11.6.1 核心模块测试覆盖

本轮新增或确认了以下定向覆盖：

- `runtime-guard-windows.test.ts`：运行时自修改与 Windows 路径比较。
- `change-capture-null-device.test.ts`：跨平台空设备。
- `runner/simple-process.test.ts`：子进程输出与日志流完成语义。
- `runner/run-task-claim.test.ts`、`runner/task-status-store.test.ts`：任务单次领取及取消竞态。
- `watcher-lock.test.ts`、`watcher-runtime.test.ts`：Watcher 单实例、stale lock 与空闲常驻。
- `workspace/apply-patch.test.ts`：Direct 原子替换后的结果与临时文件清理。
- `direct/direct-guards.test.ts`、`security/sensitive-guard.test.ts`、`workspace/sync-file.test.ts`：junction/symlink、ADS、敏感路径段和 Direct session 状态。
- `runner/simple-process.test.ts` 与 process security smoke：最小环境、受信 executable、无 shell package-manager 和日志上限。

剩余差距主要是 `runTask.ts` 全生命周期的细粒度单元覆盖和 `control/server.ts` HTTP 路由级覆盖；现有 lifecycle/control smoke 不能完全替代单元测试。

#### [已复核（旧清单失效）] 11.6.2 工具级覆盖清单

旧版按 `src/tools/*.ts` 平铺路径列出的“未覆盖文件”已因工具分域重排和新增测试失效。当前仍应关注的是跨工具生命周期、Control HTTP 边界和真实 CLI 组合覆盖，而不是维护容易漂移的静态文件名清单。

### 11.7 文档漂移

#### [已修复（2026-07-19 复核）] 11.7.1 CODE_WIKI 关键元数据漂移

| 字段 | 本轮复核前文档声称 | 当前源码 |
| --- | --- | --- |
| 源码版本 | `v1.5.1` | `v1.6.0` |
| Schema Epoch | `2026-07-16-v14` | `2026-07-19-v15` |
| 主包 `@types/node` | `^26.1.0` | `^18.19.0`（与 Node.js 18 最低运行时对齐） |
| `chatgpt_direct` 工具数 | 15 | 14 |

#### [已修复（2026-07-19 复核）] 11.7.2 v1.5.1/v1.6.0 新功能导览

本文现已覆盖 `src/tools/dispatch/` 拆分、`src/control/` 路由拆分、Desktop 子包、模型发现、Agent 适配器、`androidDoctor`、`releaseMode`、`schemaDriftCheck`、`toolUsageStats`、`syncFile`、`goalSubgoalTask`、`runDirectVerificationBundle` 等。

#### [已修复（2026-07-19 复核）] 11.7.3 README 与 Direct Profile 工具数

- `README.md`、`README.en.md` 与 [src/tools/catalog/toolCatalog.ts](../src/tools/catalog/toolCatalog.ts) 均为 14 个 `chatgpt_direct` 工具。

### 11.8 配置/校验差距

#### [已修复（2026-07-19 复核）] 11.8.1 Direct 数值配置范围

- **现状**：[src/config.ts](../src/config.ts) 要求 `directSessionTtlSeconds` 为 60–86400 的整数，并要求 `directMaxPatchBytes`、`directMaxFileBytes` 为正整数。

#### [已修复（2026-07-19 复核）] 11.8.2 `control/routes/sessions.ts` sessionId 校验

- **现状**：[src/control/routes/sessions.ts](../src/control/routes/sessions.ts) 的 detail、safe summary、finalize、audit、hide 路由统一调用 `isValidDirectSessionId` 白名单校验。

#### [已修复（2026-07-19 复核）] 11.8.3 Workspace 父目录穿越检查

- **现状**：[src/control/routes/workspace.ts](../src/control/routes/workspace.ts) 只拒绝值恰为 `..` 的路径段，不再误拒 `release..candidate` 之类合法目录名；Control Center smoke 覆盖该合法路径。

### 11.9 并发问题

#### [已修复（2026-07-19 复核）] 11.9.1 多 watcher 与任务重复领取（见 11.3.3）

#### [已修复（2026-07-19 复核）] 11.9.2 Direct session 原子 mutation

- **现状**：[src/direct/directSessionStore.ts](../src/direct/directSessionStore.ts) 的 update、operation append 与 verification append 均通过 `mutateLockedJsonFileSync` 串行化，并以原子 JSON 替换提交；session identity 与记录结构在锁内重新校验。

#### [已修复（2026-07-19 复核）] 11.9.3 Control event append/trim 竞争

- **现状**：[src/control/runtime.ts](../src/control/runtime.ts) 在 `withFileLockSync(controlCenterEventsPath, ...)` 内顺序执行 append、大小检查和 trim；裁剪结果再通过原子替换提交。并发 writer 使用同一锁文件，不再能在读取与 rename 之间插入一条随后丢失的事件。

#### [已修复（2026-07-19 复核）] 11.9.4 Hidden ID 文件类型校验

- **现状**：[src/control/runtime.ts](../src/control/runtime.ts) 通过 `readStoredStringArray` 校验 `Array.isArray`，过滤非字符串/空字符串并去重；写入使用原子 JSON 替换。

### 11.10 依赖卫生

#### [INFO] 11.10.1 主包保持单一直接运行时依赖

主仓 `package.json` 的直接运行时依赖只有 `@modelcontextprotocol/sdk`（`^1.29.0`）。这不是“零运行时依赖”；准确说法是“单一直接运行时依赖”。SDK 的传递依赖仍由 lockfile 管理。

#### [已修复（2026-07-19 复核）] 11.10.2 Node 类型与运行时基线对齐

- **现状**：主包使用 `@types/node ^18.19.0` 对齐 `engines.node >=18.0.0`；Electron 桌面子包独立使用 `@types/node ^24.0.0` 对齐其嵌入的 Node 运行时。

### 11.11 优先级修复建议汇总

**已修复并从开放待办移除**：11.1.1–11.1.6、11.2.2、11.2.5–11.2.8、11.3.2、11.3.3、11.3.5、11.4.1、11.4.6、11.4.8、11.5.2、11.5.3、11.7.1–11.7.3、11.8.1–11.8.3、11.9.1–11.9.4、11.10.2。11.2.3、11.2.4、11.3.1、11.3.4、11.4.3 经复核不构成缺陷。

**仍需优先处理（HIGH，影响安全或核心功能）**：

1. [11.2.1] `pathGuard.ts` 的 TOCTOU → 使用文件描述符级校验或等价的无跟随链接策略

**短期修复（MEDIUM，提升可靠性）**：

2. [11.4.2] 继续按稳定边界拆分 `runTask.ts`
3. [11.6.1] 补齐 `runTask.ts` 生命周期与 Control HTTP 路由级单元测试

**长期改进（LOW，可维护性）**：

4. [11.4.4] 将剩余 MCP 输入与 smoke fixture 的 `any` 迁移为共享类型/类型守卫
5. [11.4.7] 统一 strict/fallback 两类 URL 解码策略

---

## 附录：关键设计原则

1. **最小权限**：MCP 工具不提供通用 Shell，每个工具只做一件事
2. **纵深防御**：多层守卫串联，任一层失效不导致整体失守
3. **不可信输入**：模型指令始终被视为不可信，本地配置才是信任源
4. **可审计性**：所有任务产出结构化证据，支持独立验收
5. **不自动破坏**：不自动 commit/push/publish/tag/release，需人工决策
6. **有界输出**：`safe_*` 系列工具返回有界摘要，避免触发平台内容过滤
7. **依赖最小化**：主仓保持单一直接运行时依赖（MCP SDK），其他核心功能优先使用 Node.js 内置模块
8. **跨平台**：Windows 与 POSIX 兼容（进程管理、路径处理、命令包装），平台特定回归集中记录在 11.1
9. **薄壳桌面**：所有业务逻辑在主仓 `dist/`，桌面只负责安装/检测/拉起/托盘/tunnel 下发
10. **配置即信任源**：Agent 命令、测试白名单、敏感路径模式都从本地配置读取，不从模型输入
