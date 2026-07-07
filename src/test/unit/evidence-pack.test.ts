import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { reloadConfig } from "../../config.js";
import { recommendAgentForTask } from "../../tools/recommendAgentForTask.js";
import { exportTaskEvidencePack, listEvidencePacks, readEvidencePack } from "../../tools/evidencePack.js";
import { writeTaskLineage } from "../../tools/taskLineage.js";

let tempDir: string;
let prevConfigEnv: string | undefined;

function writeConfig() {
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

describe("v1.5 evidence packs and agent recommendations", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pw-evidence-"));
    writeConfig();
  });

  afterEach(() => {
    if (prevConfigEnv === undefined) delete process.env.PATCHWARDEN_CONFIG;
    else process.env.PATCHWARDEN_CONFIG = prevConfigEnv;
    reloadConfig();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("recommends an agent without creating task evidence", () => {
    const recommendation = recommendAgentForTask({
      repo_path: ".",
      goal: "Refactor two modules safely",
      scope_files: ["src/a.ts", "src/b.ts"],
    });

    assert.equal(recommendation.bounded, true);
    assert.ok(["codex", "opencode"].includes(recommendation.recommended_agent));
    assert.ok(Array.isArray(recommendation.suggested_verify_commands));
    const payload = JSON.stringify(recommendation);
    assert.ok(!payload.includes("stdout"));
    assert.ok(!payload.includes("stderr"));
    assert.ok(!payload.includes("diff"));
  });

  it("exports bounded BOM-free evidence pack from lineage", () => {
    writeTaskLineage({
      lineage_id: "lineage_v15_pack",
      goal: "Export evidence",
      repo_path: ".",
      created_at: "2026-07-05T12:00:00.000Z",
      updated_at: "2026-07-05T12:01:00.000Z",
      final_status: "accepted",
      stop_reason: "success",
      next_action: "accept",
      main_task: "task-main",
      fix_tasks: [],
      cleanup_tasks: [],
      direct_sessions: [{
        session_id: "direct-one",
        status: "passed",
        command_count: 1,
        passed_commands: 1,
        failed_commands: 0,
        timed_out_commands: 0,
        audit_decision: "pass",
        changed_files_total: 0,
        next_action: "accept",
      }],
      rounds: [{
        iteration: 1,
        task_id: "task-main",
        role: "main",
        status: "done_by_agent",
        terminal: true,
        verification_status: "passed",
        audit_verdict: "pass",
        fail_checks: [],
        warn_checks: [],
        next_action: "accept",
      }],
      warnings: [],
      errors: [],
      worktree: {
        isolation_mode: "worktree",
        worktree_id: "wt-one",
        worktree_path: join(tempDir, "_workspacetrees", "wt-one"),
        branch: "pw-test",
        cleanup: "keep",
        status: "active",
        next_action: "merge or discard explicitly",
      },
      agent_routing: {
        requested_agent: "auto",
        selected_agent: "codex",
        reason: "test route",
        fallback: false,
      },
    });

    const pack = exportTaskEvidencePack({ lineage_id: "lineage_v15_pack" });
    assert.equal(pack.bounded, true);
    assert.equal(pack.lineage.worktree.worktree_id, "wt-one");
    assert.equal(pack.lineage.agent_routing?.selected_agent, "codex");
    const raw = readFileSync(pack.files.json);
    assert.notEqual(raw[0], 0xef);
    JSON.parse(raw.toString("utf-8"));

    const payload = JSON.stringify(pack);
    assert.ok(!payload.includes("stdout_tail"));
    assert.ok(!payload.includes("stderr_tail"));
    assert.ok(!payload.includes("diff.patch"));
    assert.ok(!payload.includes("verification.log"));

    const readBack = readEvidencePack("lineage_v15_pack");
    assert.equal(readBack?.lineage_id, "lineage_v15_pack");
    const listed = listEvidencePacks();
    assert.equal(listed.total, 1);
    assert.equal(listed.evidence_packs[0].lineage_id, "lineage_v15_pack");
  });
});
