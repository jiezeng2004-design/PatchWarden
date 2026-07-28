# OpenHands worker 集成模式

> 本文基于 PatchWarden v1.6.6 源码描述建议集成模式。
> OpenHands 是独立项目，本文不声称已有官方集成关系。

## 定位

PatchWarden 可以把经过本地维护者登记的 OpenHands 命令作为 worker agent 启动，
并使用 PatchWarden 的 task 生命周期保存计划、状态、验证结果、Git 快照、改动文件
和审计证据。

```text
MCP client -> PatchWarden task workflow -> registered OpenHands process
                    |                              |
                    v                              v
           assessment and evidence             workspace
```

这是一种 external supervisor 模式，不是对 OpenHands 内部每个工具调用的透明代理。
PatchWarden 能治理自己的任务入口、启动配置和验证命令，并能根据任务前后证据报告
范围违规；它不会仅因启动了 OpenHands 就自动拦截其原生 shell、文件或网络调用。

## 注册 worker

在可信的 `patchwarden.config.json`（或 `PATCHWARDEN_CONFIG` 指向的文件）中把
OpenHands 注册为本地 agent。具体 CLI 参数必须以实际安装版本为准，由维护者本地
确认，不能由模型请求动态定义。

```json
{
  "workspaceRoot": "D:/repos",
  "agents": {
    "openhands": {
      "command": "openhands",
      "args": ["<reviewed-headless-arguments>", "{prompt}"],
      "envAllowlist": []
    }
  },
  "allowedTestCommands": [
    "npm test",
    "npm run build"
  ]
}
```

不要把模型服务 API key 写进仓库配置。PatchWarden 默认向子进程传递最小环境；
确有需要的 provider 环境变量必须通过该 agent 的 `envAllowlist` 显式允许。

可选的仓库策略位于 `.patchwarden/project-policy.json`，真实字段包括
`allowed_commands`、`high_risk_commands`、`protected_paths`、`auto_cleanup`
和 `release_mode`。该策略不是 OpenHands 内部文件工具的通用拦截器。

## 真实任务流程

1. 使用 `save_plan` 或 `create_task` 的模板/inline plan 声明任务。
2. 先以 `execution_mode: "assess_only"` 获取风险决定和 assessment。
3. Low-risk assessment 可以执行；medium-risk assessment 需要本地
   `patchwarden-confirm`；blocked assessment 不能执行。
4. 使用最小 `assessment_id` 调用执行任务，并通过 `wait_for_task` 等待终态。
5. 检查 `get_task_summary`、验证记录、diff/changed-file 证据和 `audit_task`。

示例仅展示 PatchWarden 调用形状，不规定 OpenHands 自身 CLI：

```json
{
  "tool": "create_task",
  "execution_mode": "assess_only",
  "template": "feature_small",
  "goal": "Fix the null handling bug and add a regression test",
  "agent": "openhands",
  "repo_path": "my-project",
  "verify_commands": ["npm test"]
}
```

## 能保证与不能保证的内容

| 范围 | PatchWarden v1.6.6 行为 |
| --- | --- |
| 仓库选择 | `repo_path` 必须位于 `workspaceRoot` 下 |
| worker 启动 | 只能使用本地配置中登记的 command/args 模板 |
| 验证命令 | 必须与可信配置中的允许列表精确匹配 |
| 环境变量 | 子进程使用最小环境，额外 provider 变量需显式允许 |
| 仓库改动 | 保存任务前后 Git 快照、changed-file 和 diff 证据，并报告范围违规 |
| 敏感读取 | PatchWarden 自身文件工具会阻止敏感路径；worker 原生工具不受逐调用代理 |
| 网络访问 | 取决于 worker 和隔离环境，PatchWarden 任务调度不构成网络 sandbox |
| push/publish | 不属于普通 Runner 自动流程，远程结果必须单独核验 |

任务后的范围违规检测可以发现仓库效果，但不能撤销已经发生的外部网络请求，也不能
替代对 worker 进程的强隔离。需要强保证时应在 Docker、VM、devcontainer 或其他
OS-level sandbox 中运行 worker，并只挂载必要的 workspace。

## 与 Governance Issue 的关系

OpenHands 的 action-level governance 仍应在执行前的 action boundary 解决。参见
[治理讨论草稿](integrations/openhands-governance.md)。如果未来 OpenHands
提供稳定的 pre-dispatch hook，可以再实现真正逐调用的外部 policy adapter；在此
之前不应把 external worker 调度描述成该 adapter 已存在。

## 相关文档

- [PatchWarden Security Model](security-model.md)
- [PatchWarden Threat Model](threat-model.md)
- [Evidence Pack v2 schema](evidence-pack-schema.md)
- [OpenCode worker integration](opencode-worker.md)
