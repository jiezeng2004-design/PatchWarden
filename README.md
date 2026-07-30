# PatchWarden

<p align="right">
  <a href="./README.en.md">English</a> · <strong>简体中文</strong>
</p>

[![最新版本](https://img.shields.io/github/v/release/jiezeng2004-design/PatchWarden?label=release)](https://github.com/jiezeng2004-design/PatchWarden/releases/latest)
[![Node.js >= 20](https://img.shields.io/badge/Node.js-%3E%3D20-339933.svg)](https://nodejs.org/)
[![Windows x64](https://img.shields.io/badge/Windows-x64-0078D4.svg)](https://github.com/jiezeng2004-design/PatchWarden/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**把 ChatGPT 中已经确认的方案交给本地 Agent，在限定工作区内执行，再拿回验证与审计证据。**

PatchWarden 将 ChatGPT 与本地 Codex CLI、Claude Code 或 OpenCode 等编程 Agent 连接起来。它把 Agent 限制在专用工作区内，只运行已配置的验证命令，并记录实际改动。它是一条受控任务通道，不是通用远程 Shell。

[下载最新 Windows 版本](https://github.com/jiezeng2004-design/PatchWarden/releases/latest) · [5 分钟上手](#5-分钟快速上手) · [连接 ChatGPT](#通过-secure-mcp-tunnel-连接-chatgpt) · [常见问题](#常见问题与排障)

<p align="center">
  <img src="https://raw.githubusercontent.com/jiezeng2004-design/PatchWarden/main/docs/assets/PatchWarden_Demo_Highlight.gif" width="800" alt="PatchWarden 53 秒工作流演示：在 ChatGPT 中规划，由本地 Agent 执行，再验证和审计结果">
</p>

<p align="center"><sub>53 秒真实工作流演示。API Key、Tunnel ID 和账号标识等敏感信息均已遮挡。</sub></p>

> [!NOTE]
> 本教程已在 **PatchWarden v1.6.7** 上验证，核验日期为 2026-07-28。下载时请始终使用稳定的 [Latest Release](https://github.com/jiezeng2004-design/PatchWarden/releases/latest) 链接。

## 你能得到什么

- **明确的执行边界：** 任务只能在配置的 `workspaceRoot` 内运行。
- **受控的执行过程：** Agent 来自本地配置，验证命令必须匹配 `allowedTestCommands`。
- **不只是一段总结：** 任务状态、改动文件、验证、审计和 lineage 都可以检查。

## 开始前准备

完成第一次本地健康检查需要：

- Windows 10 或 11 x64。
- 一个只包含允许 PatchWarden 访问项目的专用目录。
- 至少一个已经安装并登录的本地 Agent：Codex CLI、Claude Code 或 OpenCode。
- 从源码或 npm 运行时需要 Node.js 20 或更高版本；建议安装 Git，以生成可靠 Diff。

后续连接 ChatGPT 还需要：

- 可以在 Developer mode 中添加自定义 Apps/Plugins 的 ChatGPT 账号。
- OpenAI Organization 中的 **Tunnels Read + Use** 权限。
- `tunnel-client.exe`、一个 Core Tunnel 和专用 Tunnel runtime API key。
- 如果决定启用 PatchWarden Direct，还需要第二个可选 Tunnel。

## 5 分钟快速上手

这条路径先确认 PatchWarden、工作区和本地 Agent 可以正常工作。Tunnel 与 Direct 留到下一节配置，避免第一次打开软件就被高级选项阻塞。

### 1. 下载并校验

打开 [Releases](https://github.com/jiezeng2004-design/PatchWarden/releases/latest)，下载当前 Release 页面列出的 Windows x64 文件：

- 安装版：`PatchWarden-Setup-<release-version>-x64.exe`。
- 免安装版：`PatchWarden-Portable-<release-version>-x64.zip`。
- 校验文件：`PatchWarden-Desktop-SHA256SUMS.txt`。

在只包含当前安装包的文件夹中运行以下 PowerShell 命令，并与同一 Release 的校验文件比较 SHA-256：

```powershell
Get-FileHash .\PatchWarden-Setup-*-x64.exe -Algorithm SHA256
```

> [!WARNING]
> 当前 Windows 安装包尚未代码签名，Microsoft Defender SmartScreen 可能显示“未知发布者”。继续安装前，请先与同一 GitHub Release 中的校验文件比对 SHA-256。

### 2. 检查本地工具

```powershell
node -v
npm.cmd -v
git --version
where.exe codex
where.exe opencode
```

只需要一个可用的编程 Agent。如果 `where.exe codex` 只返回 WindowsApps 下的桌面应用程序，它不一定是 PatchWarden 可以调用的 Codex CLI。

### 3. 选择安全工作区

打开 PatchWarden Desktop。只做最快本地检查时选择 **本地 MCP**；如果准备直接继续下一节，则选择 **ChatGPT Tunnel**。

选择一个专用项目目录。不要选择磁盘根目录、用户主目录、桌面、下载或文档目录。

### 4. 检测 Agent

打开 **设置 → 本地 Agent 与模型**。至少一个 Agent 必须显示可用，模型保持 **跟随 Agent 默认** 即可。

如果已经检测到 Agent，但仍不可调用，请在独立 PowerShell 窗口直接运行对应 CLI，完成登录或模型配置，再回到 PatchWarden 点击 **重新检测**。

### 5. 确认健康状态

打开 **开始使用**。**工作区与 Agent**、**Core 服务** 应显示就绪；如果没有就绪，进入 **高级控制台**，点击 **全部启动**。

到这里，PatchWarden 已经拥有一个专用工作区和可调用的本地 Agent。只有需要从 ChatGPT 操作它时，才继续下一节。

## 通过 Secure MCP Tunnel 连接 ChatGPT

### 1. 创建 runtime key 与 Tunnel

1. 打开 [OpenAI Organization API keys](https://platform.openai.com/settings/organization/api-keys)，为 PatchWarden 创建专用 Key。创建者需要 **Tunnels Read + Use** 权限。
2. 打开 [OpenAI Tunnels](https://platform.openai.com/settings/organization/tunnels)，创建名为 `PatchWarden` 的 Core Tunnel。
3. 从该页面下载平台支持的 `tunnel-client`，也可以使用[最新公开 tunnel-client Release](https://github.com/openai/tunnel-client/releases/latest)。
4. 只有需要可选 Direct 工具配置时，才创建第二个名为 `PatchWarden Direct` 的 Tunnel。

> [!IMPORTANT]
> 这个专用 runtime key 对应 `CONTROL_PLANE_API_KEY`，不是普通 `OPENAI_API_KEY`。`OPENAI_ADMIN_KEY` 可以用于管理 Tunnel，但不应作为长期运行密钥。不要把任何 Key 写进 README、提示词、截图或 Git 仓库。

### 2. 配置 PatchWarden

打开 **设置 → MCP 与隧道**：

1. 点击 **检测** 或 **选择**，定位 `tunnel-client.exe`。
2. 不需要代理时选择不使用代理；使用本地代理时，只填写不含账号密码的本地 URL。
3. 在 **Core Profile** 中填写 Core Tunnel ID 和专用 runtime key。
4. 点击 **配置并验证 Core**。
5. 可选：启用 **Direct Profile**，填写单独的 Direct Tunnel ID 与 runtime key，然后验证 Direct。

进入 **高级控制台**，点击 **全部启动**。Core、Watcher 与 Tunnel 应变为健康或可用；只有启用 Direct 时，才要求 Direct 健康。

### 3. 添加 ChatGPT App/Plugin

ChatGPT 中这一区域可能显示为 **Apps**、**Plugins** 或旧名称 **Connectors**。

1. 打开 [ChatGPT 设置](https://chatgpt.com/#settings/Connectors)。
2. 进入 **Developer mode** 并开启。只有在运行自己的 PatchWarden、了解工作区和命令边界时才继续。
3. 按下表创建 Core 条目。
4. 可选：把 Direct 创建成单独条目，不要把 Core 与 Direct 合并为一个名称。

| 条目 | 名称 | 连接方式 | Tunnel | Authentication |
| --- | --- | --- | --- | --- |
| Core | `PatchWarden` | Tunnel | 选择 Core Tunnel | No Auth |
| 可选 Direct | `PatchWarden Direct` | Tunnel | 选择 Direct Tunnel | No Auth |

`No Auth` 表示 MCP Server 没有再增加一层 OAuth/Bearer 认证。Tunnel runtime key 保存在本地 PatchWarden/tunnel-client 中，不能填入 ChatGPT 的 Authentication 字段。

建议保留逐次确认，特别是 Direct 工具和文件修改操作。

### 4. 第一次连接检查

新建一个 ChatGPT 会话。如果只配置了 Core，请删除提示词中的 `@PatchWarden Direct` 和 Direct 字段。

```text
@PatchWarden @PatchWarden Direct

请依次调用：
1. health_check
2. list_agents

返回 server_version、watcher.status、Core/Direct 的 tool_profile 与
tool_count，并列出 invocation_ready=true 的 Agent。
不要修改任何文件。
```

满足以下条件即可认为链路就绪：

- `watcher.status` 为 healthy。
- `server_version` 与实际安装版本一致。
- 返回 `catalog_consistent` 时，其值为 true。
- 至少一个 Agent 的 `invocation_ready=true`。
- 不要求固定 `tool_count`，应与当前版本和所选 profile 对照。

## 运行第一个可审计 Demo

请使用可随时丢弃的 Demo 仓库，保留逐次确认，并明确允许操作的目录和文件。

```text
@PatchWarden @PatchWarden Direct

请在我的 Demo 仓库中执行一次可审计任务：
- 先调用 health_check 和 list_agents。
- 只在我指定的 Demo 目录内工作。
- 使用 invocation_ready=true 的本地 Agent。
- 只修改我明确允许的文件。
- 检查 package.json，只运行其中真实存在的验证脚本；
  如果没有合适脚本，请停止并说明，不要编造命令。
- 禁止 commit、push、tag、publish、release 或部署。
- 返回 request_id、task_id、lineage_id、Diff 摘要、verification、
  audit 与最终 lineage 状态。
- PatchWarden Direct 只用于只读独立验证。
```

如果没有启用 Direct，请删除相关要求。Core 仍然可以完成受控任务流程。

## 验证执行结果

不要只接受 Agent 的自然语言总结，还应检查任务与审计证据：

| 字段 | 含义 | 预期结果 |
| --- | --- | --- |
| `task_id` / `lineage_id` | 唯一任务与工作流记录 | 存在 |
| `done_by_agent` | Agent 进程结束，不代表审计通过 | 仅作信息参考 |
| `verification` | 独立运行已配置验证命令 | passed |
| `changed_files_total` | 实际修改文件数 | 与批准范围一致 |
| `out_of_scope_changes_total` | 批准范围外的改动 | `0` |
| `audit` | 机器独立审计结论 | `ACCEPTED` |
| 本地 attestation | 人工核对当前证据后的权威验收 | 已签发且证据摘要未变化 |
| 最终 lineage 状态 | 完整工作流结果 | `accepted` |

只读冒烟测试中，`changed_files_total` 也应为 `0`。

对新任务，`audit_task` 通过后仍需人在本机交互式终端确认。检查 `audit.json`、`changed-files.json`、验证结果和 Diff 后运行：

```powershell
patchwarden-attest <task_id> --accept
```

该命令要求真实 TTY，并把决定绑定到工作区外的本地 ledger 与当前证据摘要；仅修改任务目录中的 `acceptance.json` 或 `status.json` 不会产生权威验收。

如果直接启用本地 HTTP MCP 传输（不经过 stdio Tunnel），必须先在可信父进程环境中配置 `PATCHWARDEN_OWNER_TOKEN`。匿名 `/healthz` 只返回最小状态，详细 health 与 `/mcp` 都要求 owner token。

## 常见问题与排障

### Watcher heartbeat is stale

在高级控制台点击 **全部启动**。仍然 stale 时点击 **全部重启**，等待状态恢复 healthy。不要强制结束未知 PID。

### 更新后 ChatGPT 仍显示旧工具

分别进入 `PatchWarden` 与 `PatchWarden Direct` 详情页点击刷新，然后新建会话。调用 `health_check`，对比 `server_version`、`tool_profile`、`tool_count`、`catalog_consistent` 和 `tool_manifest_sha256`。

### ChatGPT 中看不到 Tunnel

- 确认 Tunnel 创建在正确的 Organization/Workspace 范围。
- 确认 runtime key 创建者具有 **Tunnels Read + Use**。
- 确认 `tunnel-client` 与 PatchWarden 服务仍在运行且状态健康。
- 新 Tunnel 可能需要短暂传播时间，请稍后刷新插件创建页面。

### Agent 显示可用，但任务失败

在终端直接运行对应 Agent CLI，确认登录和模型配置。在 PatchWarden 中点击 **重新检测**，再查看 `failure_reason`、`provider_error_reference` 和运行日志。

### ChatGPT 创建插件时要求 Authentication

本文的 Tunnel 配置选择 **No Auth**。不要把 `CONTROL_PLANE_API_KEY` 填到插件 Authentication 字段。

## 安全规则

- 永远不要公开 API Key、Token、Cookie、`.env`、SSH Key 或 Authorization Header。
- 保持 `workspaceRoot` 足够窄，不要指向磁盘根目录或个人文件集合目录。
- 公开截图时，按传播场景遮挡 Tunnel ID、App ID、Version ID、用户名、私有仓库名和组织标识。
- 第一次修改任务使用 Demo 仓库。
- 明确允许文件、真实验证命令与禁止操作。
- 第一次演示不要自动 commit、push、tag、publish、release 或部署。
- 把 Direct 视为高级能力，并保留人工确认。

## 从源码运行（开发者）

桌面 Release 是新手最短路径。需要开发 PatchWarden 时，可使用仓库当前验证过的 Windows PowerShell 流程：

```powershell
git clone https://github.com/jiezeng2004-design/PatchWarden.git
cd .\PatchWarden
npm.cmd ci
npm.cmd run build
Copy-Item .\examples\config.example.json .\patchwarden.config.json
```

编辑 `patchwarden.config.json`，至少设置 `workspaceRoot`、`agents` 和 `allowedTestCommands`。本地配置不要提交到 Git。

可用 `generatedPaths`（兼容 `generated_paths`）补充带生成物特征的 glob；仓库专属规则使用 `repoGeneratedPaths`。PatchWarden 仍会把已跟踪或未忽略的生成物列为待复核变化，不会用该配置隐藏异常修改。

网页项目可在本地配置中显式启用 `runtimeValidation`（兼容 `runtime_validation`）。`startCommand` 必须与 `allowedTestCommands` 中的命令精确匹配，`baseUrl` 只允许字面量 loopback HTTP 地址（`127.0.0.1` 或 `[::1]`）。静态验证通过后，PatchWarden 使用系统 Edge/Chrome 检查配置的路由与视口，记录控制台错误、破图、横向溢出和截图，并在结束时仅关闭本次验证拥有的服务进程树。若端口已被占用会拒绝附着，避免误验收或停止外部服务。

Direct 现在提供受限的文件创建、目录创建、移动和删除操作。每次操作仍会经过工作区边界、敏感文件名、链接/重解析点和确认策略检查；批量补丁在任一子补丁失败时保持原子性，并返回精确的补丁索引与原因。

任务执行会先运行项目预检，并把失败归类为策略、范围、确认、Agent、验证、连接器或 Watcher 故障。`agentPriority`、`maxRetriesPerAgent`、`fallbackOn` 和 `doNotFallbackOn` 可控制有界重试与 Agent 回退；回退不会绕过策略、范围或确认，连接器/Watcher 故障也不会消耗 Agent 重试次数。连接器重试请复用稳定的 `request_id`，相同参数幂等复用，参数变化会拒绝复用。

仓库可以通过 `.patchwarden/project-facts.json` 或根目录 `PROJECT_FACTS.json` 声明已核实的联系方式、域名、量化/采用声明、许可证与禁止声明。审计还会按识别到的 Next.js、Node.js、Python、Rust 或 Electron 项目运行框架级检查，真实解析 SVG/XML，并区分文档中的可执行命令与叙述示例。结果汇总到 `acceptance-report.json`；没有完成所需运行态验证时会明确标记 `manual_review_required=true`，不会自动进入可供用户验收状态。

任务面板和高级控制台分别展示 task、Agent、Watcher 与 connector 状态、心跳年龄、当前命令、源码/生成物/范围计数、验证进度、Agent attempt 与路由/切换原因，避免把“Agent 已结束”误报为“任务已验收”。

```powershell
$env:PATCHWARDEN_CONFIG = (Resolve-Path .\patchwarden.config.json)
npm.cmd run doctor
npm.cmd run watch
```

使用 MCP Server 时，需要保持 Watcher 窗口运行。

## 官方链接

- [PatchWarden GitHub 仓库](https://github.com/jiezeng2004-design/PatchWarden)
- [PatchWarden 最新 Release](https://github.com/jiezeng2004-design/PatchWarden/releases/latest)
- [PatchWarden 教程网站](https://patchwarden-showcase-redesign.yistart.chatgpt.site/)
- [OpenAI Tunnels](https://platform.openai.com/settings/organization/tunnels)
- [OpenAI Organization API keys](https://platform.openai.com/settings/organization/api-keys)
- [tunnel-client 最新公开 Release](https://github.com/openai/tunnel-client/releases/latest)
- [tunnel-client 官方最终用户指南](https://github.com/openai/tunnel-client/blob/master/docs/end-user-guide.md)
- [ChatGPT Apps/Plugins 设置](https://chatgpt.com/#settings/Connectors)
- [安全策略](SECURITY.md) · [更新日志](CHANGELOG.md) · [参与贡献](CONTRIBUTING.md)

升级 PatchWarden 后，请刷新两个 ChatGPT 条目，新建会话，并在执行修改任务前再次调用 `health_check`。
