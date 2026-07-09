# 用 MCP Inspector 测试 PatchWarden

> 适用版本：v1.5.1+
> 说明：本文以 PatchWarden 为例介绍通用的 MCP server 调试方法，
> MCP Inspector 是 modelcontextprotocol 社区维护的独立工具。

## MCP Inspector 是什么

MCP Inspector（`modelcontextprotocol/inspector`）是用于调试 MCP server 的官方工具，
主要能力包括：

- 连接到本地或远程 MCP server。
- 列出 server 暴露的 tools、resources、prompts。
- 交互式调用 tool 并查看结构化响应。
- 检查 server 的 capabilities 声明。

对于 PatchWarden 这类本地 MCP server，Inspector 是验证工具行为、
确认 safe 输出不含敏感内容的最直接手段。

## 前置准备

### 1. 安装 MCP Inspector

```powershell
# 全局安装（Node.js 环境）
npm.cmd install -g @modelcontextprotocol/inspector

# 或直接通过 npx 临时运行
npx @modelcontextprotocol/inspector
```

### 2. 确认 PatchWarden 可启动

在 PatchWarden 仓库下确认构建产物存在：

```powershell
# 在 PatchWarden 仓库根目录
npm.cmd run build
# 确认 dist/ 目录存在 MCP server 入口
```

### 3. 准备测试 workspace

准备一个独立的测试 workspace，避免在生产仓库上直接调试：

```powershell
# 示例：创建测试用 workspace
New-Item -ItemType Directory -Path "D:\test-workspace\demo-repo" -Force
```

并在该 workspace 下放置最小化的 `.patchwarden/config.json` 与 `project-policy.json`。

## 连接 PatchWarden

### 方式一：Inspector GUI

```powershell
# 启动 Inspector
npx @modelcontextprotocol/inspector

# Inspector 默认在 http://localhost:6274 提供 Web UI
```

在 Inspector UI 中：

1. Transport 选择 `STDIO`。
2. Command 填写 PatchWarden server 启动命令（如 `node` ）。
3. Args 填写 PatchWarden dist 入口路径。
4. 点击 Connect。

### 方式二：直接通过 Inspector CLI

```powershell
# Inspector CLI 模式，连接 PatchWarden 并列出 tools
npx @modelcontextprotocol/inspector cli `
  --transport stdio `
  --command node `
  --args "D:\ai_agent\Reasonix\reasonix_program\PatchWarden\dist\index.js"
```

## 调用工具并验证响应

### 列出可用工具

连接成功后，在 Inspector 中调用 `tools/list`，确认 PatchWarden 暴露的工具清单，
例如：

- `list_agents`
- `run_safe_task`
- `export_task_evidence_pack`
- `get_safe_audit`
- 其他 safe-first 工具

### 调用一个 safe 工具

在 Inspector UI 中选择 `run_safe_task`，填入参数：

```json
{
  "agent": "opencode",
  "task": "echo hello",
  "declaredFiles": ["README.md"]
}
```

查看返回的 `safe_result`，确认：

- 返回内容是有界摘要（字节数受 `safeResult.maxBytes` 约束）。
- 不包含完整 stdout / stderr。
- 不包含敏感路径或凭据信息。

### 验证 safe 输出不含敏感内容

PatchWarden 的安全契约要求 safe 输出不得包含 token、cookie、`.env` 内容等。
可用以下方法验证：

```powershell
# 导出 evidence pack 后检查文件内容
$pack = "D:\test-workspace\demo-repo\.patchwarden\evidence-packs"
Select-String -Path "$pack\*\evidence.json" -Pattern "token|secret|password|api_key|cookie" -CaseSensitive:$false
# 期望：无匹配，或仅匹配 redactions.json 中已脱敏的占位符
```

```powershell
# 检查 redactions.json 确认脱敏记录
Get-Content "$pack\*\redactions.json" | ConvertFrom-Json
```

## CLI smoke testing 示例

以下为通用的 MCP server smoke test 方法，PatchWarden 作为示例之一。

### 启动 PatchWarden 并发送 initialize 请求

```powershell
# 通过 Inspector 的 CLI 模式发送 initialize
npx @modelcontextprotocol/inspector cli `
  --transport stdio `
  --command node `
  --args "D:\ai_agent\Reasonix\reasonix_program\PatchWarden\dist\index.js" `
  --method initialize `
  --params '{\"protocolVersion\":\"2024-11-05\",\"capabilities\":{}}'
```

确认响应中包含 PatchWarden 的 serverInfo 与 capabilities。

### 列出工具并保存清单

```powershell
# 将 tools/list 结果保存到文件便于审查
npx @modelcontextprotocol/inspector cli `
  --transport stdio `
  --command node `
  --args "D:\ai_agent\Reasonix\reasonix_program\PatchWarden\dist\index.js" `
  --method tools/list `
  | Out-File -FilePath "D:\test-workspace\tools-list.json" -Encoding utf8
```

### 调用工具并检查响应边界

```powershell
# 调用一个 safe 工具，将响应保存后检查字节数
npx @modelcontextprotocol/inspector cli `
  --transport stdio `
  --command node `
  --args "D:\ai_agent\Reasonix\reasonix_program\PatchWarden\dist\index.js" `
  --method tools/call `
  --params '{\"name\":\"get_safe_audit\",\"arguments\":{}}' `
  | Out-File -FilePath "D:\test-workspace\safe-audit.json" -Encoding utf8

# 检查响应字节数是否在有界范围内
(Get-Item "D:\test-workspace\safe-audit.json").Length
```

## 常见验证清单

测试 PatchWarden 时建议覆盖以下项：

- [ ] `tools/list` 返回的均为 safe-first 工具。
- [ ] `run_safe_task` 返回的 `safe_result` 字节数在 `maxBytes` 范围内。
- [ ] 调用涉及敏感文件名的工具时被阻断（如尝试读取 `.env`）。
- [ ] 越出 workspace 的路径请求被拒绝。
- [ ] 未在 `allowedCommands` 中的命令被拒绝执行。
- [ ] `export_task_evidence_pack` 产出 8 个有界文件。
- [ ] evidence 文件中不含 token、cookie、secret 明文。

## 注意事项

- Inspector 是调试工具，不应作为生产客户端长期运行。
- 调试时使用独立测试 workspace，不要在生产仓库上执行破坏性任务。
- 若 Inspector 报告连接失败，先确认 PatchWarden 的 dist 产物已构建。
- safe 输出的有界范围由 `.patchwarden/config.json` 中的 `safeResult.maxBytes` 控制，
  调试时可适当调小以验证边界行为。

## 相关文档

- `docs/threat-model.md`：PatchWarden 安全契约与敏感文件清单。
- `docs/evidence-pack-schema.md`：Evidence Pack v2 文件结构。
- `docs/dashboard-overview.md`：Control Center 与 safe-first 概念。
