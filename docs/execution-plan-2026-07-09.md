# PatchWarden Execution Plan 2026-07-09

> Created: 2026-07-09
> Base document: `docs/roadmap-execution-and-acceptance.md`
> Scope: 基于 2026-07-09 实地核验后的细化执行计划，覆盖 P0–P3 全阶段。
> Codex 负责实现与门禁验证；用户负责 credentialed / external-write 操作（push、merge、release、publish）。

## 0. 当前真实状态核验（对 roadmap 文档的修正）

| 项目 | roadmap 假设 | 2026-07-09 实地核验 | 影响 |
| --- | --- | --- | --- |
| 分支 | `codex/patchwarden-v1.5.0` | 一致 | — |
| HEAD | `cc27e6a Add OSS application evidence materials` | 一致 | — |
| 工作区 | dirty，preserve user changes | 34 个 M + 5 个 ??，含 `package.json`、`version.ts`、`src/tools/*`、`ui/pages/*`、4 个新增 docs | P0 前必须逐文件核对并提交 |
| 本地源码版本 | 1.5.1 | `package.json` = 1.5.1，CHANGELOG v1.5.1 主题为 Dashboard UI 优化 | 一致 |
| GitHub Release / npm | 仍为 v1.5.0 | 未重新核验（roadmap 已记录） | P0 任务成立 |
| Evidence Pack 现状 | 仅 `evidence.json` + `EVIDENCE.md` | `src/tools/evidencePack.ts` 确认只写这两个文件 | P1 v2 差距成立 |
| 已有 docs | 部分缺失 | `lineage-evidence-pack-workflow.md`、`threat-model.md` 已存在（未跟踪）；缺 `why-patchwarden.md`、`evidence-pack-schema.md`、`spec-kit-integration.md`、`agentseal-integration.md`、`mcp-inspector-testing.md`、`opencode-worker.md`、`openhands-worker.md` | P1 docs 任务成立 |

**关键修正**：roadmap P0 假设"本地源码已就绪，只需发布"。实地发现工作区有大量未提交修改（看起来是 v1.5.1 Dashboard UI 优化的实现）。因此新增 **P0-0 前置步骤：逐文件核对并提交工作区修改**。

## 1. 用户决策记录（2026-07-09）

1. 工作区 34 个 M + 5 个 ?? 文件：**逐文件核对**后决定纳入范围。
2. P0 发布的 credentialed / external-write 操作（push、merge、release、publish）：**用户手动执行**。Codex 只负责本地门禁与分支准备。
3. 本计划：**写入 docs 文件存档**，便于后续按阶段跟踪。

## 2. P0：v1.5.1 可信发布

### P0-0 前置：逐文件核对并提交工作区修改（新增）

#### 核对结果（2026-07-09 完成）

实际工作区：**41 个 M + 9 个 ??**（非最初预估的 34+5）。

**版本号一致性**：`package.json` / `version.ts` / `CHANGELOG.md` 三处均为 1.5.1 ✅；`README.md` 第 11 行 / `README.en.md` 第 11 行仍为 v1.5.0 ❌（发布前必修）。

**分类汇总**：

| 分类 | 文件数 | 判定 |
| --- | --- | --- |
| Dashboard UI 优化本体 | 9 M + 4 ?? | 属于 v1.5.1 |
| async 重构链（sync→async） | 16 M | **隐性依赖**：controlCenter.ts v1.5.1 端点 `await safeFinalizeDirectSession(...)` 依赖此链，技术上不可简单拆分 |
| 并发任务执行特性（maxConcurrentTasks） | 8 M | 独立新特性，CHANGELOG 未提及，可拆为下一版本 |
| 安全加固 / Bug 修复 | 4 M | 独立，建议纳入（含二进制检测窗口 8KB→1MB、Windows fs.rmSync 修复） |
| 用户本地配置（AGENTS.md Codex Memory） | 1 M | 含本机绝对路径 `D:\ai_agent\CodexMemory`，不应入库 |
| IDE 状态 / 发布产物 | 3 ?? | `.trae/`、`patchwarden-v1.1.0-SHA256SUMS.txt`、`patchwarden-v1.5.0-SHA256SUMS.txt` → 加入 `.gitignore` |
| 规划文档 | 2 ?? | `docs/roadmap-execution-and-acceptance.md`、`docs/execution-plan-2026-07-09.md` → 是否入库由用户决定 |

**Dashboard UI 本体（9 M）**：`CHANGELOG.md`、`package.json`、`version.ts`、`scripts/checks/control-center-smoke.js`、`ui/pages/audit.html`、`ui/pages/dashboard.html`、`ui/pages/direct-sessions.html`、`ui/pages/task-detail.html`、`ui/pages/tasks.html`

**Dashboard docs（4 ??）**：`docs/dashboard-overview.md`、`docs/direct-session-workflow.md`、`docs/lineage-evidence-pack-workflow.md`、`docs/task-safe-review-workflow.md`（均被 README 新章节链接引用）

**async 重构链（16 M）**：`changeCapture.ts`、`runTask.ts`、`agentAssessor.ts`、`assessmentStore.ts`、`confirmCli.ts`、`createTask.ts`、`createDirectSession.ts`、`finalizeDirectSession.ts`、`goalSubgoalTask.ts`、`retryTask.ts`、`safeViews.ts`、`registry.ts`、`runTaskLoop.ts`、`smoke-test.ts`、`scripts/checks/lifecycle-smoke.js`、`src/test/unit/goal-subgoal-task.test.ts`

**并发任务执行特性（8 M）**：`config.ts`（新增 maxConcurrentTasks）、`watch.ts`（跨进程 lockfile + 并发执行 + executed-tasks.json）、6 个 unit test（command-guard / diagnose-task / reconcile-tasks / safe-status / sync-file / watcher-status，各加 1 行满足新必填字段）

**安全加固（4 M）**：`directGuards.ts`、`postTaskCleanup.ts`、`direct-guards.test.ts`、`path-guard.test.ts`

#### 关键风险

1. **async 重构是 v1.5.1 隐性依赖**：controlCenter.ts 的 v1.5.1 端点调用 async 函数，若排除 async 链则需回退这些端点，否则编译/运行断裂。
2. **README 版本号漏改**：第 11 行必须从 v1.5.0 改为 v1.5.1。
3. **AGENTS.md 含本机绝对路径**：`D:\ai_agent\CodexMemory` 不应入库。
4. **.gitignore 需扩充**：新增 `.trae/` 与 `patchwarden-v*-SHA256SUMS.txt` 通配规则。

#### 范围决策（待用户确定）

- 方案 A（推荐）：v1.5.1 = Dashboard UI(9) + async 重构链(16) + 安全加固(4) + 4 docs + 版本号修正；并发特性(8) 拆为 v1.5.2/v1.6.0；CHANGELOG 补 async 与安全修复说明。
- 方案 B：回退 controlCenter.ts 中依赖 async 的端点，只发纯 Dashboard UI。
- 方案 C：全部纳入（含并发特性），CHANGELOG 补全说明。

### P0-1 本地全套门禁

```powershell
npm.cmd ci
npm.cmd run build
npm.cmd run test:unit
npm.cmd run test:mcp
npm.cmd run test:http-mcp
npm.cmd run doctor:ci
npm.cmd run verify:package
npm.cmd test
npm.cmd run pack:clean
```

### P0-2 提交并推送（用户执行 push）

- 提交工作区修改到 `codex/patchwarden-v1.5.0`（或新建 `codex/patchwarden-v1.5.1`）
- 若 PR #24 落后 main：`git fetch origin main` + `git rebase origin/main`
- git credential 出错时修复 credential/proxy，**禁止 force-push 或 reset 绕过**

### P0-3 PR #24 推进（用户执行 merge）

- 标记 ready for review（仅本地门禁全绿后）
- 监控 GitHub Actions
- checks 绿时通过 PR 合并

### P0-4 发布（用户执行 release + publish）

- 创建 `v1.5.1` tag + GitHub Release（非 draft）
- 确认 npm auth 后发布（不暴露 token）

### P0 验收

```powershell
gh pr view 24 --repo jiezeng2004-design/PatchWarden --json state,mergeStateStatus,statusCheckRollup
gh release view v1.5.1 --repo jiezeng2004-design/PatchWarden --json tagName,name,isDraft,isPrerelease,publishedAt,url
npm.cmd view patchwarden version dist-tags --json --cache "$env:TEMP\patchwarden-npm-cache"
```

通过标准：PR 已合并 · Release `v1.5.1` 存在且非 draft · npm `version=1.5.1` · `dist-tags.latest=1.5.1` · 发布说明不夸大未验证内容。

### P0 风险

- 工作区修改可能混入非 v1.5.1 内容 → P0-0 逐文件核对
- README 第 11 行版本号待更新
- npm publish 需用户 credentialed 操作

## 3. P1-A：Evidence Pack v2

### 目标

把 Evidence Pack 从 2 文件升级为有界多文件结构，成为项目招牌能力。

### 当前差距

`src/tools/evidencePack.ts` 当前只写：

- `.patchwarden/evidence-packs/<lineage_id>/evidence.json`
- `.patchwarden/evidence-packs/<lineage_id>/EVIDENCE.md`

### v2 目标文件结构

| 文件 | 内容 |
| --- | --- |
| `risk.json` | 风险项与严重度 |
| `verify.json` | 每条验证命令的结构化记录 |
| `diffstat.json` | 文件级增删统计（非完整 diff） |
| `lineage.json` | lineage 有界摘要 |
| `attestation.json` | 版本/commit/Node/OS/tool profile/schema epoch |
| `redactions.json` | 脱敏类别与原因（**不存原始隐藏值**） |

### 执行步骤

1. 扩展 `SafeEvidencePack` 接口，新增 v2 文件字段
2. 在 `exportTaskEvidencePack` 中按文件逐个写入，保持有界
3. 更新 `src/tools/taskLineage.ts`、`src/tools/registry.ts`、`src/tools/toolRegistry.ts` 工具清单
4. 更新 `src/test/unit/evidence-pack.test.ts` 覆盖 v2 文件
5. 新增 `docs/evidence-pack-schema.md`（schema 参考）
6. 更新 `docs/lineage-evidence-pack-workflow.md` 补 v2 文件说明

### 实现红线

- 不含完整 stdout/stderr/diff/secrets/.env/token/cookie/凭据路径
- redactions 只存类别+原因，不存原值
- attestation 含 PatchWarden version、commit、package version、Node version、OS、tool profile、schema epoch
- `.patchwarden/evidence-packs/` 不得进入 npm 包（`package.json` 已排除 `.patchwarden/`）

### P1-A 验收

```powershell
npm.cmd run build
npm.cmd run test:unit
npm.cmd run doctor:ci
npm.cmd run verify:package
```

手动验收：跑一次 `run_task_loop` → `export_task_evidence_pack` → 确认 6 个 v2 文件存在 · `EVIDENCE.md` 可读有界 · `redactions.json` 无原始密钥 · npm 包不含 evidence-packs 输出。

## 4. P1-B：README 与公开文档就绪

### 目标

在外部 PR 引流前，让仓库对外部用户可读。

### 待补文档

| 文档 | 状态 | 说明 |
| --- | --- | --- |
| `docs/why-patchwarden.md` | 新建 | 定位与动机 |
| `docs/evidence-pack-schema.md` | 新建（与 P1-A 同步） | v2 schema 参考 |
| `docs/spec-kit-integration.md` | 新建 | Spec Kit 集成 |
| `docs/agentseal-integration.md` | 新建 | AgentSeal 集成 |
| `docs/mcp-inspector-testing.md` | 新建 | MCP Inspector 测试 |
| `docs/opencode-worker.md` | 新建 | OpenCode worker |
| `docs/openhands-worker.md` | 新建 | OpenHands worker |
| `docs/threat-model.md` | 已存在，更新 | 不重复创建 |

### README 前页需保留的 8 个章节

1. 一句定位
2. 架构图
3. 为何不是远程 shell
4. 五分钟 demo
5. Evidence Pack 样本
6. 支持的 agent
7. 安全边界
8. 生态适配

### P1-B 验收

```powershell
npm.cmd run build
npm.cmd run check:brand
npm.cmd run doctor:ci
npm.cmd run verify:package
```

通过标准：README 在 npm/GitHub 确认前不声称 v1.5.1 已发布 · 安全边界在外部集成之前讲解 · 示例用占位版本号除非有发布真相。

## 5. P2：外部 PR 批次 1（按风险递增顺序）

### P2-1 MCP Inspector（最先，最低风险）

- PR 形态：`docs: add CLI smoke testing example for MCP servers`
- 通用优先，PatchWarden 仅作示例之一
- 流程：clone inspector → 建 `docs/cli-smoke-testing-example` → 查上游贡献规则 → 仅改 docs → 跑上游 docs/lint/test → 推 fork 分支 → 开 PR → 监控 CI
- 验收：上游检查通过 · 无营销措辞 · 不依赖 PatchWarden 也能成立

### P2-2 AgentSeal（第二）

- PR 形态：`feat: detect PatchWarden MCP configs and project policies` 或 `docs: add guarded local agent execution pattern`
- 流程：clone agentseal → 建 `detect/patchwarden-policy` → 查 CONTRIBUTING + 现有 probes/tests → 选 code 或 docs 范围
- 验收：detector 识别 `.patchwarden/config.json` 和 `project-policy.json` 但不读密钥 · 正负 fixture 测试 · 描述通用安全模式非营销

### P2-3 PatchWarden 兼容文档（第三）

- 新增 `docs/mcp-inspector-testing.md`、`docs/agentseal-integration.md`
- 验收：Windows PowerShell 可运行 · 文档链接到真实上游 PR/issue

## 6. P2：外部 PR 批次 2

### Spec Kit（在 Evidence Pack v2 之后）

- 前置依赖：**P1-A 完成**（需要稳定 evidence schema）
- PR 形态：`docs: add evidence pack pattern for spec-driven development` 或 `walkthrough: verify implemented tasks with an external MCP safety layer`
- 流程：clone spec-kit → 建 `docs/evidence-verification-pattern`
- 验收：PR 映射 spec→tasks→implementation→evidence verification · PatchWarden 仅作示例实现 · 上游 docs 检查通过

## 7. P3：外部 PR 批次 3（最后，需已发布 evidence 可引用）

### OpenCode / OpenHands / Aider

- **OpenCode**：流量大、repo 大，先 docs-only external supervisor pattern
- **OpenHands**：源码归属在迁移，先查当前 repo 结构再选目标
- **Aider**：成熟 CLI，safe wrapper pattern 有用但应在 PatchWarden 有发布示例之后
- 每个 PR 验收：查上游贡献规则 · 不依赖 PatchWarden 也能用 · CI 或文档化本地检查通过 · PatchWarden README 仅在 PR 存在后回链

## 8. Issue Backlog（P0 发布真相干净后创建）

1. `fix: close v1.5.1 release truth gap`
2. `feat: add Evidence Pack v2 artifact schema`
3. `docs: add Evidence Pack v2 schema reference`
4. `feat: export goal final report`
5. `feat: import Spec Kit tasks into Goal Session`
6. `docs: add MCP Inspector CLI smoke testing guide`
7. `docs: add AgentSeal compatibility guide`
8. `docs: add OpenCode worker integration guide`
9. `docs: add OpenHands worker integration guide`
10. `docs: add external PR roadmap and ecosystem compatibility matrix`

## 9. 全局验收规则

### 每个内部 PatchWarden PR

```powershell
npm.cmd run build
npm.cmd run test:unit
npm.cmd run test:mcp
npm.cmd run test:http-mcp
npm.cmd run doctor:ci
npm.cmd run verify:package
```

### 发布前追加

```powershell
npm.cmd ci
npm.cmd test
npm.cmd run pack:clean
gh pr checks <PR_NUMBER> --repo jiezeng2004-design/PatchWarden --watch
gh release view v<version> --repo jiezeng2004-design/PatchWarden --json tagName,isDraft,publishedAt,url
npm.cmd view patchwarden version dist-tags --json --cache "$env:TEMP\patchwarden-npm-cache"
```

**铁律**：GitHub Release 与 npm registry 真相都匹配目标版本前，绝不标记发布完成。

## 10. 执行顺序与依赖

```
P0-0 逐文件核对 → P0-1 门禁 → P0-2 提交推送(用户) → P0-3 PR(用户) → P0-4 发布(用户)
                                                                       │
                                                                       v
                                                                 P1-A Evidence Pack v2
                                                                       │
                                                         P1-B docs ───┤
                                                                       v
                                                       P2-1 Inspector → P2-2 AgentSeal → P2-3 兼容文档
                                                                       │
                                                                       v
                                                                 P2 Spec Kit (依赖 P1-A)
                                                                       │
                                                                       v
                                                       P3 OpenCode / OpenHands / Aider
```

## 11. 安全边界（贯穿全阶段）

- 不暴露通用远程 shell，不弱化精确命令匹配
- 所有 repo 路径在 `workspaceRoot` 内，阻止敏感名与越界改动
- 不读取或持久化 token/cookie/浏览器状态/.env/SSH 密钥/凭据文件
- 不 blanket-kill watcher/tunnel，仅监督 launcher 拥有的进程
- live tunnel/watcher 切换与本地代码验证分开，不重启 live 服务除非显式要求
- 保留结构化任务证据、心跳状态、前后 Git 快照、变更文件记录与脱敏
