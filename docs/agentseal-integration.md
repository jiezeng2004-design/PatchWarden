# AgentSeal 集成模式

> 本文基于 v1.5.1 源码编写；安装时请使用已验证发布的 <published-version>。
> 说明：本文描述的是 PatchWarden 与 AgentSeal 的集成模式建议，**不是** AgentSeal 的官方功能。
> AgentSeal 是独立的 agent 安全检测项目，本文不声称任何官方集成关系。

## AgentSeal 是什么

AgentSeal 是面向 AI 编程 Agent 的安全检测工具，主要职能包括：

- 识别项目级安全策略（哪些文件可改、哪些命令可执行、哪些路径禁止访问）。
- 对 Agent 的执行行为进行策略比对与违规告警。
- 为 Agent 工作流提供可配置的策略层。

AgentSeal 侧重于“策略声明与检测”，本身不强制执行；
PatchWarden 侧重于“强制执行与证据收集”。两者互补。

## 集成定位

```
AgentSeal:   声明策略 → 检测违规 → 告警
                            ↓ 策略对齐
PatchWarden: 接收任务 → 强制执行 → 证据收集
```

- AgentSeal 负责**策略侧**：识别并校验项目安全策略。
- PatchWarden 负责**执行侧**：在执行任务时强制遵守策略，并产出可审计证据。

## 配置文件关系

PatchWarden 与 AgentSeal 共享两个关键配置文件，但职责不同：

| 文件 | AgentSeal 角色 | PatchWarden 角色 |
| --- | --- | --- |
| `.patchwarden/config.json` | 读取并识别 PatchWarden 运行配置 | 运行时核心配置入口 |
| `project-policy.json` | 校验项目策略合规性 | 执行时强制遵守的 allowed paths / commands |

### `.patchwarden/config.json`

PatchWarden 的运行配置，典型字段包括：

```json
{
  "workspaceRoot": "D:\\repos\\my-project",
  "agents": ["opencode", "codex"],
  "evidencePackVersion": 2,
  "safeResult": { "maxBytes": 4096 }
}
```

AgentSeal 可读取此文件以了解 PatchWarden 的 workspace 边界与 agent 注册情况，
用于检测配置是否与项目策略一致。

### `project-policy.json`

项目级安全策略，声明允许的路径与命令：

```json
{
  "allowedPaths": ["src/**", "test/**"],
  "allowedCommands": ["npm.cmd test", "npm.cmd run build", "git status"],
  "blockedFiles": [".env", ".env.*", "id_rsa", "cookies.db"],
  "scopeRules": { "enforceDeclaredFiles": true }
}
```

- AgentSeal 将此文件作为策略基准进行检测。
- PatchWarden 将此文件作为执行时的强制约束。
- 两者读取同一份文件，保证“检测基准”与“执行约束”一致。

## 集成流程示例

### 1. 编写项目安全策略

在仓库根目录放置 `project-policy.json`（与 `.patchwarden/config.json` 配合）：

```json
{
  "allowedPaths": ["src/**", "docs/**"],
  "allowedCommands": ["npm.cmd run build", "npm.cmd test"],
  "blockedFiles": [".env", "*.key", "*.pem"],
  "scopeRules": { "enforceDeclaredFiles": true }
}
```

### 2. AgentSeal 识别并校验策略

```powershell
# AgentSeal 扫描项目，识别 .patchwarden/config.json 与 project-policy.json
# 输出策略合规报告
agentseal scan --project D:\repos\my-project
```

AgentSeal 输出策略快照，作为后续违规比对的基准。

### 3. PatchWarden 执行任务时强制遵守

当 MCP 客户端通过 PatchWarden 执行任务时：

```powershell
# PatchWarden 启动时加载 project-policy.json
# 执行任务时对每条命令与文件改动进行策略校验
```

PatchWarden 的强制行为：

- 命令必须在 `allowedCommands` 列表中（精确匹配）。
- 文件改动必须在 `allowedPaths` 范围内。
- 命中 `blockedFiles` 的访问被立即阻断。
- `enforceDeclaredFiles` 为 true 时，未声明文件的改动触发范围违规检测。

### 4. 证据对齐与回溯

任务完成后，PatchWarden 导出 Evidence Pack v2：

```powershell
# 产物位于 .patchwarden/evidence-packs/<lineage_id>/
```

其中：

- `verify.json` 记录每轮迭代的策略校验结果，可与 AgentSeal 的策略快照对齐。
- `risk.json` 聚合执行中识别的风险项。
- `redactions.json` 记录已脱敏内容，证明未泄露敏感信息。

AgentSeal 可读取这些文件，作为策略执行情况的回溯证据。

## 安全边界

- PatchWarden 不依赖 AgentSeal 运行。即使 AgentSeal 未启动，
  PatchWarden 仍会按 `project-policy.json` 强制执行策略。
- AgentSeal 不修改 PatchWarden 的运行时行为，仅提供策略检测与告警。
- 两者共享 `project-policy.json` 作为单一策略真源，避免策略漂移。
- 若 AgentSeal 检测到策略与 PatchWarden 配置不一致，
  应由人工修正配置，不应自动放宽 PatchWarden 的约束。

## 注意事项

- 本集成模式不修改 AgentSeal 的任何行为，仅在配置与流程上配合。
- `project-policy.json` 的字段定义以 PatchWarden 实际加载逻辑为准，
  AgentSeal 侧应按相同 schema 解析。
- 如策略允许读取 `.env` 等敏感文件，PatchWarden 仍会按安全契约阻断，
  此时需要重新设计策略以避免触碰敏感资源。

## 相关文档

- `docs/threat-model.md`：PatchWarden 安全契约与敏感文件清单。
- `docs/evidence-pack-schema.md`：Evidence Pack v2 文件结构。
- `docs/why-patchwarden.md`：PatchWarden 定位与动机。
- 上游草稿 PR：https://github.com/getagentseal/agentseal/pull/35
