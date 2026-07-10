# 为什么需要 PatchWarden

> 本文基于 v1.5.1 源码编写；安装时请使用已验证发布的 <published-version>。
> 面向：使用 ChatGPT、Codex、OpenCode 等 MCP 客户端但需要安全边界的开发者

## 背景：本地 Agent 的安全缺口

当前主流的本地编程 Agent（如 ChatGPT 桌面端、Codex CLI、OpenCode、OpenHands）
在带来生产力提升的同时，也引入了新的攻击面：

- Agent 可执行本地命令，一旦被 prompt injection 或上下文污染，可能执行越权操作。
- 通用远程 Shell 模式将完整命令执行能力暴露给 MCP 客户端，缺乏边界。
- 任务产物分散在 stdout / stderr / diff 中，难以审计与验收。
- `.env`、token、SSH key、cookie、浏览器状态等敏感文件缺乏强制隔离。

PatchWarden 不是另一个通用 Shell。它定位为本地优先的 MCP 安全与验证层
（local-first MCP safety and verification layer for AI coding agents），
在不牺牲 Agent 能力的前提下提供可审计的安全边界。

## 核心价值

### 1. Workspace Confinement（工作区隔离）

所有仓库路径必须位于配置的 `workspaceRoot` 之下。PatchWarden 会阻断：

- 越出 workspace 的文件读写。
- 对敏感文件名（如 `.env`、`id_rsa`、`cookies.db`）的访问。
- 跨仓库的非授权改动。

### 2. Command Allowlists（命令允许列表）

PatchWarden 采用精确命令匹配，而非宽松的 glob 或前缀匹配：

- 只有显式注册的命令才能执行。
- 参数变化同样受约束，避免命令注入绕过。
- 不存在“允许 `git` 即允许任意 git 子命令”的隐式放大。

### 3. Scope-Violation Detection（范围违规检测）

Agent 提出的任务若超出声明的 scope（例如修改了未授权文件、执行了未注册命令），
PatchWarden 会在执行前或执行中识别并阻断，而不是事后才在日志里发现。

### 4. Auditable Task Evidence（可审计任务证据）

每个任务通过 Evidence Pack v2 导出 8 个有界文件：

| 文件 | 用途 |
| --- | --- |
| `evidence.json` | 完整有界证据包（机器可读） |
| `EVIDENCE.md` | 人类可读的 Markdown 摘要 |
| `risk.json` | 聚合的风险项与严重度 |
| `verify.json` | 每轮迭代的结构化验证记录 |
| `diffstat.json` | 文件级增删统计（不含完整 diff） |
| `lineage.json` | 任务谱系与上下文链 |
| `attestation.json` | 任务签名与证明 |
| `redactions.json` | 已脱敏内容清单 |

这些文件只包含有界摘要，**不**包含完整 stdout/stderr、完整 diff、
secrets、token、cookie 或凭据路径。

## 与通用远程 Shell 的区别

| 维度 | 通用远程 Shell | PatchWarden |
| --- | --- | --- |
| 命令执行 | 任意命令 | 精确允许列表 |
| 路径访问 | 通常无约束 | 强制 workspace 隔离 |
| 敏感文件 | 取决于调用方自觉 | 强制阻断 |
| 任务证据 | 散落在日志 | 8 个有界文件可审计 |
| 范围违规 | 事后发现 | 执行前/中阻断 |
| MCP 客户端权限 | 全权委托 | 受约束代理 |

PatchWarden 假设上游模型或 MCP 客户端可能出错、过度宽泛或被 prompt injection。
它不应被信任以无约束方式执行命令。

## 适用场景

- 使用 ChatGPT / Codex / OpenCode / OpenHands 等 MCP 客户端进行本地代码维护。
- 需要对 Agent 任务进行可审计验收的团队或个人。
- 希望将 Agent 限制在特定 workspace 内的开发工作流。
- 需要生成 spec 验收证据的 spec-driven 开发流程。

## 不适用场景

- 需要任意远程 shell 访问的场景（PatchWarden 刻意不提供）。
- 需要读取或修改 `.env`、SSH key、浏览器状态等敏感文件的工作流。
- 需要 Agent 跨多个不受信任 workspace 自由移动的场景。
- 不接受命令允许列表约束的通用任务执行需求。

## 目标用户

- 使用 ChatGPT 桌面端、Codex CLI、OpenCode 等 MCP 客户端的开发者。
- 在本地维护多个仓库并希望统一安全边界的维护者。
- 需要为 Agent 任务生成可审计证据的团队。
- 对 prompt injection 风险敏感、希望有执行前阻断机制的安全工程师。

## 安全契约要点

PatchWarden 的安全契约（详见 `docs/threat-model.md`）包括：

- 不暴露通用远程 shell，不弱化精确命令匹配。
- 所有仓库路径保持在 `workspaceRoot` 下，阻断敏感名与越界改动。
- 不读取或持久化 token、cookie、浏览器状态、`.env`、SSH key、凭据文件。
- 不无差别 kill watcher 或 tunnel，仅监督 launcher 拥有的进程。
- 保留结构化任务证据、心跳状态、Git before/after 快照、改动文件记录与脱敏。

## 下一步

- 阅读 `docs/threat-model.md` 了解完整威胁模型。
- 阅读 `docs/evidence-pack-schema.md` 了解证据包文件结构。
- 阅读 `docs/dashboard-overview.md` 了解 Control Center 工作流。
