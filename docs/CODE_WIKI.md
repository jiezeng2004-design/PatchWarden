# PatchWarden Code Wiki

> 本文档是对 PatchWarden 仓库的结构化代码导览，覆盖项目整体架构、主要模块职责、关键类与函数说明、依赖关系、运行方式，以及现有缺陷分析。
> 源码版本：**v1.6.0** · Schema Epoch：`2026-07-16-v14` · License：MIT
> 文档基线：基于 `src/` 源码静态审查生成，工具数量与 Profile 定义已与 `registry.ts` / `toolCatalog.ts` 核对。

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
- [附录：关键设计原则](#附录关键设计原则)

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
- 任务完成后保存结构化结果、完整差异、文件统计和独立验证记录
- 工作区外出现变化时标记为作用域违规，而非悄悄接受
- `.env`、Token、SSH 密钥、Cookie、凭据文件等敏感路径默认不可读

**技术栈**：TypeScript（`strict` 模式，`target: ES2022`，`module: NodeNext`）+ Node.js（≥18）+ `@modelcontextprotocol/sdk`，运行时无任何第三方依赖。

**仓库元数据**：

| 项 | 值 |
| --- | --- |
| npm 包名 | `patchwarden` |
| 当前版本 | `1.6.0` |
| Schema Epoch | `2026-07-16-v14` |
| 可执行入口 | `patchwarden`、`patchwarden-confirm`、`patchwarden-runner` |
| 运行时依赖 | `@modelcontextprotocol/sdk ^1.0.0`（唯一） |
| devDependencies | `@types/node ^20`、`typescript ^6` |

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
        本地 Agent（OpenCode / Codex）
                    │
                    ▼
 result.json / diff.patch / verify.json / status.json
                    │
                    ▼
       MCP 客户端读取 safe 摘要、审计证据并人工验收
```

### 2.2 三种运行角色

一次完整运行通常包含三个独立角色：

| 角色 | 职责 | 入口 |
| --- | --- | --- |
| **MCP Server** | 暴露受限的 planning/task/summary/audit 工具 | `dist/index.js`（stdio）或 `dist/httpServer.js`（HTTP） |
| **Watcher** | 轮询 queued 任务并启动本地 Agent | `dist/runner/watch.js` |
| **本地 Agent** | 真正修改代码，必须在配置中预先登记 | 由 Watcher 通过 `spawn` 启动 |

> ⚠️ "MCP 已连接"不等于"任务一定会执行"。如果 Watcher 没有运行，`create_task` 仍能保存任务，但任务会保持 `queued` 并返回 `execution_blocked: true`。

### 2.3 四种工具 Profile

Profile 由 `src/tools/toolCatalog.ts` 定义，`PATCHWARDEN_TOOL_PROFILE` 环境变量或配置项 `toolProfile` 控制：

| Profile | 工具数 | 用途 |
| --- | --- | --- |
| `full` | 66（+1 条件性 `run_task`） | 本地完整开发目录，包含核心、管理、Direct、Goal、Release 工具 |
| `chatgpt_core` | 26 | ChatGPT Tunnel 固定的核心工具集 |
| `chatgpt_direct` | 14 | ChatGPT 直接编辑模式，需 `enableDirectProfile: true`；未启用时降级为仅 `health_check` |
| `chatgpt_search` | 5 | 动态工具发现场景（`discover_tools`/`explain_tool`/`invoke_discovered_tool`） |

> 注：`full` Profile 实际注册 66 个工具；当 `enableRunTaskTool: true` 时额外暴露 `run_task`，共 67 个。README 中标注的"64"已过时。

### 2.4 两种执行模式

| 模式 | 流程 |
| --- | --- |
| **Agent 委托模式** | ChatGPT 编写计划 → 本地 Agent 执行 → PatchWarden 审计 |
| **Direct 模式** | ChatGPT 创建 session → 读取/搜索文件 → 应用 JSON 补丁 → 运行白名单验证 → finalize → audit |

---

## 3. 目录结构

```text
PatchWarden/
├── src/                          # TypeScript 源码
│   ├── index.ts                  # stdio MCP Server 入口
│   ├── httpServer.ts             # HTTP MCP Server 入口（127.0.0.1 only）
│   ├── controlCenter.ts          # Control Center 入口薄壳（仅 startServer）
│   ├── doctor.ts                 # 只读诊断脚本
│   ├── smoke-test.ts             # 烟雾测试入口（单文件 2300+ 行）
│   ├── config.ts                 # 配置加载与校验（25+ 字段）
│   ├── errors.ts                 # PatchWardenError 错误模型
│   ├── logging.ts                # 审计日志（stderr JSON）
│   ├── version.ts                # 版本与 Schema Epoch
│   ├── taskRuntime.ts            # runtime.json 状态读写
│   ├── taskProgress.ts           # progress.md 生成
│   ├── watcherStatus.ts          # Watcher 心跳状态
│   ├── control/                  # Control Center 实现（v1 重构）
│   │   ├── server.ts             # HTTP 路由分发与生命周期
│   │   ├── shared.ts             # 端口/配置/controlToken/文件助手
│   │   ├── runtime.ts            # 状态文件与活动事件
│   │   ├── middleware/{auth,static}.ts
│   │   └── routes/{audit,evidence,lineage,policy,process,sessions,status,tasks,taskActions,workspace}.ts
│   ├── agents/                   # Agent 路由
│   │   └── agentRouter.ts
│   ├── assessments/              # 风险评估
│   │   ├── agentAssessor.ts
│   │   ├── assessmentStore.ts
│   │   └── confirmCli.ts
│   ├── direct/                   # Direct 直接编辑模式
│   │   ├── directSessionStore.ts
│   │   ├── directGuards.ts
│   │   ├── directPatch.ts
│   │   ├── directAudit.ts
│   │   └── directVerification.ts
│   ├── goal/                     # Goal Session 多任务编排
│   │   ├── goalStore.ts
│   │   ├── goalGraph.ts
│   │   ├── goalStatus.ts
│   │   ├── goalProgress.ts
│   │   ├── goalReport.ts
│   │   ├── handoffExport.ts
│   │   ├── specKitImport.ts
│   │   ├── subgoalSync.ts
│   │   ├── acceptanceEngine.ts
│   │   ├── acceptanceTemplate.ts
│   │   └── worktreeManager.ts
│   ├── policy/                   # 项目级策略
│   │   └── projectPolicy.ts
│   ├── release/                  # 发布门控
│   │   └── releaseGate.ts
│   ├── runner/                   # 任务执行核心
│   │   ├── cli.ts
│   │   ├── runTask.ts            # 1292 行，执行主循环
│   │   ├── watch.ts
│   │   ├── agentInvocation.ts
│   │   ├── changeCapture.ts      # 作用域违规检测
│   │   ├── postTaskCleanup.ts
│   │   └── simpleProcess.ts
│   ├── security/                 # 纵深防御守卫
│   │   ├── commandGuard.ts
│   │   ├── pathGuard.ts
│   │   ├── sensitiveGuard.ts
│   │   ├── planGuard.ts
│   │   ├── riskEngine.ts
│   │   ├── runtimeGuard.ts
│   │   ├── contentRedaction.ts
│   │   ├── toolInvocationGuard.ts
│   │   └── discoveryTokenStore.ts
│   ├── tools/                    # MCP 工具实现
│   │   ├── registry.ts           # 工具注册中枢（1412 行，66+ 工具定义）
│   │   ├── toolCatalog.ts        # Profile 与 Manifest
│   │   ├── toolRegistry.ts       # 工具元数据
│   │   ├── toolSearch.ts         # 自然语言工具搜索
│   │   ├── dispatch/             # 工具调度分域
│   │   │   ├── coreDispatch.ts
│   │   │   ├── directDispatch.ts
│   │   │   ├── diagnosticDispatch.ts
│   │   │   ├── goalDispatch.ts
│   │   │   ├── releaseDispatch.ts
│   │   │   └── types.ts
│   │   ├── createTask.ts
│   │   ├── runTaskLoop.ts        # 安全编排入口
│   │   ├── taskLineage.ts        # 链路记录
│   │   ├── evidencePack.ts       # 证据包导出
│   │   ├── auditTask.ts          # 独立审计
│   │   ├── safeViews.ts          # safe_* 系列摘要
│   │   ├── healthCheck.ts
│   │   ├── waitForTask.ts
│   │   └── ... (50+ 工具文件)
│   └── test/unit/                # 单元测试（40+ 测试文件）
├── ui/                           # Control Center 前端
│   ├── pages/                    # dashboard/tasks/audit/direct-sessions/logs/settings/task-detail/workspace
│   ├── partials/
│   ├── vendor/                   # tailwindcss-browser / lucide
│   ├── desktop-bridge.js
│   └── settings.js
├── desktop/                      # Electron 桌面安装包（独立子包，不进 npm）
│   ├── src/                      # main / preload / runtime-root / agent-detection 等
│   ├── onboarding/
│   ├── scripts/                  # checksum / icon / stage
│   └── test/
├── scripts/                      # 运维脚本
│   ├── checks/                   # 烟雾测试与 manifest 校验
│   ├── control/                  # PowerShell 进程管理
│   ├── launchers/                # Windows 一键启动器
│   ├── mcp/                      # MCP 启动包装
│   └── release/                  # 发布打包
├── docs/                         # 文档
├── examples/                     # 配置与 Tunnel 示例
├── package.json
├── tsconfig.json
└── PatchWarden.cmd               # Windows 统一控制入口
```

---

## 4. 核心模块职责

### 4.1 入口层

| 文件 | 职责 |
| --- | --- |
| [src/index.ts](../src/index.ts) | stdio MCP Server 入口：`loadConfig` → `new Server` → `registerTools` → `StdioServerTransport`；连接失败 `process.exit(1)` |
| [src/httpServer.ts](../src/httpServer.ts) | HTTP MCP Server，绑定 `127.0.0.1:7331`，每请求独立 MCP 实例（避免 "Already connected"），支持 owner token 与 `/admin/tasks/:id/accept\|reject\|acceptance` 验收端点；**未配置 token 时默认放行所有本地请求** |
| [src/controlCenter.ts](../src/controlCenter.ts) | Control Center 入口薄壳，仅 `startServer()`；实际逻辑全在 `src/control/` |
| [src/doctor.ts](../src/doctor.ts) | 只读诊断脚本，检查 15+ 项：Node/npm/Git 版本、配置、工作区、路径保护、敏感文件、Agent 命令、工具 Manifest、HTTP 端口、Watcher 目录、构建产物 |
| [src/smoke-test.ts](../src/smoke-test.ts) | 烟雾测试入口，单文件 2300+ 行，覆盖 16+ 测试段（A–N） |

### 4.2 Control Center 子系统（src/control/）

v1.5 将原 `controlCenter.ts` 拆分为模块化子目录，`controlCenter.ts` 仅保留入口：

| 文件 | 职责 |
| --- | --- |
| [control/server.ts](../src/control/server.ts) | HTTP 服务创建、`handleRequest` 路由分发、POST control-token 守门、启动/关闭生命周期（状态文件、活动事件、SIGINT/SIGTERM） |
| [control/shared.ts](../src/control/shared.ts) | 引入即触发 bootstrap 副作用：加载配置、生成 `controlToken`（`randomUUID`）、解析端口（默认 **8090**，`PATCHWARDEN_CONTROL_PORT` 或 `--port` 可覆盖）、`CORE_BASE_URL=8080`/`DIRECT_BASE_URL=8081`、JSON 文件安全读取助手 |
| [control/runtime.ts](../src/control/runtime.ts) | `writeStatusFile`/`removeStatusFile`/`recordEvent`（活动事件 jsonl，上限 2000 行） |
| [control/middleware/auth.ts](../src/control/middleware/auth.ts) | `checkControlToken` 校验 POST 请求的 `x-patchwarden-control-token` |
| [control/middleware/static.ts](../src/control/middleware/static.ts) | 服务 `ui/` 静态资源与 favicon |
| [control/routes/*.ts](../src/control/routes/) | 9 个路由模块：tasks / taskActions / sessions / lineage / evidence / policy / workspace / process / status / audit |

### 4.3 配置与基础

| 文件 | 职责 |
| --- | --- |
| [src/config.ts](../src/config.ts) | 加载并校验 `patchwarden.config.json`，提供 `loadConfig`/`getConfig`/`reloadConfig`/`getTasksDir`/`getPlansDir` 等路径解析；`normalizeConfig` 近 200 行严格校验 `workspaceRoot`、`agents`、`allowedTestCommands`、`watcherStaleSeconds`、`toolProfile`、`tunnelProxy`、`directAllowedCommands` 等 25+ 字段；查找顺序：`PATCHWARDEN_CONFIG` → `{cwd}/patchwarden.config.json` → `{cwd}/.patchwarden.json`；支持 BOM 剥离 |
| [src/errors.ts](../src/errors.ts) | 定义 `PatchWardenError`（含 `reason`/`suggestion`/`blocked`/`details`）与 `errorPayload` 序列化 |
| [src/version.ts](../src/version.ts) | 导出 `PATCHWARDEN_VERSION = "1.6.0"` 与 `TOOL_SCHEMA_EPOCH = "2026-07-16-v14"` |
| [src/logging.ts](../src/logging.ts) | `Logger` 类输出 stderr JSON 日志，记录 `audit`/`info`/`warn`/`error`/`fatal`；`logToolInvocation` 仅写参数 digest，不写原参数；`installGlobalHandlers` 捕获未处理异常但不吞错 |

### 4.4 安全模块（src/security/）

PatchWarden 的纵深防御核心，所有写操作前都会经过这些守卫。

| 文件 | 职责 |
| --- | --- |
| [commandGuard.ts](../src/security/commandGuard.ts) | 命令白名单守卫：`guardAgentCommand` 校验 agent 已配置且命令无 shell 元字符；`guardTestCommand` 精确匹配测试白名单；`guardDirectCommand` 校验 Direct 白名单；`sanitizePromptArg` 清洗 `\x00-\x1F` 控制字符（保留 Tab/LF/CR） |
| [pathGuard.ts](../src/security/pathGuard.ts) | 路径横移守卫：`guardPath`/`guardReadPath`/`guardWorkspacePath` 确保路径解析后都在 `workspaceRoot` 内，用 `realpath` 防符号链接逃逸，Windows 下做盘符一致性检查 |
| [sensitiveGuard.ts](../src/security/sensitiveGuard.ts) | 敏感文件守卫：`isSensitivePath` 匹配 `.env`/SSH 私钥/`credentials`/`.npmrc`/`cookies`/`.kube/config`/`config.json` 等；`.patchwarden/` 前缀豁免 |
| [planGuard.ts](../src/security/planGuard.ts) | 计划内容守卫：`guardPlanContent` 扫描 plan 文本，拦截"读取密钥/破坏性删除/植入后门"等危险指令，支持中英文否定语境检测 |
| [riskEngine.ts](../src/security/riskEngine.ts) | 综合风险评估：`assessRisk` 串联各 guard 输出 `risk_level`（low/medium/high）+ `decision`（allow/needs_confirm/blocked）+ `reason_codes`；`collectRiskHints` 仅做关键词提示，不影响决策 |
| [runtimeGuard.ts](../src/security/runtimeGuard.ts) | 阻止任务把 `repo_path` 指向运行中的 PatchWarden 自身目录（`dist`/`src`/`scripts`/`release`） |
| [contentRedaction.ts](../src/security/contentRedaction.ts) | 输出脱敏：`redactSensitiveContent`/`redactSensitiveValue` 按正则替换私钥、bearer token、npm token、凭据赋值、已知 token 格式 |
| [toolInvocationGuard.ts](../src/security/toolInvocationGuard.ts) | `invoke_discovered_tool` 调用前 8 项校验：token 匹配、profile 允许、风险等级、敏感路径、assessment 必需、命令元字符、release 确认、credential 拒绝 |
| [discoveryTokenStore.ts](../src/security/discoveryTokenStore.ts) | 服务端 discovery token 存储：`issueToken`/`consumeToken`（单次使用）/`peekToken`/`revokeToken`，纯内存、10 分钟 TTL、不持久化 |

### 4.5 Runner 模块（src/runner/）

任务执行的核心，编排从启动到产出 artifact 的完整生命周期。

| 文件 | 职责 |
| --- | --- |
| [cli.ts](../src/runner/cli.ts) | Runner 子进程入口，从 argv 或 `PATCHWARDEN_TASK_ID` 读取 taskId 并调用 `runTask` |
| [runTask.ts](../src/runner/runTask.ts) | **执行主循环**（1292 行）：`runTask(taskId)` 编排 preparing → executing_agent → running_tests → collecting_artifacts → done/failed；管理心跳（2s）、超时、cancel/kill；产出 16+ artifact 文件；区分 `failed_scope_violation`/`failed_policy_violation`；内含 `runManagedProcess`（约 125 行，含 spawn/stream/心跳/终止） |
| [watch.ts](../src/runner/watch.ts) | 常驻 watcher，每 4 秒 `setInterval(tick)` 轮询 `pending` 任务，执行 pre-flight 安全校验后调用 `runTask`；原子写心跳文件（tmp + rename）；通过 env 注入 `WATCHER_INSTANCE_ID`/`WATCHER_LAUNCHER_PID` 支持所有权判定；`executedTasks` Set 防重执行 |
| [agentInvocation.ts](../src/runner/agentInvocation.ts) | 构建 agent 调用参数与 prompt：`buildAgentInvocation`/`buildExecutionPrompt`/`buildAssessmentPrompt`；占位符 `{repo}`/`{prompt}`/`{prompt_file}` 替换 |
| [changeCapture.ts](../src/runner/changeCapture.ts) | 仓库快照与变更证据：`captureRepoSnapshot` 并行跑 5 个 git 命令；`buildChangeArtifacts` 比对快照生成 diff；`extractExternalDirtyFiles` 建立外部脏文件基线；`buildArtifactManifest` 生成带 sha256 的产物清单 |
| [postTaskCleanup.ts](../src/runner/postTaskCleanup.ts) | 任务后清理：仅删除未被 git 跟踪且被忽略的临时产物（`__pycache__`/`dist`/`*.pyc`），三道闸门保护受控文件 |
| [simpleProcess.ts](../src/runner/simpleProcess.ts) | 轻量进程执行器：`runSimpleProcess`/`runSimpleProcessSync`，带输出上限（512KB/128KB）、超时、截断标志，供 `run_verification` 等非任务流程使用 |

### 4.6 Tools 模块（src/tools/）

MCP 工具实现与注册中枢。

| 文件 | 职责 |
| --- | --- |
| [registry.ts](../src/tools/registry.ts) | **工具注册中枢**（1412 行）：`getToolDefs` 生成完整工具定义（含 inputSchema）；`registerTools` 绑定 `ListToolsRequestSchema`/`CallToolRequestSchema`；`handleToolCall` 分发 66+ 工具调用；保证 list/call 一致性，附 `_meta`（server_version/schema_epoch/tool_manifest_sha256）；`enableRunTaskTool: true` 时额外注册 `run_task` |
| [toolCatalog.ts](../src/tools/toolCatalog.ts) | Profile 与 Manifest：`resolveToolProfile`/`selectToolsForProfile` 按 profile 过滤工具；`buildToolCatalogSnapshot` 计算 `tool_manifest_sha256` 用于漂移检测；定义 `CHATGPT_CORE_TOOL_NAMES`(26)/`CHATGPT_DIRECT_TOOL_NAMES`(14)/`CHATGPT_SEARCH_TOOL_NAMES`(5) |
| [toolRegistry.ts](../src/tools/toolRegistry.ts) | 工具元数据（risk/tags/aliases/profiles/modes） |
| [toolSearch.ts](../src/tools/toolSearch.ts) | 自然语言工具搜索（中英文） |
| [dispatch/](../src/tools/dispatch/) | 工具调度按域拆分：`coreDispatch`/`directDispatch`/`diagnosticDispatch`/`goalDispatch`/`releaseDispatch`/`types` |
| [createTask.ts](../src/tools/createTask.ts) | `createTask` 任务创建：支持 `plan_id`/`inline_plan`/`template` 三种来源；`assess_only` 模式预评估风险；产出 `task_id` 与 `execution_blocked` 状态 |
| [runTaskLoop.ts](../src/tools/runTaskLoop.ts) | **安全编排入口**：`runTaskLoop` 组合 create_task → wait_for_task → safe summaries → audit_task，最多 5 轮迭代；支持 worktree 隔离、Direct 验证、自动修复失败测试 |
| [taskLineage.ts](../src/tools/taskLineage.ts) | 链路记录：`createLineageId`/`writeTaskLineage`/`getTaskLineage`/`toSafeTaskLineage`，写入 `.patchwarden/lineages/<lineage_id>/` |
| [evidencePack.ts](../src/tools/evidencePack.ts) | 证据包导出：`exportTaskEvidencePack` 写 `evidence.json` + `EVIDENCE.md`，不含 stdout/stderr/full diff/sensitive content |
| [auditTask.ts](../src/tools/auditTask.ts) | 独立审计：`auditTask` 执行 16+ 确定性检查（status/result/diff/repo_path/package.json/sensitive path/unrecorded command），区分 `confirmed_failures`/`possible_false_positives`/`manual_verification_items` |
| [safeViews.ts](../src/tools/safeViews.ts) | `safe_*` 系列只读摘要：`safeResult`/`safeAudit`/`safeTestSummary`/`safeDiffSummary`/`safeDirectSummary` 等，返回有界结构化证据 |
| [healthCheck.ts](../src/tools/healthCheck.ts) | `healthCheck` 返回 MCP catalog 一致性、watcher 心跳、workspace、agents 状态；`self_diagnostic` 模式扩展证据 |
| [waitForTask.ts](../src/tools/waitForTask.ts) | 长轮询任务（最多 30s），返回 `continuation_required` 或终态 acceptance 证据 |
| [discoverTools.ts](../src/tools/discoverTools.ts) | 自然语言工具发现，返回压缩摘要与 risk level |
| [invokeDiscoveredTool.ts](../src/tools/invokeDiscoveredTool.ts) | 凭 discoveryToken 调用工具，强制 10 项安全检查 |

### 4.7 Goal 模块（src/goal/）

v0.8.0 引入的多任务编排层。

| 文件 | 职责 |
| --- | --- |
| [goalStore.ts](../src/goal/goalStore.ts) | Goal Session 目录 CRUD：`createGoal`/`listGoals`/`readGoal`/`writeGoalStatus`/`readGoalStatus`；目录结构 `.patchwarden/goals/{goal_id}/` 含 `GOAL.md`/`GOALS.md`/`goal_status.json`/`tasks/`/`artifacts/` |
| [goalGraph.ts](../src/goal/goalGraph.ts) | 依赖图：`suggestNextSubgoal` 返回依赖已满足的下一个子目标 |
| [goalStatus.ts](../src/goal/goalStatus.ts) | `GoalStatus`/`Subgoal` 类型与 `createInitialGoalStatus` |
| [goalProgress.ts](../src/goal/goalProgress.ts) | `acceptSubgoal`/`rejectSubgoal`/`summarizeGoalProgress` |
| [goalReport.ts](../src/goal/goalReport.ts) | `exportGoalReport` 导出结构化最终报告 |
| [handoffExport.ts](../src/goal/handoffExport.ts) | `exportHandoff` 导出 `handoff.md` 用于会话交接 |
| [specKitImport.ts](../src/goal/specKitImport.ts) | `parseSpecKitJson`/`importSpecKitTasks` 导入 Spec Kit 任务 |
| [subgoalSync.ts](../src/goal/subgoalSync.ts) | 子目标与任务关联同步 |
| [acceptanceEngine.ts](../src/goal/acceptanceEngine.ts) | 验收引擎 |
| [worktreeManager.ts](../src/goal/worktreeManager.ts) | `createWorktree`/`mergeWorktree`/`discardWorktree` 管理 git worktree 隔离 |

### 4.8 Direct 模块（src/direct/）

v0.6.0 引入的 ChatGPT 直接编辑模式。

| 文件 | 职责 |
| --- | --- |
| [directSessionStore.ts](../src/direct/directSessionStore.ts) | Direct Session CRUD：`createDirectSession`/`readDirectSession`/`updateDirectSession`/`finalizeDirectSessionRecord`；记录 operations/verification_runs；`computeWorkspaceFingerprint` |
| [directGuards.ts](../src/direct/directGuards.ts) | Direct 守卫：`guardDirectSessionActive`/`guardDirectSessionFinalized`/`guardDirectPath`/`guardDirectReadPath`/`guardDirectWritePath`/`guardDirectPatchSize`/`isBinaryFile` |
| [directPatch.ts](../src/direct/directPatch.ts) | JSON patch 应用：支持 `replace_exact`/`insert_before`/`insert_after`/`replace_whole_file`，校验 `expected_sha256`；**直接 `writeFileSync` 覆盖，非原子写** |
| [directAudit.ts](../src/direct/directAudit.ts) | 16 项确定性审计，返回 pass/warn/fail |
| [directVerification.ts](../src/direct/directVerification.ts) | 白名单验证命令执行 |

### 4.9 其他模块

| 文件 | 职责 |
| --- | --- |
| [src/agents/agentRouter.ts](../src/agents/agentRouter.ts) | Agent 路由：`routeAgent` 按 scope 文件数与关键词推荐 agent（largeScope→opencode、singleFile→direct、audit→patchwarden-audit、refactor→codex、documentation→claude） |
| [src/policy/projectPolicy.ts](../src/policy/projectPolicy.ts) | 仓库级策略：`getProjectPolicySummary` 解析 `.patchwarden/project-policy.json`；`commandAllowedByProjectPolicy`/`isProtectedByProjectPolicy`；含 `DANGEROUS_COMMAND_RE` 防护 |
| [src/release/releaseGate.ts](../src/release/releaseGate.ts) | v1.0.0 五阶段发布门：`local_ready` → `packed_ready` → `published_verified` → `github_release_verified` → `ci_verified`；远程阶段仅用 `node:https` GET，网络错误返回 `not_checked` |
| [src/assessments/agentAssessor.ts](../src/assessments/agentAssessor.ts) | `runAgentAssessment` 调用 agent 执行只读风险评估，输出 `===ASSESSMENT_JSON===` 标记后的结构化结果 |
| [src/assessments/assessmentStore.ts](../src/assessments/assessmentStore.ts) | Assessment 记录存储与 freshness 校验 |
| [src/taskRuntime.ts](../src/taskRuntime.ts) | `runtime.json` 浅合并读写，含 v0.7.0 PID 重用与孤儿任务检测字段 |
| [src/taskProgress.ts](../src/taskProgress.ts) | `progress.md` 生成，6 阶段标记（`[x]`/`[>]`/`[ ]`） |
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
  enableRunTaskTool?: boolean;        // 是否暴露 run_task 工具（文档未说明）
  enableDirectProfile?: boolean;      // 是否启用 Direct 模式
  enableAgentAssessment?: boolean;
  tunnelClientPath?: string;          // 必须指向 tunnel-client.exe
  tunnelProxy?: { scope, core, direct }; // 代理隔离配置
  httpPort?: number;                  // 默认 7331
  http?: { port?, host?, ownerTokenEnv? };
  directSessionsDir: string;
  directSessionTtlSeconds: number;    // 60-86400
  directMaxPatchBytes: number;
  directMaxFileBytes: number;
  directAllowedCommands?: string[];
  repoDirectAllowedCommands?: Record<string, string[]>;
}
```

#### `TaskStatus`（[src/tools/createTask.ts](../src/tools/createTask.ts)）

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

#### `ToolCatalogSnapshot`（[src/tools/toolCatalog.ts](../src/tools/toolCatalog.ts)）

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

### 5.2 核心函数

#### 配置加载

```typescript
// src/config.ts
function loadConfig(configPath?: string): PatchWardenConfig;  // 单例加载
function reloadConfig(configPath?: string): PatchWardenConfig; // 强制重载
function getConfig(): PatchWardenConfig;
function getTasksDir(config: PatchWardenConfig): string;
function getPlansDir(config: PatchWardenConfig): string;
function getRepoAllowedTestCommands(config, repoPath): string[];
function getRepoDirectAllowedCommands(config, repoPath): string[];
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
// 每 4 秒 setInterval(tick)，pre-flight 校验后调用 runTask

// src/runner/changeCapture.ts
async function captureRepoSnapshot(repoPath: string): Promise<RepoSnapshot>;
async function buildChangeArtifacts(repoPath, before, after): Promise<ChangeArtifacts>;
function extractExternalDirtyFiles(snapshot, repoPath, workspaceRoot): ExternalDirtyFile[];
function findNewExternalDirtyFiles(baseline, current): ExternalDirtyFile[];
async function buildArtifactManifest(changedFiles, repoPath, taskId?): Promise<ArtifactManifest>;
```

#### MCP 工具

```typescript
// src/tools/registry.ts
function getToolDefs(): ToolDef[];  // 生成完整工具定义（66+）
function registerTools(server: Server): void;  // 绑定到 MCP Server
async function handleToolCall(name: string, args?): Promise<{ content }>;
function getToolCatalogSnapshot(): ToolCatalogSnapshot;

// src/tools/createTask.ts
async function createTask(input: CreateTaskInput): Promise<CreateTaskResult>;
// 支持 assess_only 预评估与 execute 执行

// src/tools/runTaskLoop.ts
async function runTaskLoop(input: RunTaskLoopInput): Promise<RunTaskLoopOutput>;
// 安全编排入口，最多 5 轮迭代

// src/tools/auditTask.ts
function auditTask(taskId: string): AuditTaskOutput;
// 16+ 确定性检查，区分 confirmed_failures/possible_false_positives

// src/tools/waitForTask.ts
async function waitForTask(taskId: string, waitSeconds?: number): Promise<WaitResult>;
// 长轮询，返回 continuation_required 或终态证据
```

#### Goal Session

```typescript
// src/goal/goalStore.ts
function createGoal(repoPath, title, description, workspaceRoot?): { goal_id, goal_dir };
function listGoals(workspaceRoot?): GoalSummary[];
function readGoal(goalId, workspaceRoot?): GoalDetail;
function writeGoalStatus(goalId, status, workspaceRoot?): void;
function readGoalStatus(goalId, workspaceRoot?): GoalStatus;
function generateGoalId(title: string, existingIds: string[]): string;  // goal_{YYYYMMDD}_{slug}

// src/goal/goalGraph.ts
function suggestNextSubgoal(goalStatus: GoalStatus): SubgoalSuggestion;

// src/goal/worktreeManager.ts
function createWorktree(repoPath, baseBranch?, workspaceRoot?): WorktreeInfo;
function mergeWorktree(worktreeId, repoPath): MergeResult;
function discardWorktree(worktreeId, repoPath): DiscardResult;
```

#### Direct Session

```typescript
// src/direct/directSessionStore.ts
function generateDirectSessionId(): string;  // ds_{YYYYMMDD}_{randomHex}
function createDirectSession(input: DirectSessionCreateInput): Promise<DirectSessionRecord>;
function readDirectSession(sessionId: string): DirectSessionRecord;
function updateDirectSession(sessionId, patch): void;
function appendDirectSessionOperation(sessionId, operation): void;
function finalizeDirectSessionRecord(sessionId, artifacts): DirectSessionRecord;
function validateDirectSessionFreshness(session): DirectSessionValidationResult;

// src/direct/directGuards.ts
function guardDirectSessionActive(session: DirectSessionRecord): void;
function guardDirectPath(session, requestedPath, allowSensitive): string;
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
| `diff.patch` | 完整任务差异证据 |
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

```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "typescript": "^6.0.3"
  }
}
```

**运行时仅依赖 MCP SDK**，所有其他功能使用 Node.js 内置模块：

- `node:fs` / `node:path` / `node:crypto` / `node:http` / `node:https` / `node:child_process` / `node:os` / `node:url` / `node:net` / `node:timers/promises`

### 7.2 模块依赖图（简化）

```text
index.ts / httpServer.ts
        │
        ▼
   tools/registry.ts ──────────┬── tools/createTask.ts
        │                      ├── tools/runTaskLoop.ts
        │                      ├── tools/auditTask.ts
        │                      ├── tools/safeViews.ts
        │                      ├── tools/taskLineage.ts
        │                      ├── tools/evidencePack.ts
        │                      ├── tools/dispatch/* (分域调度)
        │                      ├── direct/* (Direct 工具)
        │                      ├── goal/* (Goal 工具)
        │                      └── release/releaseGate.ts
        │
        ▼
   config.ts ──── security/* (所有守卫)
        │
        ▼
   runner/watch.ts ──▶ runner/runTask.ts ──▶ runner/changeCapture.ts
                                          ├── runner/agentInvocation.ts
                                          ├── runner/postTaskCleanup.ts
                                          └── runner/simpleProcess.ts

controlCenter.ts ──▶ control/server.ts ──▶ control/routes/* + control/middleware/*
                                     └── control/shared.ts (config bootstrap)
```

### 7.3 关键依赖关系

- **所有写操作** → 必须经 `security/*` 守卫
- **`createTask`** → `riskEngine.assessRisk` → `pathGuard` + `commandGuard` + `planGuard` + `runtimeGuard` + `sensitiveGuard`
- **`runTask`** → `agentInvocation.buildAgentInvocation` → `commandGuard.guardAgentCommand`
- **`runTask`** → `changeCapture.captureRepoSnapshot` + `buildChangeArtifacts`
- **`runTaskLoop`** → 组合 `createTask` + `waitForTask` + `safeViews` + `auditTask`，不直接调用 `runTask`
- **`watch.ts`** → pre-flight 调用 `guardWorkspacePath` + `guardAgentCommand` + `guardTestCommand` 后才调用 `runTask`
- **`invokeDiscoveredTool`** → `discoveryTokenStore.consumeToken` + `toolInvocationGuard.checkInvocation` + 实际 handler 内二次校验
- **`control/shared.ts`** → 导入即触发 bootstrap 副作用（配置加载、token 生成、端口解析），所有 route 模块经此获取 config

---

## 8. 项目运行方式

### 8.1 环境要求

- Node.js ≥ 18
- npm
- Git（可选，但无 Git 无法生成可靠 `git.diff`）
- 至少一个本地编程 Agent（OpenCode 或 Codex CLI）
- Windows Tunnel 模式还需 `tunnel-client.exe`、Tunnel ID、运行时 API Key

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
4. 都不存在时使用 `DEFAULT_CONFIG`（`doctor:ci` 允许默认配置）

最小配置示例：

```json
{
  "workspaceRoot": "D:/ai_agent/codex_program",
  "plansDir": ".patchwarden/plans",
  "tasksDir": ".patchwarden/tasks",
  "toolProfile": "full",
  "agents": {
    "opencode": { "command": "opencode", "args": ["run", "{prompt}"] },
    "codex": { "command": "codex", "args": ["exec", "--cd", "{repo}", "{prompt}"] }
  },
  "allowedTestCommands": ["npm test", "npm run build", "npm run lint", "pytest"],
  "maxReadFileBytes": 200000,
  "defaultTaskTimeoutSeconds": 900,
  "maxTaskTimeoutSeconds": 3600,
  "watcherStaleSeconds": 30,
  "httpPort": 7331
}
```

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
| `npm.cmd run test:mcp` | MCP 烟雾测试 |
| `npm.cmd run test:http-mcp` | HTTP MCP 烟雾测试 |
| `npm.cmd run pack:clean` | 打包清理 |
| `npm.cmd run verify:package` | 包清单校验 |

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
PatchWarden.cmd start core      # 启动 Core Agent 模式（chatgpt_core + Watcher + Tunnel，health 8080）
PatchWarden.cmd start direct    # 启动 Direct 模式（chatgpt_direct + Tunnel，health 8081，无 Watcher）
PatchWarden.cmd stop all        # 停止所有受控进程
PatchWarden.cmd restart all     # 重启所有受控进程
PatchWarden.cmd status all      # 查看运行状态
PatchWarden.cmd health          # 深度健康检查
PatchWarden.cmd kill all        # 强制清理
```

Core 与 Direct 可并发运行，使用不同 tunnel-client profile 与 health 端口（8080 / 8081）。

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

---

## 9. 安全设计

### 9.1 安全分层

```text
┌─────────────────────────────────────────────────┐
│  MCP 客户端（ChatGPT/Codex/OpenCode）            │  ← 模型指令被视为不可信输入
├─────────────────────────────────────────────────┤
│  tools/registry.ts                              │  ← 工具注册 + Profile 过滤
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
│  tools/safeViews.ts       ← safe_* 有界摘要      │
└─────────────────────────────────────────────────┘
```

### 9.2 安全不变量

PatchWarden 的硬性约束（在 `watch.ts` 与 `runTask.ts` 中声明）：

- `repo_path` 必须在 `workspaceRoot` 内，不能通过 `..` 跳出
- Agent 必须在 `agents` 配置白名单中，命令来自本地配置而非模型输入
- `test_command` / `verify_commands` 必须逐字匹配全局或仓库专属白名单
- 每个任务最多运行一次（无自动重试循环）
- 不自动 commit、不自动 push、不删除文件、不发布、不重置仓库
- 敏感文件名（`.env`/SSH 私钥/`credentials`/`cookies` 等）默认不可读
- 任务产物中的疑似密钥值会被脱敏
- HTTP Server 只绑定 `127.0.0.1`
- Windows DPAPI 加密 Tunnel 凭据，不写入仓库

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

---

## 10. 测试与发布

### 10.1 测试体系

| 测试类型 | 命令 | 覆盖范围 |
| --- | --- | --- |
| 完整测试链 | `npm.cmd test` | smoke + unit + lifecycle + doctor + tunnel + watcher + control + mcp + brand |
| 单元测试 | `npm.cmd run test:unit` | `src/test/unit/*.test.ts`（40+ 测试文件） |
| MCP 烟雾测试 | `npm.cmd run test:mcp` | stdio MCP 工具调用 |
| HTTP MCP 烟雾测试 | `npm.cmd run test:http-mcp` | HTTP MCP 端点 |
| 生命周期测试 | `npm.cmd run test:lifecycle` | 任务完整生命周期 |
| Doctor 烟雾测试 | `npm.cmd run test:doctor` | 诊断脚本 |
| Tunnel 监督测试 | `npm.cmd run test:tunnel-supervisor` | Tunnel 启动器 |
| Watcher 监督测试 | `npm.cmd run test:watcher-supervisor` | Watcher 心跳与所有权 |
| Control 烟雾测试 | `npm.cmd run test:control`（实际为 control-center-smoke） | Control Center API |
| 工具 Manifest 校验 | `npm.cmd run check:tool-manifest` | 工具清单一致性 |
| 品牌检查 | `npm.cmd run check:brand` | 品牌命名一致性 |

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

`pack:clean` 与 `verify:package` 会排除：

- `node_modules/`
- `.patchwarden/`
- `*.log`
- `.env`
- `patchwarden.config.json`
- 本地凭据和运行时状态

---

## 11. 现有缺陷与改进建议

本节基于对 `src/` 的静态代码审查，按严重程度分类列出 28 项发现。每条均含文件路径、行号证据与改进建议。

### 11.1 高严重度

#### H1. Watcher tick 并发竞态条件
- **文件**：[src/runner/watch.ts:56-161](../src/runner/watch.ts#L56-L161)
- **描述**：`setInterval(tick, POLL_INTERVAL_MS)`（行 158）调度异步 `tick()`。当某个任务的 `await runTask(taskId)` 耗时超过 4 秒时，下一次 tick 会在前一次未完成时启动，导致两个 tick 同时遍历 `taskDirs`、并发读写同一 `status.json` 与心跳文件。`executedTasks` Set 虽同步操作，但 pre-flight 检查仍可能重复执行。
- **建议**：用 `let running = false;` 互斥锁包裹 tick（开始时检查并置位，结束/异常时复位），或 tick 开始时 `clearInterval` 并在结束后重新调度。

#### H2. 安全核心模块缺少单元测试
- **文件**：`src/test/unit/` 目录对比
- **缺失测试的模块**：
  - [security/contentRedaction.ts](../src/security/contentRedaction.ts) — 脱敏正则无回归保护
  - [security/planGuard.ts](../src/security/planGuard.ts) — 仅由 `doctor.ts:260-279` smoke 测试覆盖 2 个用例
  - [security/riskEngine.ts](../src/security/riskEngine.ts) — 决策矩阵未覆盖
  - [security/runtimeGuard.ts](../src/security/runtimeGuard.ts) — 运行时自修改守卫无测试
- **描述**：这四个模块是纵深防御核心，正则或决策变更无单元测试拦截。`runner/changeCapture.ts`（作用域违规检测核心）、`direct/directSessionStore.ts`、`assessments/assessmentStore.ts` 也无 dedicated 测试，共 20+ 关键模块缺测试。
- **建议**：至少为上述四个安全模块与 `changeCapture.ts` 补充单元测试，覆盖所有规则与边界（中英文混合、否定语境、超长输入）。

### 11.2 中严重度

#### M1. Token 比较存在时序攻击风险
- **文件**：
  - [src/control/middleware/auth.ts:16](../src/control/middleware/auth.ts#L16) — `return provided === controlToken;`
  - [src/httpServer.ts:61](../src/httpServer.ts#L61) — `return authHeader.slice(7) === ownerToken;`
  - [src/httpServer.ts:65](../src/httpServer.ts#L65) — `return customHeader === ownerToken;`
- **描述**：token 比较使用 `===`，理论上可经响应时间逐字节猜测。虽绑定 127.0.0.1，但作为安全项目不应留此隐患。
- **建议**：改用 `crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected))`，先比较长度。

#### M2. Discovery Token Store 与 executedTasks 内存泄漏
- **文件**：
  - [src/security/discoveryTokenStore.ts:48](../src/security/discoveryTokenStore.ts#L48) — `const tokenStore = new Map<...>()`
  - [src/runner/watch.ts:52](../src/runner/watch.ts#L52) — `const executedTasks = new Set<string>()`
- **描述**：`consumeToken` 仅在被访问时清理过期项；签发但未消费的 token 永久驻留。Watcher 常驻进程持续把每个 taskId 加入 Set，从不清理。长期运行（数周）会累积大量条目。
- **建议**：`issueToken` 时启动定期清理；`executedTasks` 改 LRU 或基于任务目录是否存在判断。

#### M3. httpServer 未配置 token 时默认放行
- **文件**：[src/httpServer.ts:54-55](../src/httpServer.ts#L54-L55) — `if (!ownerToken) return true; // no token configured — allow all`
- **描述**：绑定 127.0.0.1，但共享开发机/远程桌面环境下同机其他用户进程可无鉴权调用 MCP 写工具，仅打印警告日志（行 51）。
- **建议**：未配置 token 时拒绝写操作，或要求显式 `--allow-no-auth` 启动参数。

#### M4. `commandGuard.ts` 注释与实现不符
- **文件**：[src/security/commandGuard.ts:32-38](../src/security/commandGuard.ts#L32-L38)
- **描述**：注释声称"Validate args don't contain shell metacharacters"，但 `map` 函数只是原样返回 args，无任何校验。args 虽来自本地配置，但配置被篡改时元字符不会被拦截。
- **建议**：要么真正校验（复用 `isSafeConfiguredCommand` 逻辑），要么删除误导性注释。

#### M5. `sensitiveGuard.ts` 匹配 `config.json` 过于宽泛
- **文件**：[src/security/sensitiveGuard.ts:36](../src/security/sensitiveGuard.ts#L36) — `/(?:^|[\\/])config\.json$/i`
- **描述**：匹配任何路径下的 `config.json`，会阻断项目内合法的配置文件读取（如 `packages/foo/config.json`），影响可用性。
- **建议**：缩小到根目录或特定子目录，或改为基于内容启发式（检测 token-like 字符串才阻断）。

#### M6. `directPatch.ts` 写文件非原子
- **文件**：[src/direct/directPatch.ts:100](../src/direct/directPatch.ts#L100) — `writeFileSync(filePath, content, "utf-8");`
- **描述**：Direct 模式直接覆盖目标文件。进程崩溃或断电时文件可能部分写入，而 `expected_sha256` 已校验旧内容，状态不一致。`watch.ts` 心跳已用 tmp+rename 原子写，此处未对齐。
- **建议**：写入临时文件后 `renameSync` 原子替换。

#### M7. `writeFileSyncAppend` 非原子且低效
- **文件**：[src/runner/simpleProcess.ts:220-223](../src/runner/simpleProcess.ts#L220-L223)
- **描述**：读取整个文件再重写：(1) 大日志文件越来越慢；(2) 与其他进程的 `appendFileSync` 并发会丢数据。
- **建议**：直接用 `appendFileSync(path, content, "utf-8")`。

#### M8. `full` Profile 工具数量文档不一致
- **文件**：
  - [docs/CODE_WIKI.md:86](./CODE_WIKI.md) 与 [README.md:928](../README.md) 声明 64
  - [src/tools/registry.ts](../src/tools/registry.ts) 实际 66（+1 条件性 `run_task` = 67）
- **描述**：新增工具后未更新文档。`mcp-manifest-check.js` 存在但似乎未校验数量。
- **建议**：更新文档为 66，并在 manifest check 中加入数量断言。（本文档已修正为 66。）

#### M9. 单文件过长（registry.ts / runTask.ts / smoke-test.ts）
- **文件**：
  - [src/tools/registry.ts](../src/tools/registry.ts) — 1412 行，66+ 工具定义集中
  - [src/runner/runTask.ts](../src/runner/runTask.ts) — 1292 行，含执行主循环/子进程管理/心跳/artifact 收集/verify 报告多职责
  - [src/smoke-test.ts](../src/smoke-test.ts) — 2300+ 行，16+ 测试段
- **描述**：修改任一工具 schema 需在巨型数组中定位；`runManagedProcess`（行 760-885，约 125 行）含 spawn/stream/心跳/终止多关注点。
- **建议**：`registry.ts` 按域拆到 `tools/definitions/*.ts`（dispatch/ 已部分拆分）；`runTask.ts` 拆为 `runTask`（编排）+ `ManagedProcess` 类 + `verifyReport`；`smoke-test.ts` 按段拆到 `smoke/*.ts`。

#### M10. 配置项过多导致校验复杂度高
- **文件**：[src/config.ts:11-46](../src/config.ts#L11-L46)（25+ 字段）、`normalizeConfig` 行 180-374 近 200 行校验
- **描述**：新增 `tunnelProxy`、`directAllowedCommands` 等字段时易遗漏校验。
- **建议**：引入 schema 验证（如 zod，但项目约束无第三方依赖，可用自研轻量校验），或把校验拆到 per-field 函数。

### 11.3 低严重度

#### L1. 空的 catch 块（23 处）
- **文件**：`doctor.ts:200`、`runTask.ts:829,830,1258,1275`、`simpleProcess.ts:65,68,199,216`、`changeCapture.ts:298`、`healthCheck.ts:198,204,205`、`smoke-test.ts`（11 处）
- **描述**：多数为合理 best-effort 清理，但 `doctor.ts`/`healthCheck.ts` 探针失败完全静默，调试时难以区分"不存在"与"权限不足"。
- **建议**：至少 debug 日志记录失败原因，或 `catch (err) { /* expected: ... */ }` 说明预期错误。

#### L2. 硬编码魔术数字
- **文件**：`runTask.ts:41-44`、`runTask.ts:833`（内联 10s）、`simpleProcess.ts:27-28`、`changeCapture.ts:15-17`、`watch.ts:37`、`releaseGate.ts:87-88`、`control/routes/process.ts:57,207,249`、`control/runtime.ts:55`、`control/server.ts:473`
- **描述**：核心模块已抽常量，但 control 路由与 runTask 内 fallback 定时器仍大量内联数字。
- **建议**：统一为命名常量并集中到常量模块。

#### L3. `any` 类型滥用
- **文件**：`watch.ts:85`、`runTask.ts:98,1250`、`releaseGate.ts:52,143`、`doctor.ts:328,329`、`agentAssessor.ts:256,275,300`、`projectPolicy.ts:339,340`、`httpServer.ts:219`
- **描述**：安全敏感项目在状态文件解析处应严格类型，避免字段拼写错误逃过编译期。`smoke-test.ts` 30+ 处 `as any` 可接受，生产代码应换 `unknown` + 类型守卫。

#### L4. `forceKill`/`gracefulKill` 代码重复
- **文件**：[src/runner/runTask.ts:1254-1277](../src/runner/runTask.ts#L1254-L1277) 与 [src/runner/simpleProcess.ts:195-218](../src/runner/simpleProcess.ts#L195-L218)
- **描述**：两文件含几乎相同的 Windows taskkill + POSIX kill 实现。
- **建议**：抽取到共享 `runner/processKill.ts`。

#### L5. `sanitizePromptArg` 未处理 DEL 与 Unicode 控制字符
- **文件**：[src/security/commandGuard.ts:138](../src/security/commandGuard.ts#L138) — `return prompt.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");`
- **描述**：未处理 `\x7F`（DEL）与 Unicode 方向控制字符（U+202E 等），后者可隐藏恶意指令。
- **建议**：补充 `\x7F` 与 `\u200E-\u200F\u202A-\u202E` 范围。

#### L6. `enableRunTaskTool` 配置项未在文档说明
- **文件**：[src/config.ts:28](../src/config.ts#L28) 定义、[src/tools/registry.ts:1258](../src/tools/registry.ts#L1258) 条件注册 `run_task`
- **描述**：CODE_WIKI 与 README 均未提及该选项。（本文档已在 5.1 标注。）

#### L7. README `chatgpt_direct` 版本标注过时
- **文件**：[README.md:938](../README.md) — "v1.4 包含 14 个工具"
- **描述**：当前版本 v1.5.1，描述停留在 v1.4。工具数 14 正确，但版本标注过时。

#### L8. 命名约定不一致
- **描述**：`src/tools/` 文件混用 camelCase；`src/control/routes/` 用 lowercase；工具名 snake_case 与 TS 函数 camelCase 分离合理但文件命名风格不统一。
- **建议**：在 CONTRIBUTING.md 明确文件命名规范。

#### L9. 中英文注释混用
- **文件**：`discoveryTokenStore.ts`、`toolInvocationGuard.ts`（全中文）、`commandGuard.ts`/`pathGuard.ts`（全英文）、`logging.ts`（混用）
- **建议**：开源项目统一英文注释，或在 CONTRIBUTING.md 说明双语规范。

### 11.4 缺陷汇总

| 类别 | 高 | 中 | 低 | 合计 |
| --- | --- | --- | --- | --- |
| 代码质量 | 0 | 2 | 1 | 3 |
| Bug/边界 | 1 | 4 | 1 | 6 |
| 架构设计 | 0 | 3 | 1 | 4 |
| 安全隐患 | 0 | 4 | 2 | 6 |
| 测试覆盖 | 1 | 1 | 0 | 2 |
| 文档不一致 | 0 | 1 | 2 | 3 |
| 可维护性 | 0 | 1 | 3 | 4 |
| **合计** | **2** | **16** | **10** | **28** |

### 11.5 优先修复建议（按顺序）

1. **H1** 修复 watcher 并发竞态（加 tick 互斥锁）
2. **H2** 为 `contentRedaction`/`planGuard`/`riskEngine`/`runtimeGuard` 补单元测试
3. **M1** token 比较改用 `crypto.timingSafeEqual`
4. **M2** discovery token 与 executedTasks 加定期清理
5. **M3** httpServer 无 token 时拒绝写操作或要求显式开关
6. **M8** 同步 `full` profile 工具数文档（README，已本文档修正）
7. **M4** 修正 `commandGuard.ts` 误导性注释
8. **M6/M7** `directPatch.ts` 与 `writeFileSyncAppend` 改原子/追加写

> 说明：以上为静态审查结论，未运行动态分析。部分"问题"（如空 catch）在 best-effort 语境下合理，应结合实际运行场景评估优先级。

---

## 附录：关键设计原则

1. **最小权限**：MCP 工具不提供通用 Shell，每个工具只做一件事
2. **纵深防御**：多层守卫串联，任一层失效不导致整体失守
3. **不可信输入**：模型指令始终被视为不可信，本地配置才是信任源
4. **可审计性**：所有任务产出结构化证据，支持独立验收
5. **不自动破坏**：不自动 commit/push/publish/tag/release，需人工决策
6. **有界输出**：`safe_*` 系列工具返回有界摘要，避免触发平台内容过滤
7. **零运行时依赖**：仅依赖 MCP SDK，其他全部使用 Node.js 内置模块
8. **跨平台**：Windows 与 POSIX 兼容（进程管理、路径处理、命令包装）
