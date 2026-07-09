# OpenCode worker 集成模式

> 适用版本：v1.5.1+
> 说明：本文描述的是 PatchWarden 将 OpenCode 作为 worker agent 的集成模式建议。
> OpenCode 是独立的本地编程 Agent 项目，本文不声称任何官方集成关系。

## OpenCode 是什么

OpenCode 是面向本地开发的编程 Agent，主要能力包括：

- 在本地仓库中读写文件、执行命令、运行测试。
- 接收自然语言任务描述并产出代码改动。
- 支持多种模型后端。

OpenCode 本身是通用 Agent，默认不具备 PatchWarden 的安全边界。
本文描述如何让 PatchWarden 作为外部监督层，OpenCode 作为受约束的 worker。

## External Supervisor Pattern

PatchWarden 与 OpenCode 的集成采用 **external supervisor pattern**：

```
MCP 客户端 → PatchWarden（supervisor）→ OpenCode（worker）→ workspace
                ↑ 安全边界在此
```

- **PatchWarden 作为 supervisor**：接收 MCP 客户端的任务请求，
  负责工作区隔离、命令允许列表、范围违规检测、证据收集。
- **OpenCode 作为 worker**：在 PatchWarden 允许的范围内执行具体编码任务。
- **安全边界在 PatchWarden 侧**：OpenCode 的所有文件改动与命令执行
  必须经过 PatchWarden 的策略校验。

关键点：OpenCode 不直接暴露给 MCP 客户端，而是由 PatchWarden 调度。
这避免了 OpenCode 在无监督下执行越权操作。

## 配置示例

### 1. 在 PatchWarden 中注册 OpenCode agent

在 `.patchwarden/config.json` 中注册 OpenCode：

```json
{
  "workspaceRoot": "D:\\repos\\my-project",
  "agents": [
    {
      "name": "opencode",
      "type": "local-worker",
      "command": "opencode",
      "args": ["--no-interactive"],
      "workspace": "D:\\repos\\my-project"
    }
  ],
  "evidencePackVersion": 2,
  "safeResult": { "maxBytes": 4096 }
}
```

### 2. 配置 project-policy.json 约束 OpenCode 的操作范围

```json
{
  "allowedPaths": ["src/**", "test/**", "docs/**"],
  "allowedCommands": [
    "npm.cmd test",
    "npm.cmd run build",
    "git status",
    "git diff",
    "opencode --no-interactive"
  ],
  "blockedFiles": [".env", ".env.*", "id_rsa", "*.key", "*.pem", "cookies.db"],
  "scopeRules": {
    "enforceDeclaredFiles": true,
    "blockOutOfWorkspace": true
  }
}
```

### 3. OpenCode 在 workspace 内执行

OpenCode 进程由 PatchWarden 启动并监督：

```powershell
# PatchWarden 通过 MCP 工具 run_safe_task 调度 OpenCode
# MCP 客户端传入任务描述与声明的文件范围
# PatchWarden 在执行前校验范围，执行中监督，执行后收集证据
```

## 工作流示例

### 任务：让 OpenCode 实现一个新模块

1. **MCP 客户端发起任务**：

```json
{
  "agent": "opencode",
  "task": "add input validation to src/handlers/user.ts",
  "declaredFiles": ["src/handlers/user.ts", "test/handlers/user.test.ts"]
}
```

2. **PatchWarden 校验范围**：

- `src/handlers/user.ts` 与 `test/handlers/user.test.ts` 在 `allowedPaths` 内。
- `opencode` 命令在 `allowedCommands` 内。
- 无 `blockedFiles` 命中。

3. **PatchWarden 启动 OpenCode worker**：

- OpenCode 在 `workspaceRoot` 下执行。
- OpenCode 的文件改动受 PatchWarden 监督。
- 若 OpenCode 尝试修改未声明文件，PatchWarden 触发范围违规检测并阻断。

4. **任务完成后导出证据**：

```powershell
# 产物位于 .patchwarden/evidence-packs/<lineage_id>/
# 包含 evidence.json / EVIDENCE.md / risk.json / verify.json 等 8 个文件
```

## 安全边界

PatchWarden 对 OpenCode worker 的约束包括：

| 维度 | 约束 |
| --- | --- |
| 文件读写 | 必须在 `allowedPaths` 内，命中 `blockedFiles` 即阻断 |
| 命令执行 | 必须在 `allowedCommands` 中（精确匹配） |
| 工作区 | OpenCode 进程的 cwd 限定在 `workspaceRoot` 下 |
| 越界改动 | `enforceDeclaredFiles` 为 true 时，未声明文件改动被阻断 |
| 敏感资源 | `.env`、SSH key、cookie、token 等一律不可访问 |
| 进程监督 | OpenCode 进程由 PatchWarden launcher 拥有，可被监督与终止 |

## 注意事项

- OpenCode 必须以非交互模式运行（如 `--no-interactive`），避免阻塞 PatchWarden。
- OpenCode 的模型后端配置（API key 等）属于 OpenCode 自身配置，
  PatchWarden 不读取也不持久化这些凭据。
- 若 OpenCode 任务需要执行 `allowedCommands` 之外的命令，
  应先更新 `project-policy.json` 再执行，不应临时放宽约束。
- OpenCode worker 的 stdout / stderr 由 PatchWarden 收集为有界摘要，
  完整日志不直接暴露给 MCP 客户端。
- 本集成模式不修改 OpenCode 的任何行为，仅在调度与监督层面配合。

## 相关文档

- `docs/threat-model.md`：PatchWarden 安全契约与进程监督边界。
- `docs/evidence-pack-schema.md`：Evidence Pack v2 文件结构。
- `docs/why-patchwarden.md`：external supervisor pattern 的定位。
- `docs/openhands-worker.md`：类似的 worker 集成模式（OpenHands）。
