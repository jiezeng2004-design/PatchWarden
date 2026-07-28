# AgentSeal 集成模式

> 本文基于 PatchWarden v1.6.6 源码描述建议集成模式。
> 这不是 AgentSeal 的官方功能，也不代表双方已有正式集成。

## 集成定位

AgentSeal 可以承担策略发现、静态检查或风险报告；PatchWarden 可以在自己的
MCP、task 和 Direct 调用边界内执行路径保护、命令允许列表、风险评估和证据收集。
两者若要共享策略，必须显式实现适配器，不能仅凭安装两个工具就假设策略已经同步。

```text
AgentSeal:   discover or inspect policy -> report findings
                                      |
                                      v
PatchWarden: assess request -> execute guarded workflow -> collect evidence
```

## 真实配置入口

PatchWarden 运行配置由以下入口解析：

1. `PATCHWARDEN_CONFIG` 指向的显式文件；
2. 当前工作目录的 `patchwarden.config.json`；
3. 当前工作目录的 `.patchwarden.json`。

仓库级策略文件固定为 `.patchwarden/project-policy.json`。`.patchwarden/`
同时可能保存任务和证据，因此仅发现该目录不能证明某个策略文件存在或 CLI 已安装。

运行配置示例：

```json
{
  "workspaceRoot": "D:/repos",
  "plansDir": ".patchwarden/plans",
  "tasksDir": ".patchwarden/tasks",
  "agents": {
    "opencode": {
      "command": "opencode",
      "args": ["run", "{prompt}"],
      "envAllowlist": []
    }
  },
  "allowedTestCommands": [
    "npm test",
    "npm run build"
  ]
}
```

该文件可能包含私人路径和本地 Agent 配置，不应上传、复制到报告或作为扫描
fixture 提交。

## 仓库级策略 schema

`.patchwarden/project-policy.json` 当前使用 snake_case 字段：

```json
{
  "allowed_commands": ["npm test", "npm run build"],
  "high_risk_commands": ["npm publish", "git push", "git tag", "gh release create"],
  "protected_paths": [".env", ".env.*", ".ssh", ".npmrc", ".pypirc"],
  "auto_cleanup": {
    "enabled": true,
    "patterns": ["release-artifact-manifest.json"],
    "exclude": [".git", ".patchwarden", "node_modules", "docs"]
  },
  "release_mode": {
    "version_source": "package.json",
    "required_commands": ["npm run build", "npm test"]
  }
}
```

PatchWarden validates these fields and applies them to its own project-policy
and release-readiness decisions. This schema does not contain `allowedPaths`,
`blockedFiles`, or `scopeRules`. Task scope and before/after repository evidence
are handled by separate task inputs and runtime records.

An AgentSeal adapter should:

- treat `.patchwarden/project-policy.json` as the authoritative repository
  policy path;
- parse only documented fields and report unknown keys rather than guessing;
- never copy the private runtime config or credentials into scan output;
- avoid automatically relaxing built-in sensitive-path or workspace guards;
- record the policy hash or snapshot used for a finding so results remain
  auditable.

## Enforcement Boundary

PatchWarden enforces calls that pass through its own tools and task workflow. A
worker agent may have native shell, filesystem, or network capabilities that
PatchWarden does not intercept one call at a time. Before/after Git snapshots,
changed-file evidence, and scope-violation reporting can detect repository
effects, but they are not equivalent to OS sandboxing or complete mediation.

For mandatory containment, use a container, VM, devcontainer, or OS-level
sandbox and restrict bypass paths in the client or worker configuration.

## 建议验证

- 使用不含真实路径或密钥的 fixture 解析两种运行配置候选。
- 验证 `.patchwarden/project-policy.json` 的 snake_case schema。
- 验证只有 `.patchwarden/` 目录时不会报告已配置集成。
- 验证未知字段和不安全策略只产生报告，不自动扩大 PatchWarden 权限。
- 对照 [安全模型](security-model.md) 和
  [Evidence Pack schema](evidence-pack-schema.md) 检查边界与输出。
