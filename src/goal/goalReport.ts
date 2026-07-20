/**
 * Goal 最终报告导出 — 将 Goal 完成情况渲染为人类可读 Markdown 和机器可读 JSON。
 *
 * exportGoalReport 读取 GoalStatus 和进度统计，关联 Evidence Pack，
 * 生成 REPORT.md 和 report.json 到 {workspaceRoot}/.patchwarden/goals/{goalId}/report/。
 * 所有写入操作使用原子写（.tmp + rename），所有字符串内容经 redactSensitiveValue 脱敏。
 */

import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { getConfig } from "../config.js";
import { redactSensitiveValue } from "../security/contentRedaction.js";
import { listEvidencePacks } from "../tools/tasks/evidencePack.js";
import { atomicWriteFileSync } from "../utils/atomicFile.js";
import { summarizeGoalProgress, type GoalProgressSummary } from "./goalProgress.js";
import { readGoalStatus } from "./goalStore.js";

// ── 类型定义 ──────────────────────────────────────────────────────

export interface SubgoalReportEntry {
  id: string;
  title: string;
  status: string;
  task_ids: string[];
  evidence_packs: string[];
  accepted_at?: string;
  rejected_reason?: string;
}

export interface SafeGoalReport {
  goal_id: string;
  generated_at: string;
  path: string;
  completion_rate: number;
  files: { report_md: string; report_json: string };
  summary: GoalProgressSummary;
  subgoals: SubgoalReportEntry[];
  risks: string[];
  timeline: { created_at: string; updated_at: string; status: string };
  bounded: true;
}

// ── 辅助函数 ──────────────────────────────────────────────────────

function resolveWorkspaceRoot(workspaceRoot?: string): string {
  return workspaceRoot ?? getConfig().workspaceRoot;
}

/**
 * 将百分比字符串（如 "100%"）解析为数字。
 */
function parseCompletionRate(value: string): number {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 查找与 task_ids 关联的 Evidence Pack 路径。
 * 通过 listEvidencePacks 列出所有 pack，匹配 lineage_id 在 task_ids 中的 pack。
 */
function collectEvidencePacks(taskIds: string[]): string[] {
  if (taskIds.length === 0) return [];
  const packs = listEvidencePacks({ max_items: 50 });
  const taskIdSet = new Set(taskIds);
  const paths: string[] = [];
  for (const pack of packs.evidence_packs) {
    if (taskIdSet.has(pack.lineage_id)) {
      paths.push(pack.path);
    }
  }
  return paths;
}

// ── Markdown 生成 ─────────────────────────────────────────────────

/**
 * 从脱敏后的报告对象生成人类可读 Markdown。
 */
function buildReportMarkdown(
  report: SafeGoalReport,
  flags: { noSubgoals: boolean; incomplete: boolean }
): string {
  const lines: string[] = [];

  // 标题
  lines.push("# Goal Report: " + report.summary.title);
  lines.push("");

  // 元信息
  lines.push("## 元信息");
  lines.push("");
  lines.push("- **goal_id**: " + report.goal_id);
  lines.push("- **generated_at**: " + report.generated_at);
  lines.push("- **status**: " + report.timeline.status);
  lines.push("- **completion_rate**: " + report.completion_rate + "%");
  if (flags.noSubgoals) {
    lines.push("- **备注**: 无子目标");
  }
  if (flags.incomplete) {
    lines.push("- **备注**: 未完成");
  }
  lines.push("");

  // 完成度统计表
  lines.push("## 完成度统计");
  lines.push("");
  lines.push("| 指标 | 数值 |");
  lines.push("| --- | --- |");
  lines.push("| total | " + report.summary.total + " |");
  lines.push("| accepted | " + report.summary.accepted + " |");
  lines.push("| rejected | " + report.summary.rejected + " |");
  lines.push("| running | " + report.summary.running + " |");
  lines.push("| ready | " + report.summary.ready + " |");
  lines.push("| needs_fix | " + report.summary.needs_fix + " |");
  lines.push("");

  // 子目标清单
  lines.push("## 子目标清单");
  lines.push("");
  if (report.subgoals.length === 0) {
    lines.push("无子目标");
    lines.push("");
  } else {
    for (const sg of report.subgoals) {
      lines.push("### " + sg.id + ": " + sg.title);
      lines.push("");
      lines.push("- **status**: " + sg.status);
      lines.push(
        "- **task_ids**: " + (sg.task_ids.length > 0 ? sg.task_ids.join(", ") : "无")
      );
      lines.push(
        "- **evidence_packs**: " +
          (sg.evidence_packs.length > 0 ? sg.evidence_packs.join(", ") : "无")
      );
      if (sg.accepted_at) {
        lines.push("- **accepted_at**: " + sg.accepted_at);
      }
      if (sg.rejected_reason) {
        lines.push("- **rejected_reason**: " + sg.rejected_reason);
      }
      lines.push("");
    }
  }

  // 风险汇总
  lines.push("## 风险汇总");
  lines.push("");
  if (report.risks.length === 0) {
    lines.push("无");
  } else {
    for (const r of report.risks) {
      lines.push("- " + r);
    }
  }
  lines.push("");

  // 时间线
  lines.push("## 时间线");
  lines.push("");
  lines.push("- **created_at**: " + report.timeline.created_at);
  lines.push("- **updated_at**: " + report.timeline.updated_at);
  lines.push("");

  return lines.join("\n");
}

// ── 公共 API ──────────────────────────────────────────────────────

/**
 * 导出 Goal 最终报告，生成 REPORT.md 和 report.json。
 *
 * 流程：
 *   1. 读取 GoalStatus（readGoalStatus）
 *   2. 调用 summarizeGoalProgress 获取完成度统计
 *   3. 遍历 subgoals，构建 SubgoalReportEntry，关联 Evidence Pack
 *   4. 生成 REPORT.md（人类可读）和 report.json（机器可读）
 *   5. 原子写到 {workspaceRoot}/.patchwarden/goals/{goalId}/report/
 *   6. 所有字符串内容经 redactSensitiveValue 脱敏
 *
 * @param goalId   Goal 标识
 * @param options  可选配置（workspaceRoot：工作区根目录，默认从 getConfig 获取）
 * @returns SafeGoalReport（脱敏后的报告对象）
 */
export function exportGoalReport(
  goalId: string,
  options?: { workspaceRoot?: string }
): SafeGoalReport {
  const workspaceRoot = resolveWorkspaceRoot(options?.workspaceRoot);
  const goalStatus = readGoalStatus(goalId, workspaceRoot);
  const summary = summarizeGoalProgress(goalId, workspaceRoot);
  const generatedAt = new Date().toISOString();

  const noSubgoals = goalStatus.subgoals.length === 0;
  const hasIncomplete = goalStatus.subgoals.some(
    (s) => s.status === "running" || s.status === "ready"
  );
  const incomplete = goalStatus.status === "active" && hasIncomplete;

  // 构建 subgoal 报告条目
  const subgoalEntries: SubgoalReportEntry[] = goalStatus.subgoals.map((sg) => {
    const entry: SubgoalReportEntry = {
      id: sg.id,
      title: sg.title,
      status: sg.status,
      task_ids: [...sg.task_ids],
      evidence_packs: collectEvidencePacks(sg.task_ids),
    };
    if (sg.accepted_at) entry.accepted_at = sg.accepted_at;
    if (sg.rejected_reason) entry.rejected_reason = sg.rejected_reason;
    return entry;
  });

  // 风险汇总
  const risks: string[] = summary.risks.map(
    (r) => r.subgoal_id + " (" + r.status + "): " + r.reason
  );
  if (incomplete) {
    risks.push("未完成：Goal 仍有 running/ready 子目标");
  }

  // 报告目录
  const reportDir = resolve(
    workspaceRoot,
    ".patchwarden",
    "goals",
    goalId,
    "report"
  );
  mkdirSync(reportDir, { recursive: true });

  const reportMdPath = join(reportDir, "REPORT.md");
  const reportJsonPath = join(reportDir, "report.json");

  // 构建原始报告对象
  const rawReport: SafeGoalReport = {
    goal_id: goalStatus.goal_id,
    generated_at: generatedAt,
    path: reportDir,
    completion_rate: noSubgoals ? 0 : parseCompletionRate(summary.completion_rate),
    files: { report_md: reportMdPath, report_json: reportJsonPath },
    summary,
    subgoals: subgoalEntries,
    risks,
    timeline: {
      created_at: goalStatus.created_at,
      updated_at: goalStatus.updated_at,
      status: goalStatus.status,
    },
    bounded: true,
  };

  // 脱敏所有字符串内容
  const safeReport = redactSensitiveValue(rawReport).value as SafeGoalReport;

  // 原子写 JSON（机器可读）
  atomicWriteFileSync(reportJsonPath, JSON.stringify(safeReport, null, 2) + "\n");

  // 原子写 Markdown（人类可读，从脱敏后的对象生成）
  const markdown = buildReportMarkdown(safeReport, { noSubgoals, incomplete });
  atomicWriteFileSync(reportMdPath, markdown);

  return safeReport;
}
