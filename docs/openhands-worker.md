# OpenHands worker 集成模式

> 适用版本：v1.5.1+
> 说明：本文描述的是 PatchWarden 将 OpenHands 作为 worker agent 的集成模式建议。
> OpenHands 是独立的 AI 软件开发 Agent 项目，本文不声称任何官方集成关系。

## OpenHands 是什么

OpenHands 是面向软件开发的 AI Agent，主要能力包括：

- 在本地或容器化环境中编写、修改、调试代码。
- 执行测试、运行构建、操作文件系统。
- 接收自然语言任务并自主规划实现步骤。
- 支持多种模型后端与运行时环境。

OpenHands 默认以较自主的方式运行，本身不具备 PatchWarden 的安全边界。
本文描述如何让 PatchWarden 作为外部监督层，OpenHands 作为受约束的 worker。

## External Supervisor Pattern

PatchWarden 与 OpenHands 的集成采用 **external supervisor pattern**：

```
MCP 客户端 → PatchWarden（supervisor）→ OpenHands（worker）→ workspace
                ↑ 安全边界在此
```

- **PatchWarden 作为 supervisor**：接收 MCP 客户端的任务请求，
  负责工作区隔离、命令允许列表、范围违规检测、证据收集。
- **OpenHands 作为 worker**：在 PatchWarden 允许的范围内执行软件开发任务。
- **安全边界在 PatchWarden 侧**：OpenHands 的所有文件改动与命令执行
  必须经过 PatchWarden 的策略校验。

关键点：OpenHands 不直接暴露给 MCP 客户端，而是由 PatchWarden 调度。
这避免了 OpenHands 在无监督下执行越权操作或访问敏感资源。

## 配置示例

### 1. 在 PatchWarden 中注册 OpenHands agent

在 `.patchwarden/config.json` 中注册 OpenHands：

```json
{
  "workspaceRoot": "D:\\repos\\my-project",
  "agents": [
    {
      "name": "openhands",
      "type": "local-worker",
      "command": "openhands",
      "args": ["--headless", "--task"],
      "workspace": "D:\\repos\\my-project"
    }
  ],
  "evidencePackVersion": 2,
  "safeResult": { "maxBytes": 4096 }
}
```

### 2. 配置 project-policy.json 约束 OpenHands 的操作范围

```json
{
  "allowedPaths": ["src/**", "test/**", "docs/**"],
  "allowedCommands": [
    "npm.cmd test",
    "npm.cmd run build",
    "git status",
    "git diff",
    "openhands --headless"
  ],
  "blockedFiles": [".env", ".env.*", "id_rsa", "*.key", "*.pem", "cookies.db"],
  "scopeRules": {
    "enforceDeclaredFiles": true,
    "blockOutOfWorkspace": true
  }
}
```

### 3. OpenHands 在 workspace 内执行

OpenHands 进程由 PatchWarden 启动并监督：

```powershell
# PatchWarden 通过 MCP 工具 run_safe_task 调度 OpenHands
# MCP 客户端传入任务描述与声明的文件范围
# PatchWarden 在执行前校验范围，执行中监督，执行后收集证据
```

## 工作流示例

### 任务：让 OpenHands 修复一个 bug

1. **MCP 客户端发起任务**：

```json
{
  "agent": "openhands",
  "task": "fix null pointer in src/services/auth.ts when token is missing",
  "declaredFiles": ["src/services/auth.ts", "test/services/auth.test.ts"]
}
```

2. **PatchWarden 校验范围**：

- `src/services/auth.ts` 与 `test/services/auth.test.ts` 在 `allowedPaths` 内。
- `openhands` 命令在 `allowedCommands` 内。
- 无 `blockedFiles` 命中。

3. **PatchWarden 启动 OpenHands worker**：

- OpenHands 在 `workspaceRoot` 下以 headless 模式执行。
- OpenHands 的文件改动受 PatchWarden 监督。
- 若 OpenHands 尝试修改未声明文件，PatchWarden 触发范围违规检测并阻断。
- 若 OpenHands 尝试读取 `.env` 或凭据文件，PatchWarden 立即阻断。

4. **任务完成后导出证据**：

```powershell
# 产物位于 .patchwarden/evidence-packs/<lineage_id>/
# 包含 evidence.json / EVIDENCE.md / risk.json / verify.json 等 8 个文件
```

## 安全边界

PatchWarden 对 OpenHands worker 的约束包括：

| 维度 | 约束 |
| --- | --- |
| 文件读写 | 必须在 `allowedPaths` 内，命中 `blockedFiles` 即阻断 |
| 命令执行 | 必须在 `allowedCommands` 中（精确匹配） |
| 工作区 | OpenHands 进程的 cwd 限定在 `workspaceRoot` 下 |
| 越界改动 | `enforceDeclaredFiles` 为 true 时，未声明文件改动被阻断 |
| 敏感资源 | `.env`、SSH key、cookie、token 等一律不可访问 |
| 进程监督 | OpenHands 进程由 PatchWarden launcher 拥有，可被监督与终止 |
| 网络访问 | 取决于 OpenHands 运行时配置，PatchWarden 不放宽命令允许列表 |

## 容器化运行注意事项

若 OpenHands 运行在容器中，需额外注意：

- PatchWarden 监督的是宿主机上的 OpenHands 进程，
  容器内的文件系统改动应通过挂载卷映射回 `workspaceRoot`。
- `project-policy.json` 的 `allowedPaths` 应对应宿主机路径，
  而非容器内路径。
- 容器内的命令执行若需被 PatchWarden 监督，
  应通过 OpenHands 的 headless 接口走 PatchWarden 调度，
  而非绕过 PatchWarden 直接在容器内执行。

## 注意事项

- OpenHands 必须以 headless / 非交互模式运行，避免阻塞 PatchWarden。
- OpenHands 的模型后端配置（API key 等）属于 OpenHands 自身配置，
  PatchWarden 不读取也不持久化这些凭据。
- 若 OpenHands 任务需要执行 `allowedCommands` 之外的命令，
  应先更新 `project-policy.json` 再执行，不应临时放宽约束。
- OpenHands worker 的 stdout / stderr 由 PatchWarden 收集为有界摘要，
  完整日志不直接暴露给 MCP 客户端。
- 本集成模式不修改 OpenHands 的任何行为，仅在调度与监督层面配合。

## 与 OpenCode worker 的差异

OpenHands 与 OpenCode 的集成模式在结构上一致（均采用 external supervisor pattern），
主要差异在于：

| 维度 | OpenCode | OpenHands |
| --- | --- | --- |
| 定位 | 本地编程 Agent | AI 软件开发 Agent |
| 运行模式 | 通常直接在宿主机 | 支持 headless 与容器化 |
| 自主性 | 中等，偏交互式 | 较高，偏自主规划 |
| 适用任务 | 中小规模代码改动 | 较复杂的软件开发任务 |

选择哪个 worker 取决于任务复杂度与运行时偏好，
PatchWarden 的安全边界对两者一视同仁。

## 相关文档

- `docs/threat-model.md`：PatchWarden 安全契约与进程监督边界。
- `docs/evidence-pack-schema.md`：Evidence Pack v2 文件结构。
- `docs/why-patchwarden.md`：external supervisor pattern 的定位。
- `docs/opencode-worker.md`：类似的 worker 集成模式（OpenCode）。
