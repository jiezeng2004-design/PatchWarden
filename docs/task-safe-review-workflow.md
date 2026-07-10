# 任务 Safe 验收工作流

> 本文基于 v1.5.1 源码编写；安装时请使用已验证发布的 <published-version>。
> 相关页面：Tasks、Task Detail

## 目的

在不暴露完整日志、diff、test log 的前提下，用一组 safe 摘要接口完成对单个任务的
验收判断。完整产物仅在确认需要时才从折叠的“高级区”按需加载。

## 核心概念

- **safe_result**：任务结果摘要，包含 status、acceptance_status、verification 概要、
  warnings、fail_checks、manual_verification_required、recommended_next_actions。
- **safe_test_summary**：测试摘要，只包含通过/失败计数和失败用例名称，不含完整 stdout。
- **safe_diff_summary**：diff 摘要，包含变更文件数、新增/删除/修改行数统计、
  受保护路径命中情况，不含完整 diff。
- **safe_audit**：审计摘要，包含 artifact 完整性、scope_changes、命令白名单合规性
  的有界摘要。
- **acceptance_status**：任务的验收状态，比 `status` 更能反映“是否真的通过”。
- **Advanced 区**：折叠区域，包含完整 result / diff / test_log，需手动展开。

## 验收工作流

### 1. 在 Tasks 列表筛选目标任务

Tasks 页支持按 `repo_path` / `status` / `acceptance_status` / `warning_type` /
`agent` / date range 过滤。建议优先关注：

- `acceptance_status` 为 `pending` 或 `failed_verification` 的任务
- 带有 warning 的任务（warning_type 列会高亮）

### 2. 使用行内快捷操作预览

每行任务提供以下快捷操作，无需进入详情页即可快速判断：

- `safe_result` — 查看任务结果摘要
- `safe_test_summary` — 查看测试摘要
- `safe_diff_summary` — 查看变更摘要
- `safe_audit` — 查看审计摘要
- `open detail` — 进入 Task Detail 页
- `copy id` — 复制完整 task_id

### 3. 进入 Task Detail 进行完整 safe 验收

Task Detail 默认展示 safe 摘要视图：

- **safe_result** 区：status、acceptance_status、verification headline、warnings、
  fail_checks、manual_verification_required、recommended_next_actions
- **safe_test_summary** 区：通过/失败计数、失败用例名
- **safe_diff_summary** 区：变更文件数、行数统计、受保护路径命中
- **safe_audit** 区：artifact 完整性、scope_changes、命令合规性

### 4. 仅在必要时展开高级区

只有当 safe 摘要无法定论时（例如 `manual_verification_required` 为 true，
或 `fail_checks` 指向某个具体失败），才展开高级区查看完整产物：

- 完整 result（JSON）
- 完整 diff
- 完整 test_log

> 高级区内容不会自动加载，必须手动点击展开。展开不会触发任何写操作。

### 5. 根据 recommended_next_actions 决定下一步

safe_result 的 `recommended_next_actions` 会给出建议，例如：

- 验收通过 → 导出 Evidence Pack 或进行 Direct 独立验证
- 验收失败 → 基于 `run_task_loop` 创建修复任务
- 需要人工确认 → 标记 `manual_verification_required` 后人工复核

## Stale 任务处理

Stale 任务卡片会给出 explanation 和 next_action：

- **view detail** — 查看 safe 摘要判断是否需要重建
- **copy task_id** — 复制 id 用于后续命令
- **hide** — 调用 `POST /api/tasks/:taskId/hide-stale` 从 stale 列表隐藏
- **recreate task** — 基于原任务参数创建新任务

## 安全边界

- safe 接口返回有界摘要，不含完整 stdout/stderr、完整 diff、密钥、token。
- 完整产物仅在高级区手动展开后加载，且不离开本机。
- 验收操作不触发远程写（不 publish、不 push、不 tag、不 release）。
- `acceptance_status` 由 watcher 与 verification 流程计算，不能从 UI 直接伪造。

## 相关 API 端点

- `GET /api/tasks` — 任务列表（支持 repo_path / status / acceptance_status /
  agent / warning_type 过滤）
- `GET /api/tasks/:taskId/safe-result` — safe_result 摘要
- `GET /api/tasks/:taskId/safe-test-summary` — safe_test_summary 摘要
- `GET /api/tasks/:taskId/safe-diff-summary` — safe_diff_summary 摘要
- `GET /api/tasks/:taskId/safe-audit` — safe_audit 摘要
- `GET /api/tasks/stale` — stale 任务列表（含 explanation / next_action）
- `POST /api/tasks/:taskId/hide-stale` — 隐藏 stale 任务
