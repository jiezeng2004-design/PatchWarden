# Evidence Pack v2 文件结构

> 本文基于 v1.5.1 源码编写；安装时请使用已验证发布的 <published-version>。（Evidence Pack v2）
> 相关页面：`export_task_evidence_pack` MCP 工具、Lineage 与 Evidence Pack 工作流

## 概述

`export_task_evidence_pack` 导出 8 个有界文件到
`.patchwarden/evidence-packs/<lineage_id>/`。每个文件只包含有界摘要，
**不**包含完整 stdout/stderr/diff/secrets/.env/token/cookie/凭据路径。

## 文件清单

| 文件 | 用途 |
| --- | --- |
| `evidence.json` | 完整有界证据包（机器可读），含 lineage、policy、catalog 摘要。 |
| `EVIDENCE.md` | 人类可读的 Markdown 证据摘要。 |
| `risk.json` | 聚合的风险项与严重度（high/medium/low）。 |
| `verify.json` | 每轮迭代和 direct session 的结构化验证记录。 |
| `diffstat.json` | 文件级增删统计（路径、增删行数），不含完整 diff。 |
| `lineage.json` | lineage 有界摘要（goal、final_status、stop_reason、task 计数）。 |
| `attestation.json` | 版本、commit、Node/OS、tool profile、schema epoch 等溯源信息。 |
| `redactions.json` | 本次导出中脱敏的类别与计数（不存原始隐藏值）。 |

## risk.json

从 lineage 的 rounds（`fail_checks` / `warn_checks`）和 `warnings` 聚合风险项。

```json
{
  "risks": [
    {
      "source": "round",
      "task_id": "task-main",
      "severity": "high",
      "category": "fail_check",
      "detail": "verification failed: npm test exited with code 1"
    },
    {
      "source": "round",
      "task_id": "task-main",
      "severity": "medium",
      "category": "warn_check",
      "detail": "minor scope drift"
    },
    {
      "source": "lineage",
      "severity": "low",
      "category": "warning",
      "detail": "diff.patch was truncated"
    }
  ],
  "count": 3,
  "by_severity": { "high": 1, "medium": 1, "low": 1 }
}
```

**严重度映射**：

- `high` — round 的 `fail_checks`
- `medium` — round 的 `warn_checks`
- `low` — lineage 的 `warnings`

如果 lineage 无风险信息，写 `{"risks": [], "count": 0, "by_severity": {"high": 0, "medium": 0, "low": 0}}`。

## verify.json

从 lineage 的 rounds 和 direct_sessions 提取结构化验证记录。

```json
{
  "records": [
    {
      "source": "round",
      "task_id": "task-main",
      "role": "main",
      "verification_status": "passed",
      "audit_verdict": "pass",
      "passed": true
    },
    {
      "source": "direct_session",
      "session_id": "direct-one",
      "verification_status": "passed",
      "audit_verdict": "pass",
      "passed": true,
      "command_count": 3,
      "passed_commands": 3,
      "failed_commands": 0
    }
  ],
  "count": 2,
  "summary": { "total": 2, "passed": 2, "failed": 0 },
  "latest_status": "passed",
  "overall_passed": true
}
```

**有界规则**：不含 stdout_tail/stderr_tail/完整验证日志，只保留状态与计数摘要。

如果 lineage 无验证信息，写空 records 数组。

## diffstat.json

从 lineage 引用的 task 目录（`<tasksDir>/<task_id>/file-stats.json`）聚合文件级增删统计。

```json
{
  "files": [
    {
      "path": "src/index.ts",
      "status": "modified",
      "additions": 12,
      "deletions": 3,
      "task_id": "task-main"
    }
  ],
  "count": 1,
  "totals": { "additions": 12, "deletions": 3 }
}
```

**有界规则**：只存文件路径与行级增删计数，**不**含完整 diff 内容。所有路径经过
`redactSensitiveValue` 脱敏处理。如果 task 目录不存在或 file-stats.json 缺失，写空数组。

## lineage.json

lineage 的有界摘要，不含完整 rounds 详情或 warnings/errors 原文。

```json
{
  "lineage_id": "lineage_20260709_120000_a1b2c3d4",
  "goal": "Fix authentication bug",
  "final_status": "accepted",
  "stop_reason": "success",
  "iterations_count": 1,
  "task_counts": {
    "main": 1,
    "fix": 0,
    "cleanup": 0,
    "direct_sessions": 1
  },
  "verification": { "latest_status": "passed", "passed": true },
  "worktree": { "isolation_mode": "worktree", "status": "active" },
  "agent_routing": { "selected_agent": "codex" },
  "warnings_count": 0,
  "errors_count": 0,
  "truncated": false
}
```

## attestation.json

记录生成此证据包时的环境与版本溯源信息。

```json
{
  "patchwarden_version": "1.6.0",
  "package_version": "1.6.0",
  "commit": "bc950a2",
  "node_version": "v20.11.0",
  "os": { "platform": "win32", "arch": "x64" },
  "tool_profile": "full",
  "schema_epoch": "2026-07-16-v14",
  "generated_at": "2026-07-09T12:00:00.000Z"
}
```

**字段说明**：

- `patchwarden_version` — `src/version.ts` 中的 `PATCHWARDEN_VERSION`
- `package_version` — `package.json` 中的 version（与 patchwarden_version 一致）
- `commit` — `git rev-parse --short HEAD` 获取的 short hash；非 Git 环境为 `"unknown"`
- `node_version` — `process.version`
- `os` — `process.platform` 与 `process.arch`
- `tool_profile` — 当前工具目录快照的 profile
- `schema_epoch` — `TOOL_SCHEMA_EPOCH`

## redactions.json

记录本次导出中脱敏的类别、原因与计数。**不存原始隐藏值**。

```json
{
  "redactions": [
    {
      "category": "known_token_format",
      "reason": "matched known token format",
      "count": 1
    }
  ],
  "total_redacted": 1,
  "bounded": true,
  "note": "Only categories and counts are recorded; original secret values are never persisted."
}
```

**脱敏类别**：

| category | 匹配内容 |
| --- | --- |
| `private_key` | PEM 私钥块 |
| `bearer_token` | `Bearer <token>` 格式 |
| `npm_token` | npm `_?authToken=` 赋值 |
| `credential_assignment` | `api_key=` / `secret=` / `password=` 等凭据赋值 |
| `known_token_format` | `sk_` / `ghp_` / `github_pat_` 前缀的 token |

## 安全边界

- 所有 v2 文件经过 `redactSensitiveValue` 处理后才写入磁盘。
- `redactions.json` 只记录类别 + 原因 + 计数，**永不**持久化原始密钥值。
- `diffstat.json` 只存文件路径与行级计数，不含 diff 正文。
- `verify.json` 只存状态摘要，不含 stdout/stderr tail。
- `.patchwarden/evidence-packs/` 不进入 npm 包（package.json `files` 已排除）。
- MCP 工具 `export_task_evidence_pack` 的输入参数无破坏性变更，只是输出多了文件。
