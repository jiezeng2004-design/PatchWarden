import { afterEach, beforeEach, describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reloadConfig } from "../../../config.js";
import { listAgents } from "../../../tools/workspace/listAgents.js";

let tempDir: string;
let previousConfig: string | undefined;

describe("listAgents invocation preflight", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pw-list-agents-"));
    previousConfig = process.env.PATCHWARDEN_CONFIG;
  });

  afterEach(() => {
    if (previousConfig === undefined) delete process.env.PATCHWARDEN_CONFIG;
    else process.env.PATCHWARDEN_CONFIG = previousConfig;
    reloadConfig();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("marks Node plus a native executable as not invocation-ready", () => {
    const nativeEntry = join(tempDir, "claude.exe");
    const configPath = join(tempDir, "patchwarden.config.json");
    writeFileSync(nativeEntry, "not a real executable", "utf-8");
    writeFileSync(configPath, JSON.stringify({
      workspaceRoot: tempDir,
      tasksDir: ".patchwarden/tasks",
      plansDir: ".patchwarden/plans",
      assessmentsDir: ".patchwarden/assessments",
      agents: {
        claude: {
          adapter: "claude",
          command: process.execPath,
          args: [nativeEntry, "--model", "claude-test", "{prompt}"],
          model: "claude-test",
        },
      },
      allowedTestCommands: ["npm test"],
    }), "utf-8");
    process.env.PATCHWARDEN_CONFIG = configPath;
    reloadConfig();

    const claude = listAgents().agents.find((agent) => agent.name === "claude");
    assert.equal(claude?.available, true);
    assert.equal(claude?.model_argument_present, true);
    assert.equal(claude?.invocation_ready, false);
    assert.match(claude?.reason || "", /\.exe through Node/i);
  });

  it("keeps an Agent without a model override ready while reporting no model argument", () => {
    const configPath = join(tempDir, "patchwarden.config.json");
    writeFileSync(configPath, JSON.stringify({
      workspaceRoot: tempDir,
      tasksDir: ".patchwarden/tasks",
      plansDir: ".patchwarden/plans",
      assessmentsDir: ".patchwarden/assessments",
      agents: {
        codex: {
          adapter: "codex",
          command: process.execPath,
          args: ["-e", "process.exit(0)", "{prompt}"],
        },
      },
      allowedTestCommands: ["npm test"],
    }), "utf-8");
    process.env.PATCHWARDEN_CONFIG = configPath;
    reloadConfig();

    const codex = listAgents().agents.find((agent) => agent.name === "codex");
    assert.equal(codex?.model, null);
    assert.equal(codex?.model_argument_present, false);
    assert.equal(codex?.invocation_ready, true);
  });
});
