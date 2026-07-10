# Dashboard 概览

> 本文基于 v1.5.1 源码编写；安装时请使用已验证发布的 <published-version>。
> 入口：`PatchWarden-Control.cmd` 或托盘菜单中的 "Open Control Center"。

## 目的

PatchWarden Dashboard（Control Center）把本地 Agent 工作流从“只能看的状态面板”
升级为“可操作的工作流控制中心”。所有操作默认走 safe 摘要接口，完整日志、diff、
test log 仅在折叠的“高级区”按需加载，不改变 PatchWarden 的安全边界。

## 核心概念

- **Safe-first**：默认展示 `safe_result` / `safe_audit` / `safe_test_summary` /
  `safe_diff_summary` / `safe_direct_summary` 等有界摘要，避免直接渲染完整产物。
- **Repo selector**：顶部下拉列出 workspace 根目录及其一级项目目录（带 package.json
  版本标记）。切换 repo 会刷新 Project Policy、Release、Recent Tasks、Lineage、
  Evidence Pack、Direct Sessions。
- **Health Score**：综合 watcher / tunnel / agents / stale 任务 / 失败任务 /
  policy 有效性 / release readiness / direct profile 状态计算出的健康分，
  状态为 `healthy` / `warning` / `degraded` / `blocked`。
- **Bound to lineage**：Evidence Pack 与 Lineage 绑定，只有 `run_task_loop` 产生
  lineage 后才能导出证据包。

## 主要页面

| 页面 | 主要内容 |
| --- | --- |
| Dashboard | Repo selector、Health Score、服务状态、Release 卡片、Project Policy、Lineage、Evidence Pack、Stale 任务提示、最近任务列表、系统状态（含 Copy diagnostics） |
| Tasks | 任务列表，支持按 repo_path / status / acceptance_status / warning_type / agent / date range 过滤 |
| Task Detail | safe 摘要默认视图 + 折叠的高级区（完整 result / diff / test_log） |
| Direct Sessions | 按 active / finalized / audited / expired 分组的 Direct 会话 |
| Audit / Warnings | 按 warning 类型聚合的诊断页 |
| Workspace | workspace 一级目录与项目列表 |
| Logs | Core / Direct / Watcher / Control Center 日志尾部 |

## 推荐工作流

1. 在 Dashboard 顶部选择目标 repo。
2. 查看 Health Score，确认系统健康（`healthy` 或 `warning`）。
3. 在 Release 卡片确认发布就绪状态；若 `blocked`，按 `blocked_reason` 修复。
4. 在最近任务列表点击 `safe_result` 快捷查看任务摘要。
5. 打开 Task Detail 进行 safe-first 验收（详见
   [task-safe-review-workflow.md](task-safe-review-workflow.md)）。
6. 使用 Lineage Detail 查看 `run_task_loop` 成功/失败原因（详见
   [lineage-evidence-pack-workflow.md](lineage-evidence-pack-workflow.md)）。
7. 验收完成后导出 Evidence Pack。
8. Direct 会话用于独立验证，完成后 finalize + audit（详见
   [direct-session-workflow.md](direct-session-workflow.md)）。
9. 遇到问题时点击 **Copy diagnostics** 复制诊断信息，发给 ChatGPT / Codex / opencode 排查。

## 卡片速查

### Release 卡片

显示 package name、version_source、version、version_consistent、required_commands
（每条命令的 allowed + blocked_reason）、commands_blocked_count、
ready/unknown/blocked 状态及 blocked 原因。`next_action` 会引导使用
`release_check` 模板。

### Stale 任务卡片

不再是简单的“过期任务列表”，而是可解释、可操作的健康建议卡片，包含 task_id、
repo_path、status、error、人类可读的 explanation、next_action，以及快捷操作
（查看详情、复制 task_id、隐藏、重建任务）。

### Project Policy 卡片

只读展示 auto_cleanup、protected_paths 数量、high_risk_commands 数量、
release_mode 摘要。

## 安全边界

- 所有 safe 接口返回有界摘要，不包含完整日志、stdout/stderr tail、diff、密钥内容。
- 完整 result / diff / test_log 只在折叠的高级区按需加载，永不自动加载。
- Project Policy 卡片只读，不能从 UI 修改策略。
- 不执行远程写操作（npm publish / git push / git tag / gh release）。
- Diagnostics 输出经过 `redactSensitiveContent` 脱敏。

## 相关 API 端点

- `GET /api/workspace/repos` — Repo selector 数据源
- `GET /api/diagnostics` — Copy diagnostics 数据源
- `GET /api/warnings` — Warnings 页数据源
- `GET /api/release/status` — Release 卡片数据源
- `GET /api/tasks/stale` — Stale 任务卡片数据源（含 explanation / next_action）
