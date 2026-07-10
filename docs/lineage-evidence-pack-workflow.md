# Lineage 与 Evidence Pack 工作流

> 本文基于 v1.5.1 源码编写；安装时请使用已验证发布的 <published-version>。
> 相关页面：Dashboard（Lineage / Evidence Pack 卡片）、Lineage Detail 模态框

## 目的

`run_task_loop` 是 PatchWarden 的受守护循环（guarded loop）：在 watcher、命令
白名单、workspace 隔离、敏感路径拦截下，自动执行“主任务 → 修复 → 清理”迭代。
Lineage 记录整条循环的因果链，Evidence Pack 把通过验收的 lineage 导出为可归档的
证据文件，整个过程不泄露完整日志或密钥。

## 核心概念

- **Lineage**：一次 `run_task_loop` 的完整记录，包含 goal、final_status、
  stop_reason、iterations、main/fix/cleanup 各角色的 task 计数、
  direct_verification、warnings_count。
- **Iteration**：循环中的单次迭代，按角色（main / fix / cleanup）分组，记录
  status、acceptance_status、verification、audit、stop_reason、
  final_recommended_next_action。
- **Evidence Pack**：与 lineage 绑定的证据包，写入
  `.patchwarden/evidence-packs/<lineage_id>/`，包含 `evidence.json` 与
  `EVIDENCE.md` 两个文件（v2 额外包含 6 个结构化文件，见下文）。
- **export_status**：证据包的导出状态，`pending` / `exported` / `failed`。

## 工作流

### 1. 启动受守护循环

通过 MCP 工具 `run_task_loop` 启动循环，可指定：

- `agent="auto"` — 让 PatchWarden 自动路由到合适的 agent
- `scope_files` — 路由提示
- `isolation_mode="worktree"` — 可选的 git worktree 隔离

循环结束后会生成一条 lineage 记录。

### 2. 在 Dashboard 查看 Lineage 状态

Dashboard 的 Lineage 卡片区分空/已填充两种状态：

- **空状态**：显示 “No loop lineage yet”，提供 “Start guarded loop” 和
  “View recent loop runs” 入口。
- **已填充状态**：显示 lineage_id、goal、final_status、stop_reason、iterations、
  main/fix/cleanup task 计数、direct_verification、warnings_count。

### 3. 打开 Lineage Detail 排查成功/失败原因

点击 lineage 卡片可打开 Lineage Detail 模态框，按角色（main / fix / cleanup）
分组展示每次迭代的：

- status、acceptance_status
- verification 摘要
- audit 摘要
- stop_reason
- final_recommended_next_action

如果 `final_status` 为 `failed`，先看最后一个迭代的 `stop_reason` 和
`final_recommended_next_action`，再决定是重建任务还是人工介入。

### 4. 验收通过后导出 Evidence Pack

只有 lineage 存在且验收通过后，Evidence Pack 卡片才会进入可导出状态：

- **空状态**：显示 “Evidence pack is available after run_task_loop.”
- **已填充状态**：显示 lineage_id、export_status、evidence_json_exists、
  evidence_md_exists、exported_at。

点击 **Export evidence pack** 调用 `POST /api/evidence-packs/:lineageId/export`，
PatchWarden 会把有界摘要写入：

```text
.patchwarden/evidence-packs/<lineage_id>/evidence.json
.patchwarden/evidence-packs/<lineage_id>/EVIDENCE.md
```

### 4.1 Evidence Pack v2 结构化文件（v1.5.1+）

v2 在原有 `evidence.json` 与 `EVIDENCE.md` 基础上额外导出 6 个有界文件：

```text
.patchwarden/evidence-packs/<lineage_id>/risk.json
.patchwarden/evidence-packs/<lineage_id>/verify.json
.patchwarden/evidence-packs/<lineage_id>/diffstat.json
.patchwarden/evidence-packs/<lineage_id>/lineage.json
.patchwarden/evidence-packs/<lineage_id>/attestation.json
.patchwarden/evidence-packs/<lineage_id>/redactions.json
```

| 文件 | 用途 |
| --- | --- |
| `risk.json` | 聚合的风险项与严重度（high/medium/low），来源为 rounds 的 fail_checks/warn_checks 与 lineage warnings。 |
| `verify.json` | 每轮迭代和 direct session 的结构化验证记录（状态、audit、command 计数）。 |
| `diffstat.json` | 文件级增删统计（路径、增删行数），不含完整 diff。 |
| `lineage.json` | lineage 有界摘要（goal、final_status、stop_reason、task 计数）。 |
| `attestation.json` | 版本、commit short hash、Node/OS、tool profile、schema epoch。 |
| `redactions.json` | 本次导出中脱敏的类别与计数（不存原始隐藏值）。 |

每个文件都经过 `redactSensitiveValue` 脱敏处理。详细字段结构与示例见
[Evidence Pack v2 文件结构](./evidence-pack-schema.md)。

### 5. 查看与归档证据文件

导出后可使用卡片上的按钮：

- **Open EVIDENCE.md** — 打开人类可读的 Markdown 证据
- **Open evidence.json** — 打开机器可读的 JSON 证据
- **Copy lineage_id** — 复制 lineage_id 用于后续追溯

## 安全边界

- Evidence Pack 只包含有界摘要，**不**包含完整日志、stdout/stderr tail、
  完整 diff、verification 日志或密钥内容。
- worktree 模式不会自动 merge 或删除 worktree，需要人工确认。
- 导出操作只写本地文件，不执行 `npm publish` / `git push` / `git tag` /
  `gh release` 等远程写。
- direct_verification 仅作为独立验证通道，不会自动 patch 文件。

## 相关 API 端点

- `GET /api/lineages` — lineage 列表（含 goal / final_status / stop_reason /
  iterations / task counts / direct_verification / warnings_count）
- `GET /api/lineages/:id` — 单条 lineage 详情
- `GET /api/evidence-packs` — 证据包列表（含 export_status /
  evidence_json_exists / evidence_md_exists / exported_at）
- `GET /api/evidence-packs/:lineage_id` — 单个证据包详情
- `POST /api/evidence-packs/:lineageId/export` — 触发证据包导出
