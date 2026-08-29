# PatchWarden

<p align="right">
  <a href="./README.en.md">English</a> · <strong>简体中文</strong>
</p>

[![最新版本](https://img.shields.io/github/v/release/jiezeng2004-design/PatchWarden?label=release)](https://github.com/jiezeng2004-design/PatchWarden/releases/latest)
[![Node.js >= 20](https://img.shields.io/badge/Node.js-%3E%3D20-339933.svg)](https://nodejs.org/)
[![Windows x64](https://img.shields.io/badge/Windows-x64-0078D4.svg)](https://github.com/jiezeng2004-design/PatchWarden/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

> **让 ChatGPT 规划，本地 Agent 执行，但别把整台电脑直接交给它。**
>
> PatchWarden 把 ChatGPT 和 Codex CLI、Claude Code、OpenCode 等本地 Agent 连起来，只在你批准的工作区和验证边界内执行，并留下可检查的 Diff、验证和审计证据。

它不是通用远程 Shell，而是一条 **受控、可验证、可审计的 Agent 执行通道**。

[下载最新 Windows 版本](https://github.com/jiezeng2004-design/PatchWarden/releases/latest) · [快速开始](#5-分钟快速上手) · [连接 ChatGPT](#连接-chatgpt) · [安全边界](#安全边界)

<p align="center">
  <img src="https://raw.githubusercontent.com/jiezeng2004-design/PatchWarden/main/docs/assets/PatchWarden_Demo_Highlight.gif" width="800" alt="PatchWarden workflow demo">
</p>

<p align="center"><sub>真实工作流演示。敏感信息已遮挡。</sub></p>

## 为什么需要 PatchWarden

直接让远程 AI 控制本地开发环境，最难的不是“能不能执行”，而是：

- 它到底能访问哪些目录？
- 能不能随便跑命令？
- Agent 说“测试通过”时，有没有独立证据？
- 改了哪些文件，是否超出批准范围？
- 最终是谁、基于什么证据接受了这次修改？

PatchWarden 把这些问题放进执行链路本身：

```text
ChatGPT
   ↓  任务 + 约束
PatchWarden
   ↓  工作区 / Agent / 命令边界
Local coding agent
   ↓
Workspace changes
   ↓
Verification + diff + audit + lineage
   ↓
Human acceptance
```

## 你能得到什么

- **工作区边界**：任务只能在配置的 `workspaceRoot` 内运行。
- **Agent 边界**：只调用你本机已经安装并配置好的 Agent。
- **命令边界**：验证命令必须匹配允许列表。
- **真实 Diff**：不只相信 Agent 的自然语言总结。
- **独立验证**：验证步骤和任务执行分开记录。
- **审计记录**：保留 request / task / lineage / audit 状态。
- **人工验收**：最终接受动作绑定到当前证据，而不是简单改一个 JSON 状态。

## 适合谁

如果你想：

- 在 ChatGPT 里规划和监督本地开发任务；
- 继续使用 Codex CLI / Claude Code / OpenCode 作为真正执行者；
- 又不想给远程模型一个无限制 Shell；
- 希望每次修改都有可复查证据；

PatchWarden 就是为这种工作流做的。

## 5 分钟快速上手

### 1. 下载

从 [Latest Release](https://github.com/jiezeng2004-design/PatchWarden/releases/latest) 下载 Windows x64 安装版或便携版。

当前安装包若未代码签名，Windows SmartScreen 可能提示未知发布者。请先用同一 Release 中的 SHA-256 校验文件核对安装包。

PowerShell：

```powershell
Get-FileHash .\PatchWarden-Setup-*-x64.exe -Algorithm SHA256
```

### 2. 准备本地 Agent

至少安装并登录一个：

- Codex CLI
- Claude Code
- OpenCode

从源码或 npm 运行时需要 Node.js 20+；建议同时安装 Git 以生成可靠 Diff。

### 3. 选一个专用工作区

不要把磁盘根目录、用户主目录、桌面、下载目录直接作为 `workspaceRoot`。

建议给 PatchWarden 一个专门的项目目录，只放你明确允许它操作的仓库。

### 4. 检测 Agent

打开 PatchWarden Desktop：

```text
设置 → 本地 Agent 与模型
```

至少一个 Agent 应显示可调用。如果 CLI 尚未登录，先在独立终端完成登录，再回到 PatchWarden 重新检测。

### 5. 确认本地健康状态

在 **开始使用** / **高级控制台** 中确认工作区、Agent 和 Core 服务正常。

到这里，即使还没连接 ChatGPT，PatchWarden 的本地执行边界也已经可以先单独验证。

## 连接 ChatGPT

ChatGPT Web 需要通过当前 OpenAI 支持的安全 MCP Tunnel / custom app 连接方式访问本地 PatchWarden。

典型流程：

1. 准备 `tunnel-client`；
2. 创建名为 `PatchWarden` 的专用 Core Tunnel；
3. 使用具备 **Tunnels Read + Use** 权限的专用 runtime key；
4. 在 PatchWarden 的 **设置 → MCP 与隧道** 中配置并验证；
5. 在 ChatGPT Developer mode 中添加 PatchWarden，Authentication 选 **No Auth**；
6. 保留适合你工作区风险等级的确认策略。

连接时请保持这些边界：

- 这个 runtime key 对应 `CONTROL_PLANE_API_KEY`，不是普通 `OPENAI_API_KEY`；
- `OPENAI_ADMIN_KEY` 可以用于管理 Tunnel，但不应作为长期运行密钥；
- 不要把 runtime key 填进 ChatGPT 的 Authentication 字段；
- Direct 是可选的第二 Tunnel，只有需要 Direct 工具时才创建；
- 如果直接启用本地 HTTP MCP（不经过 stdio Tunnel），必须先配置 `PATCHWARDEN_OWNER_TOKEN`。匿名 `/healthz` 只返回最小状态，详细 health 与 `/mcp` 都要求 owner token。

> Tunnel runtime key 是运行连接所需的本地秘密，不要写进 README、Prompt、截图或 Git 仓库。

连接完成后，先做只读检查：

```text
请调用 PatchWarden：
1. health_check
2. list_agents

只返回服务状态和可调用 Agent，不修改任何文件。
```

## 第一个可审计任务

建议第一次只在可丢弃的 Demo 仓库中测试：

```text
请通过 PatchWarden 执行一次受控任务：
- 只在我指定的 Demo 工作区内工作；
- 使用 invocation_ready=true 的本地 Agent；
- 只修改我明确允许的文件；
- 只运行项目中真实存在且已允许的验证命令；
- 禁止 commit、push、tag、publish、release、deploy；
- 最后返回 Diff、verification、audit 和 lineage 状态。
```

## 不要只看 Agent 说“完成了”

一次可靠的任务结果至少应该能回答：

| 证据 | 你要确认什么 |
| --- | --- |
| `task_id` / `lineage_id` | 这次工作能否唯一追踪 |
| changed files | 是否只改了批准范围 |
| verification | 真实验证命令是否通过 |
| out-of-scope changes | 是否为 `0` |
| audit | 独立审计是否接受 |
| final lineage | 整条工作流是否完整结束 |

PatchWarden 的目标不是让 Agent “更会说自己做对了”，而是让你能检查它到底做了什么。

## 安全边界

PatchWarden 的核心原则：**能力最小化 + 证据优先**。

- 工作区必须显式配置；
- 不把任意本机路径默认暴露给远程模型；
- 验证命令受允许列表限制；
- Direct 工具应保持更严格的只读/独立验证定位；
- 本地 HTTP MCP 的敏感接口要求 owner token；
- 本地 HTTP MCP 的详细 health 与 `/mcp` 都要求 `PATCHWARDEN_OWNER_TOKEN`；
- 日志、截图和诊断不应暴露 API Key / Tunnel ID /账号秘密；
- 最终人工 attestation 绑定当前证据摘要，而不是只相信任务目录里的状态文件；
- 对高风险操作，应继续保留人工确认。

## PatchWarden 不是什么

- 不是通用远程桌面；
- 不是无限制远程 Shell；
- 不替代 Codex / Claude Code / OpenCode；
- 不把所有本地文件自动暴露给 ChatGPT；
- 不把 Agent 的自然语言“测试通过”当成最终证据；
- 不应该用来绕过你原本的本地安全策略。

## 支持的工作流

PatchWarden 当前重点围绕：

```text
Plan in ChatGPT
      ↓
Execute with a local coding agent
      ↓
Verify independently
      ↓
Audit actual changes
      ↓
Accept with evidence
```

它更适合“我已经知道要做什么，现在需要一个受控执行层”，而不是替代完整的需求分析或产品决策流程。

## 常见排障

### Agent 检测到了但不可调用

在独立终端直接运行对应 CLI，先完成登录和基础模型配置，再回到 PatchWarden 重新检测。

### Watcher / Core 状态异常

先通过高级控制台执行正常的启动/重启流程。不要直接强杀未知 PID。

### ChatGPT 无法连接

先确认本地 PatchWarden 健康，再检查 Tunnel 是否连接到正确 profile，以及 ChatGPT 侧是否使用了当前支持的 MCP/custom app 连接方式。

### 验证命令被拒绝

检查它是否真的存在于项目中，并且是否匹配 PatchWarden 的允许命令配置。不要为了让任务通过而临时放宽为任意 Shell。

## 开发与审计理念

PatchWarden 更关心这些问题：

- 执行权属于谁？
- 工作区边界在哪里？
- 结果能不能独立验证？
- 证据是否能追溯到这一次具体任务？
- 人工最终接受是否绑定到当前证据？

如果这些边界比“少一次确认”更重要，这个项目就有价值。

## License

MIT. See [LICENSE](LICENSE).

---

PatchWarden is an independent open-source project and is not affiliated with or endorsed by OpenAI, Anthropic, or OpenCode.
