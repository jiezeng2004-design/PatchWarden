# PatchWarden Architecture

PatchWarden 是一个本地优先的 MCP（Model Context Protocol）安全桥接器，通过 5 种运行角色（MCP Server / Watcher / Agent / Control Center / Desktop App）协同，为 AI agent 提供任务编排、安全守卫、变更证据收集与审计能力。

## 详细文档

- [Code Wiki](./CODE_WIKI.md) —— 完整项目架构、模块职责、关键类与函数说明、依赖关系、运行方式、现有缺陷
- [Threat Model](./threat-model.md) —— 安全威胁模型与防护设计
- [Control Center](./control-center/README.md) —— Control Center HTTP 管理界面文档
- [Desktop App](./desktop-app.md) —— Electron 桌面应用文档
- [Direct Session Workflow](./direct-session-workflow.md) —— Direct 模式会话工作流
- [Task Safe Review Workflow](./task-safe-review-workflow.md) —— 任务安全审查工作流

## 一致性与资源边界

- `.patchwarden/` 只是证据存储位置，不是敏感路径豁免区；敏感文件名在任意目录深度都阻断。
- Goal 状态变更由跨进程 mutation lock 串行化并原子落盘；非空 Goal 的子目标全部 accepted 后自动转为 `completed`。
- 子目标任务以 Goal 保存的 `repo_path` 为权威并拒绝 mismatch；worktree create/merge/discard 共享该仓库的 lifecycle lock。
- task diff/summary/log tail 采用有界读取，`audit_task` 对文档数量和总字节设置预算，持续 invocation/reconcile 日志采用锁内有界追加并明确标记截断。

## 历史版本

历史架构文档与阶段性设计已归档至 [archive/](./archive/)。
