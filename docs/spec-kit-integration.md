# Spec Kit 集成模式

> 本文基于 v1.5.1 源码编写；安装时请使用已验证发布的 <published-version>。
> 说明：本文描述的是 PatchWarden 与 Spec Kit 的集成模式建议，**不是** Spec Kit 的官方功能。
> Spec Kit 是 GitHub 维护的独立项目，本文不声称任何官方集成关系。

## Spec Kit 是什么

Spec Kit 是 GitHub 推出的 spec-driven development（规格驱动开发）工具集，
用于在代码实现之前先定义、版本化、验证规格（spec）。典型流程为：

1. **Spec**：用结构化方式描述功能需求与验收标准。
2. **Tasks**：将 spec 拆解为可执行的任务列表。
3. **Implementation**：由人或 Agent 执行任务。
4. **Verification**：根据 spec 的验收标准验证实现结果。

Spec Kit 的核心价值在于把“要做什么”与“怎么做”显式分离，让验收有据可依。

## PatchWarden 在 Spec Kit 流程中的位置

PatchWarden 不替代 Spec Kit 的规格定义能力，而是承担 Spec Kit 流程中
“Implementation”与“Verification”两个阶段的**安全执行与证据收集**角色：

```
Spec Kit: spec → tasks → implementation → verification
                              ↑                ↑
                              PatchWarden 在此执行并产出 Evidence Pack v2
```

- **Implementation 阶段**：PatchWarden 以 MCP 安全桥接器身份接收任务，
  在 workspace 隔离、命令允许列表、范围违规检测下执行。
- **Verification 阶段**：PatchWarden 导出 Evidence Pack v2，作为 spec
  验收的结构化证据。

## Evidence Pack v2 作为 spec 验收证据

Spec Kit 的验收标准通常是自然语言描述。PatchWarden 的 Evidence Pack v2
提供机器可读的对应物，便于自动化对齐：

| Evidence Pack 文件 | Spec 验收对应物 |
| --- | --- |
| `evidence.json` | 任务整体证据，含 lineage、policy、catalog 摘要 |
| `EVIDENCE.md` | 人类可读摘要，便于 spec reviewer 阅读 |
| `risk.json` | 实现过程中识别的风险项，对应 spec 的风险条款 |
| `verify.json` | 每轮迭代的结构化验证记录 |
| `diffstat.json` | 文件级改动统计，对应 spec 声明的改动范围 |
| `lineage.json` | 任务谱系，证明实现源自哪条 spec task |
| `attestation.json` | 任务签名与证明 |
| `redactions.json` | 已脱敏内容清单 |

## 集成流程示例

### 1. 在 Spec Kit 中定义 spec 与 tasks

在 Spec Kit 仓库中编写 spec 与 task 清单，例如：

```json
{
  "spec": "add-rate-limit-middleware",
  "tasks": [
    { "id": "T1", "desc": "implement rate limiter", "files": ["src/middleware/rate.ts"] },
    { "id": "T2", "desc": "add tests", "files": ["test/middleware/rate.test.ts"] }
  ],
  "acceptance": ["T1 passes", "T2 passes", "no changes outside declared files"]
}
```

### 1.5 批量导入 Spec Kit tasks 为 PatchWarden subgoal

PatchWarden 提供 `import_speckit_tasks` 工具，可将 Spec Kit 的 tasks 批量导入为 Goal 下的 subgoal：

- 每个 Spec Kit task 创建一个对应 subgoal，title 取自 task.desc
- task.files 映射为 subgoal 的 scope_hints（声明改动范围提示）
- task.depends_on 映射为 subgoal 间的依赖关系
- Spec Kit 的 acceptance[] 存入 Goal 的 acceptance_criteria 字段
- 支持幂等导入：重复导入同一 Spec Kit JSON 不会创建重复 subgoal

### 2. 通过 PatchWarden 执行任务

将 Spec Kit 的 task 通过 MCP 客户端交给 PatchWarden：

```powershell
# 假设 PatchWarden MCP server 已启动
# MCP 客户端调用 PatchWarden 工具，传入 task 描述与声明的文件范围
```

PatchWarden 会在执行时：

- 校验改动是否仅在 `src/middleware/rate.ts` 与 `test/middleware/rate.test.ts`。
- 阻断任何越界文件改动或未注册命令。
- 在每轮迭代后记录结构化验证。

### 3. 导出 Evidence Pack 并与 spec 对齐

任务完成后导出 Evidence Pack v2：

```powershell
# 通过 MCP 工具 export_task_evidence_pack 导出
# 产物位于 .patchwarden/evidence-packs/<lineage_id>/
```

随后可用脚本将 `diffstat.json` 与 spec 声明的 `files` 对齐，
将 `verify.json` 与 spec `acceptance` 对齐。

### 4. Spec 验收

reviewer 阅读 `EVIDENCE.md` 与 `verify.json`，
确认实现满足 spec 验收标准后标记 spec 为已验收。

## 配置要点

- PatchWarden 的 `workspaceRoot` 应覆盖 Spec Kit 仓库根目录。
- Spec Kit 的 task 中声明的文件范围应与 PatchWarden Project Policy 的
  allowed paths 一致，避免执行时被范围违规检测阻断。
- Evidence Pack v2 的 `lineage.json` 可用于回溯到 Spec Kit 的 task id，
  建议在任务描述中包含 Spec Kit task id。

## 边界与注意事项

- PatchWarden 不解析 Spec Kit 的 spec 格式本身，只处理 tasks 与 acceptance 字段并产出证据。
- Spec Kit 的 spec 验收逻辑由 Spec Kit 自身或 reviewer 负责，
  PatchWarden 只提供证据材料。
- 本集成模式不修改 Spec Kit 的任何行为，仅在流程上配合使用。
- 如 Spec Kit task 要求读取 `.env` 或敏感文件，PatchWarden 会按安全契约阻断，
  此时需要重新设计 task 以避免触碰敏感资源。

## 相关文档

- `docs/evidence-pack-schema.md`：Evidence Pack v2 文件结构。
- `docs/threat-model.md`：PatchWarden 安全契约。
- `docs/why-patchwarden.md`：PatchWarden 定位与动机。
