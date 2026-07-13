# PatchWarden Code Wiki

> 本文档是对 PatchWarden 仓库的结构化代码导览，覆盖项目整体架构、主要模块职责、关键类与函数说明、依赖关系及运行方式。
> 源码版本：**v1.5.1** · Schema Epoch：`2026-07-05-v13` · License：MIT

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

**技术栈**：TypeScript + Node.js（≥18）+ `@modelcontextprotocol/sdk`，无任何运行时第三方依赖。

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

### 2.3 三种工具 Profile

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

---

## 3. 目录结构

```text
PatchWarden/
├── src/                          # TypeScript 源码
│   ├── index.ts                  # stdio MCP Server 入口
│   ├── httpServer.ts             # HTTP MCP Server 入口（127.0.0.1 only）
│   ├── controlCenter.ts          # 本地 Control Center Dashboard
│   ├── doctor.ts                 # 只读诊断脚本
│   ├── config.ts                 # 配置加载与校验
│   ├── errors.ts                 # PatchWardenError 错误模型
│   ├── logging.ts                # 审计日志
│   ├── version.ts                # 版本与 Schema Epoch
│   ├── taskRuntime.ts            # runtime.json 状态读写
│   ├── taskProgress.ts           # progress.md 生成
│   ├── watcherStatus.ts          # Watcher 心跳状态
│   ├── smoke-test.ts             # 烟雾测试入口
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
│   │   ├── runTask.ts
│   │   ├── watch.ts
│   │   ├── agentInvocation.ts
│   │   ├── changeCapture.ts
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
│   │   ├── registry.ts           # 工具注册中枢
│   │   ├── toolCatalog.ts        # Profile 与 Manifest
│   │   ├── toolRegistry.ts       # 工具元数据
│   │   ├── toolSearch.ts         # 工具搜索
│   │   ├── createTask.ts
│   │   ├── runTaskLoop.ts        # 安全编排入口
│   │   ├── taskLineage.ts        # 链路记录
│   │   ├── evidencePack.ts       # 证据包导出
│   │   ├── auditTask.ts          # 独立审计
│   │   ├── safeViews.ts          # safe_* 系列摘要
│   │   ├── healthCheck.ts
│   │   ├── waitForTask.ts
│   │   └── ... (50+ 工具文件)
│   └── test/unit/                # 单元测试
├── ui/                           # Control Center 前端
│   ├── pages/                    # dashboard/tasks/audit 等页面
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
├── package.json
├── tsconfig.json
└── PatchWarden.cmd               # Windows 统一控制入口
```

---

## 4. 核心模块职责

### 4.1 入口层

| 文件 | 职责 |
| --- | --- |
| [src/index.ts](../src/index.ts) | stdio MCP Server 入口，加载配置、注册工具、连接 StdioServerTransport |
| [src/httpServer.ts](../src/httpServer.ts) | HTTP MCP Server，绑定 `127.0.0.1:7331`，每请求独立 MCP 实例，支持 owner token 与 `/admin/tasks/:id/accept` 验收端点 |
| [src/controlCenter.ts](../src/controlCenter.ts) | 本地 Dashboard HTTP 服务（默认 `127.0.0.1:8090`），服务 `ui/` 静态资源，提供任务/会话/lineage/证据包 JSON API，并代理 `manage-patchwarden.ps1` 管理进程生命周期 |
| [src/doctor.ts](../src/doctor.ts) | 只读诊断脚本，检查 15+ 项：Node/npm/Git 版本、配置、工作区、路径保护、敏感文件、Agent 命令、工具 Manifest、HTTP 端口、Watcher 目录、构建产物 |

### 4.2 配置与基础

| 文件 | 职责 |
| --- | --- |
| [src/config.ts](../src/config.ts) | 加载并校验 `patchwarden.config.json`，提供 `loadConfig`/`getConfig`/`getTasksDir`/`getPlansDir` 等路径解析；严格校验 `workspaceRoot`、`agents`、`allowedTestCommands`、`watcherStaleSeconds`、`toolProfile` 等字段 |
| [src/errors.ts](../src/errors.ts) | 定义 `PatchWardenError`（含 `reason`/`suggestion`/`blocked`/`details`）与 `errorPayload` 序列化 |
| [src/version.ts](../src/version.ts) | 导出 `PATCHWARDEN_VERSION = "1.5.1"` 与 `TOOL_SCHEMA_EPOCH = "2026-07-05-v13"` |
| [src/logging.ts](../src/logging.ts) | `Logger` 类输出 stderr JSON 日志，记录 `audit`/`info`/`warn`/`error`；`logToolInvocation` 仅写参数 digest，不写原参数；`installGlobalHandlers` 捕获未处理异常但不吞错 |

### 4.3 安全模块（src/security/）

PatchWarden 的纵深防御核心，所有写操作前都会经过这些守卫。

| 文件 | 职责 |
| --- | --- |
| [commandGuard.ts](../src/security/commandGuard.ts) | 命令白名单守卫：`guardAgentCommand` 校验 agent 已配置且命令无 shell 元字符；`guardTestCommand` 精确匹配测试白名单；`guardDirectCommand` 校验 Direct 白名单；`sanitizePromptArg` 清洗控制字符 |
| [pathGuard.ts](../src/security/pathGuard.ts) | 路径横移守卫：`guardPath`/`guardReadPath`/`guardWorkspacePath` 确保路径解析后都在 `workspaceRoot` 内，用 `realpath` 防符号链接逃逸，Windows 下做盘符一致性检查 |
| [sensitiveGuard.ts](../src/security/sensitiveGuard.ts) | 敏感文件守卫：`isSensitivePath` 匹配 `.env`/SSH 私钥/`credentials`/`.npmrc`/`cookies`/`.kube/config` 等；`.patchwarden/` 前缀豁免 |
| [planGuard.ts](../src/security/planGuard.ts) | 计划内容守卫：`guardPlanContent` 扫描 plan 文本，拦截"读取密钥/破坏性删除/植入后门"等危险指令，支持中英文否定语境检测 |
| [riskEngine.ts](../src/security/riskEngine.ts) | 综合风险评估：`assessRisk` 串联各 guard 输出 `risk_level`（low/medium/high）+ `decision`（allow/needs_confirm/blocked）+ `reason_codes`；`collectRiskHints` 仅做关键词提示，不影响决策 |
| [runtimeGuard.ts](../src/security/runtimeGuard.ts) | 阻止任务把 `repo_path` 指向运行中的 PatchWarden 自身目录（`dist`/`src`/`scripts`/`release`） |
| [contentRedaction.ts](../src/security/contentRedaction.ts) | 输出脱敏：`redactSensitiveContent`/`redactSensitiveValue` 按正则替换私钥、bearer token、npm token、凭据赋值、已知 token 格式 |
| [toolInvocationGuard.ts](../src/security/toolInvocationGuard.ts) | `invoke_discovered_tool` 调用前 8 项校验：token 匹配、profile 允许、风险等级、敏感路径、assessment 必需、命令元字符、release 确认、credential 拒绝 |
| [discoveryTokenStore.ts](../src/security/discoveryTokenStore.ts) | 服务端 discovery token 存储：`issueToken`/`consumeToken`（单次使用）/`peekToken`/`revokeToken`，纯内存、10 分钟 TTL、不持久化 |

### 4.4 Runner 模块（src/runner/）

任务执行的核心，编排从启动到产出 artifact 的完整生命周期。

| 文件 | 职责 |
| --- | --- |
| [cli.ts](../src/runner/cli.ts) | Runner 子进程入口，从 argv 或 `PATCHWARDEN_TASK_ID` 读取 taskId 并调用 `runTask` |
| [runTask.ts](../src/runner/runTask.ts) | **执行主循环**：`runTask(taskId)` 编排 preparing → executing_agent → running_tests → collecting_artifacts → done/failed；管理心跳（2s）、超时、cancel/kill；产出 16+ artifact 文件；区分 `failed_scope_violation`/`failed_policy_violation` |
| [watch.ts](../src/runner/watch.ts) | 常驻 watcher，每 4 秒轮询 `pending` 任务，执行 pre-flight 安全校验后调用 `runTask`；原子写心跳文件；通过 env 注入 `WATCHER_INSTANCE_ID`/`WATCHER_LAUNCHER_PID` 支持所有权判定 |
| [agentInvocation.ts](../src/runner/agentInvocation.ts) | 构建 agent 调用参数与 prompt：`buildAgentInvocation`/`buildExecutionPrompt`/`buildAssessmentPrompt`；占位符 `{repo}`/`{prompt}`/`{prompt_file}` 替换 |
| [changeCapture.ts](../src/runner/changeCapture.ts) | 仓库快照与变更证据：`captureRepoSnapshot` 并行跑 5 个 git 命令；`buildChangeArtifacts` 比对快照生成 diff；`extractExternalDirtyFiles` 建立外部脏文件基线；`buildArtifactManifest` 生成带 sha256 的产物清单 |
| [postTaskCleanup.ts](../src/runner/postTaskCleanup.ts) | 任务后清理：仅删除未被 git 跟踪且被忽略的临时产物（`__pycache__`/`dist`/`*.pyc`），三道闸门保护受控文件 |
| [simpleProcess.ts](../src/runner/simpleProcess.ts) | 轻量进程执行器：`runSimpleProcess`/`runSimpleProcessSync`，带输出上限（512KB/128KB）、超时、截断标志，供 `run_verification` 等非任务流程使用 |

### 4.5 Tools 模块（src/tools/）

MCP 工具实现与注册中枢。

| 文件 | 职责 |
| --- | --- |
| [registry.ts](../src/tools/registry.ts) | **工具注册中枢**：`getToolDefs` 生成完整工具定义（含 inputSchema）；`registerTools` 绑定 `ListToolsRequestSchema`/`CallToolRequestSchema`；`handleToolCall` 分发 60+ 工具调用；保证 list/call 一致性，附 `_meta`（server_version/schema_epoch/tool_manifest_sha256） |
| [toolCatalog.ts](../src/tools/toolCatalog.ts) | Profile 与 Manifest：`resolveToolProfile`/`selectToolsForProfile` 按 profile 过滤工具；`buildToolCatalogSnapshot` 计算 `tool_manifest_sha256` 用于漂移检测 |
| [toolRegistry.ts](../src/tools/toolRegistry.ts) | 工具元数据（risk/tags/aliases/profiles/modes） |
| [toolSearch.ts](../src/tools/toolSearch.ts) | 自然语言工具搜索（中英文） |
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

### 4.6 Goal 模块（src/goal/）

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

### 4.7 Direct 模块（src/direct/）

v0.6.0 引入的 ChatGPT 直接编辑模式。

| 文件 | 职责 |
| --- | --- |
| [directSessionStore.ts](../src/direct/directSessionStore.ts) | Direct Session CRUD：`createDirectSession`/`readDirectSession`/`updateDirectSession`/`finalizeDirectSessionRecord`；记录 operations/verification_runs；`computeWorkspaceFingerprint` |
| [directGuards.ts](../src/direct/directGuards.ts) | Direct 守卫：`guardDirectSessionActive`/`guardDirectSessionFinalized`/`guardDirectPath`/`guardDirectReadPath`/`guardDirectWritePath`/`guardDirectPatchSize`/`isBinaryFile` |
| [directPatch.ts](../src/direct/directPatch.ts) | JSON patch 应用：支持 `replace_exact`/`insert_before`/`insert_after`/`replace_whole_file`，校验 `expected_sha256` |
| [directAudit.ts](../src/direct/directAudit.ts) | 16 项确定性审计，返回 pass/warn/fail |
| [directVerification.ts](../src/direct/directVerification.ts) | 白名单验证命令执行 |

### 4.8 其他模块

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
  enableDirectProfile?: boolean;      // 是否启用 Direct 模式
  directSessionsDir: string;
  directSessionTtlSeconds: number;
  directMaxPatchBytes: number;
  directMaxFileBytes: number;
  directAllowedCommands?: string[];
  repoDirectAllowedCommands?: Record<string, string[]>;
  // ... 其他可选字段
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
// 每 4 秒轮询 pending 任务，pre-flight 校验后调用 runTask

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
function getToolDefs(): ToolDef[];  // 生成完整工具定义
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

- `node:fs` / `node:path` / `node:crypto` / `node:http` / `node:child_process` / `node:os` / `node:url` / `node:net` / `node:timers/promises`

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
```

### 7.3 关键依赖关系

- **所有写操作** → 必须经 `security/*` 守卫
- **`createTask`** → `riskEngine.assessRisk` → `pathGuard` + `commandGuard` + `planGuard` + `runtimeGuard` + `sensitiveGuard`
- **`runTask`** → `agentInvocation.buildAgentInvocation` → `commandGuard.guardAgentCommand`
- **`runTask`** → `changeCapture.captureRepoSnapshot` + `buildChangeArtifacts`
- **`runTaskLoop`** → 组合 `createTask` + `waitForTask` + `safeViews` + `auditTask`，不直接调用 `runTask`
- **`watch.ts`** → pre-flight 调用 `guardWorkspacePath` + `guardAgentCommand` + `guardTestCommand` 后才调用 `runTask`
- **`invokeDiscoveredTool`** → `discoveryTokenStore.consumeToken` + `toolInvocationGuard.checkInvocation` + 实际 handler 内二次校验

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
PatchWarden.cmd start core      # 启动 Core Agent 模式（chatgpt_core + Watcher + Tunnel）
PatchWarden.cmd start direct    # 启动 Direct 模式（chatgpt_direct + Tunnel，无 Watcher）
PatchWarden.cmd stop all        # 停止所有受控进程
PatchWarden.cmd restart all     # 重启所有受控进程
PatchWarden.cmd status all      # 查看运行状态
PatchWarden.cmd health          # 深度健康检查
PatchWarden.cmd kill all        # 强制清理
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
| Control 烟雾测试 | `npm.cmd run test:control` | Control Center API |
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

## 附录：关键设计原则

1. **最小权限**：MCP 工具不提供通用 Shell，每个工具只做一件事
2. **纵深防御**：多层守卫串联，任一层失效不导致整体失守
3. **不可信输入**：模型指令始终被视为不可信，本地配置才是信任源
4. **可审计性**：所有任务产出结构化证据，支持独立验收
5. **不自动破坏**：不自动 commit/push/publish/tag/release，需人工决策
6. **有界输出**：`safe_*` 系列工具返回有界摘要，避免触发平台内容过滤
7. **零运行时依赖**：仅依赖 MCP SDK，其他全部使用 Node.js 内置模块
8. **跨平台**：Windows 与 POSIX 兼容（进程管理、路径处理、命令包装）
