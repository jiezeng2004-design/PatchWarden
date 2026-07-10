import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { reloadConfig } from "../../config.js";
import { exportGoalReport } from "../../goal/goalReport.js";
import { getGoalDir, writeGoalStatus } from "../../goal/goalStore.js";
import type { GoalStatus, Subgoal } from "../../goal/goalStatus.js";

// ── Helpers ───────────────────────────────────────────────────────

function makeSubgoal(overrides: Partial<Subgoal> & { id: string }): Subgoal {
  return {
    title: "Subgoal " + overrides.id,
    status: "ready",
    depends_on: [],
    task_ids: [],
    ...overrides,
  };
}

function makeGoalStatus(subgoals: Subgoal[], overrides: Partial<GoalStatus> = {}): GoalStatus {
  const now = "2026-07-10T00:00:00.000Z";
  return {
    goal_id: "goal_test_001",
    title: "Test Goal",
    status: "active",
    repo_path: "/repo/test",
    created_at: now,
    updated_at: now,
    subgoals,
    ...overrides,
  };
}

let tempDir: string;
let prevConfigEnv: string | undefined;

function writeConfig(): void {
  const configPath = join(tempDir, "patchwarden.config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      workspaceRoot: tempDir,
      tasksDir: ".patchwarden/tasks",
      plansDir: ".patchwarden/plans",
      assessmentsDir: ".patchwarden/assessments",
      agents: {
        codex: { command: "codex", args: [] },
        opencode: { command: "opencode", args: [] },
      },
      allowedTestCommands: ["npm test", "npm run build"],
      defaultTaskTimeoutSeconds: 30,
      maxTaskTimeoutSeconds: 120,
    }),
    "utf-8"
  );
  prevConfigEnv = process.env.PATCHWARDEN_CONFIG;
  process.env.PATCHWARDEN_CONFIG = configPath;
  reloadConfig();
}

/**
 * 创建 goal 目录并写入 goal_status.json（writeGoalStatus 不自动创建目录）。
 */
function seedGoalStatus(goalId: string, status: GoalStatus, workspaceRoot: string): void {
  mkdirSync(getGoalDir(goalId, workspaceRoot), { recursive: true });
  writeGoalStatus(goalId, status, workspaceRoot);
}

// ── Tests ─────────────────────────────────────────────────────────

describe("goalReport", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pw-goal-report-"));
    writeConfig();
  });

  afterEach(() => {
    if (prevConfigEnv === undefined) delete process.env.PATCHWARDEN_CONFIG;
    else process.env.PATCHWARDEN_CONFIG = prevConfigEnv;
    reloadConfig();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("完成 Goal 报告：所有 subgoal accepted，completion_rate=100", () => {
    const goal = makeGoalStatus([
      makeSubgoal({
        id: "subgoal-001",
        title: "Feature A",
        status: "accepted",
        accepted_at: "2026-07-01T00:00:00.000Z",
      }),
      makeSubgoal({
        id: "subgoal-002",
        title: "Feature B",
        status: "accepted",
        accepted_at: "2026-07-02T00:00:00.000Z",
      }),
    ], { goal_id: "goal_done_001" });
    seedGoalStatus("goal_done_001", goal, tempDir);

    const report = exportGoalReport("goal_done_001", { workspaceRoot: tempDir });

    assert.equal(report.completion_rate, 100);
    assert.equal(report.goal_id, "goal_done_001");
    assert.equal(report.subgoals.length, 2);
    assert.equal(report.bounded, true);
    assert.ok(existsSync(report.files.report_md));
    assert.ok(existsSync(report.files.report_json));
  });

  it("未完成 Goal 报告：有 running/ready subgoal，报告含 '未完成'", () => {
    const goal = makeGoalStatus([
      makeSubgoal({
        id: "subgoal-001",
        title: "Done",
        status: "accepted",
        accepted_at: "2026-07-01T00:00:00.000Z",
      }),
      makeSubgoal({ id: "subgoal-002", title: "WIP", status: "running" }),
    ]);
    seedGoalStatus("goal_wip_001", goal, tempDir);

    const report = exportGoalReport("goal_wip_001", { workspaceRoot: tempDir });

    const md = readFileSync(report.files.report_md, "utf-8");
    assert.ok(md.includes("未完成"), "REPORT.md should contain '未完成' annotation");
    assert.ok(
      report.risks.some((r) => r.includes("未完成")),
      "risks array should contain '未完成' entry"
    );
  });

  it("空 Goal 报告：无 subgoal，completion_rate=0，报告含 '无子目标'", () => {
    const goal = makeGoalStatus([]);
    seedGoalStatus("goal_empty_001", goal, tempDir);

    const report = exportGoalReport("goal_empty_001", { workspaceRoot: tempDir });

    assert.equal(report.completion_rate, 0);
    const md = readFileSync(report.files.report_md, "utf-8");
    assert.ok(md.includes("无子目标"), "REPORT.md should contain '无子目标' annotation");
  });

  it("双格式输出：REPORT.md 和 report.json 同时存在", () => {
    const goal = makeGoalStatus([
      makeSubgoal({
        id: "subgoal-001",
        title: "Task A",
        status: "accepted",
        accepted_at: "2026-07-01T00:00:00.000Z",
      }),
    ]);
    seedGoalStatus("goal_dual_001", goal, tempDir);

    const report = exportGoalReport("goal_dual_001", { workspaceRoot: tempDir });

    const reportDir = resolve(tempDir, ".patchwarden", "goals", "goal_dual_001", "report");
    const mdPath = join(reportDir, "REPORT.md");
    const jsonPath = join(reportDir, "report.json");
    assert.ok(existsSync(mdPath), "REPORT.md should exist");
    assert.ok(existsSync(jsonPath), "report.json should exist");
    assert.equal(report.files.report_md, mdPath);
    assert.equal(report.files.report_json, jsonPath);
  });

  it("脱敏验证：subgoal title 含敏感信息，输出中不含原始值", () => {
    const goal = makeGoalStatus([
      makeSubgoal({
        id: "subgoal-001",
        title: "Deploy with token=abcd1234",
        status: "accepted",
        accepted_at: "2026-07-01T00:00:00.000Z",
      }),
    ]);
    seedGoalStatus("goal_redact_001", goal, tempDir);

    const report = exportGoalReport("goal_redact_001", { workspaceRoot: tempDir });

    const md = readFileSync(report.files.report_md, "utf-8");
    const json = readFileSync(report.files.report_json, "utf-8");
    assert.ok(!md.includes("abcd1234"), "REPORT.md must not contain raw secret value");
    assert.ok(!json.includes("abcd1234"), "report.json must not contain raw secret value");
    assert.ok(md.includes("[REDACTED]"), "REPORT.md should contain redaction marker");
    assert.ok(json.includes("[REDACTED]"), "report.json should contain redaction marker");
  });
});
