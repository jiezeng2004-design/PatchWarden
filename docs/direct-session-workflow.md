# Direct 会话工作流

> 本文基于 v1.5.1 源码编写；安装时请使用已验证发布的 <published-version>。
> 相关页面：Direct Sessions

## 目的

Direct 会话（Direct Session）是 PatchWarden 提供给 ChatGPT 等 Direct agent 的
独立验证通道：在 watcher 守护的任务流程之外，对一个 repo 做独立的文件查看、
命令执行和验证。Direct 不会自动 patch 文件、不会绕过命令守卫，所有操作仍受
workspace 隔离、敏感路径拦截和审计约束。

## 核心概念

- **Direct session**：绑定到某个 repo_path 的一次独立会话，有 session_id、
  title、created_at、expires_at。
- **会话状态分组**：`active` / `finalized` / `audited` / `expired`。
  expired 默认折叠。
- **safe_direct_summary**：Direct 会话的有界摘要，包含 changed_files_total、
  verification status，不含完整 diff 或 stdout。
- **finalize**：把 active 会话标记为已完成（finalized），冻结变更记录。
- **audit**：对 finalized 会话做审计，生成审计摘要（audited 状态）。
- **verification bundle**：`run_direct_verification_bundle` 一次性跑测试 + diff +
  验收检查的成组操作。

## 生命周期

### 1. 创建 Direct 会话

通过 Direct profile 的 MCP 工具创建会话（如 `start_direct_session`），指定
repo_path 和 title。会话会进入 `active` 状态，并记录 created_at 与 expires_at。

### 2. 在 Direct Sessions 页查看

Direct Sessions 页按状态分组展示所有会话：

- **active** — 进行中
- **finalized** — 已 finalize，待 audit
- **audited** — 已完成审计
- **expired** — 已过期（默认折叠）

每个会话显示 session_id、repo_path、title、created_at、expires_at、finalized、
audited、changed_files_total、verification status。

### 3. 执行独立验证

在 active 会话中，使用 Direct 工具进行独立验证：

- 查看文件（受敏感路径拦截）
- 执行允许的命令（受白名单约束）
- 调用 `run_direct_verification_bundle` 一次跑完测试 + diff + 验收检查

或直接在 Direct Sessions 页点击 **run_direct_verification_bundle** 快捷操作。

### 4. 查看 safe 摘要

点击 **safe_direct_summary** 查看会话的有界摘要：

- changed_files_total
- verification status
- 是否命中受保护路径

> 完整 diff 与 stdout 不会自动加载，仅在高级区按需查看。

### 5. Finalize 会话

验证完成后点击 **safe_finalize_direct_session**（或调用
`POST /api/direct-sessions/:sessionId/finalize`），把会话标记为 `finalized`，
冻结变更记录，准备进入审计。

### 6. Audit 会话

对 finalized 会话点击 **safe_audit_direct_session**（或调用
`POST /api/direct-sessions/:sessionId/audit`），生成审计摘要，会话进入
`audited` 状态。审计摘要可用于归档或与 lineage 的 direct_verification 对照。

### 7. 处理过期会话

超过 expires_at 的会话进入 `expired` 状态，默认折叠。可执行：

- **copy session_id** — 复制 id 用于追溯
- **hide expired** — 调用 `POST /api/direct-sessions/:sessionId/hide` 隐藏

## 安全边界

- Direct 会话仍受 workspace 隔离、命令白名单、敏感路径拦截约束。
- Direct 不会自动 patch 文件，所有写操作都需要显式确认。
- safe 摘要不含完整 diff / stdout / 密钥内容。
- finalize 与 audit 只修改本地会话状态，不触发远程写。
- Direct 不执行 `npm publish` / `git push` / `git tag` / `gh release`。

## 相关 API 端点

- `GET /api/direct-sessions` — 会话列表（按状态分组）
- `GET /api/direct-sessions/:sessionId` — 单个会话详情
- `POST /api/direct-sessions/:sessionId/finalize` — finalize 会话
- `POST /api/direct-sessions/:sessionId/audit` — audit 会话
- `POST /api/direct-sessions/:sessionId/hide` — 隐藏过期会话
