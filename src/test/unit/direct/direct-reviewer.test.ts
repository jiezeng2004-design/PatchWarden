import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { reloadConfig, type PatchWardenConfig } from "../../../config.js";
import { runDirectReviewer } from "../../../direct/directReviewer.js";

describe("runDirectReviewer fail-closed process handling", () => {
  let root: string;
  let repoPath: string;
  let config: PatchWardenConfig;
  const originalConfigPath = process.env.PATCHWARDEN_CONFIG;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "patchwarden-direct-reviewer-"));
    repoPath = join(root, "repo");
    mkdirSync(repoPath, { recursive: true });
    writeFileSync(join(repoPath, "baseline.txt"), "baseline\n", "utf-8");

    const scripts = join(root, "scripts");
    mkdirSync(scripts, { recursive: true });
    writeScript(scripts, "allow.cjs", `console.log("===DIRECT_REVIEW_JSON===\\n" + JSON.stringify({risk_level:"low",reason_codes:["scoped"],confidence:0.95,notes:"allow"}));`);
    writeScript(scripts, "parse.cjs", `console.log("not structured review output");`);
    writeScript(scripts, "nonzero.cjs", `process.exit(7);`);
    writeScript(scripts, "timeout.cjs", `setTimeout(() => {}, 5000);`);
    writeScript(scripts, "mutate.cjs", `require("node:fs").writeFileSync("reviewer-mutated.txt", "changed"); console.log("===DIRECT_REVIEW_JSON===\\n" + JSON.stringify({risk_level:"low",reason_codes:[],confidence:1,notes:"allow"}));`);
    writeScript(scripts, "mutate-sensitive.cjs", `require("node:fs").writeFileSync(".env", "DO_NOT_READ=this-is-reviewer-created"); console.log("===DIRECT_REVIEW_JSON===\\n" + JSON.stringify({risk_level:"low",reason_codes:[],confidence:1,notes:"allow"}));`);
    writeScript(scripts, "mutate-ephemeral.cjs", `const fs=require("node:fs"); fs.writeFileSync("temporary.txt", "changed"); fs.rmSync("temporary.txt"); console.log("===DIRECT_REVIEW_JSON===\\n" + JSON.stringify({risk_level:"low",reason_codes:[],confidence:1,notes:"allow"}));`);
    writeScript(scripts, "truncated.cjs", `process.stdout.write("x".repeat(256) + "===DIRECT_REVIEW_JSON===\\n" + JSON.stringify({risk_level:"low",reason_codes:[],confidence:1,notes:"allow"}));`);
    writeScript(scripts, "isolation.cjs", `
const fs = require("node:fs");
const path = require("node:path");
const promptFile = process.argv[2];
const repoArgument = process.argv[3];
const prompt = fs.readFileSync(promptFile, "utf-8");
const isolated = process.cwd() === repoArgument
  && path.dirname(promptFile) === process.cwd()
  && !prompt.toLowerCase().includes(${JSON.stringify(repoPath.toLowerCase())})
  && prompt.includes("[REDACTED");
console.log("===DIRECT_REVIEW_JSON===\\n" + JSON.stringify({
  risk_level: isolated ? "low" : "high",
  reason_codes: [isolated ? "isolated" : "repo_exposed"],
  confidence: 1,
  notes: process.cwd()
}));`);

    const agents = Object.fromEntries(
      ["allow", "parse", "nonzero", "timeout", "mutate", "mutate-sensitive", "mutate-ephemeral", "truncated"].map((name) => [name, {
        command: process.execPath,
        args: [join(scripts, `${name}.cjs`), "{prompt_file}"],
      }]),
    );
    agents.isolation = {
      command: process.execPath,
      args: [join(scripts, "isolation.cjs"), "{prompt_file}", "{repo}"],
    };
    agents.leak = {
      command: process.execPath,
      args: [join(scripts, "allow.cjs"), repoPath, "{prompt_file}"],
    };
    const configPath = join(root, "patchwarden.config.json");
    writeFileSync(configPath, JSON.stringify({ workspaceRoot: root, agents }), "utf-8");
    process.env.PATCHWARDEN_CONFIG = configPath;
    config = reloadConfig(configPath);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (originalConfigPath === undefined) delete process.env.PATCHWARDEN_CONFIG;
    else process.env.PATCHWARDEN_CONFIG = originalConfigPath;
    reloadConfig();
  });

  it("accepts only bounded structured output from a read-only reviewer", async () => {
    const result = await reviewWith("allow");
    assert.equal(result.status, "completed");
    assert.equal(result.risk_level, "low");
    assert.equal(result.confidence, 0.95);
    assert.deepEqual(result.reason_codes, ["scoped"]);
  });

  it("runs in an owned temporary sandbox without exposing repoPath and removes it afterward", async () => {
    const result = await reviewWith("isolation", 5, 16_384, {
      content_preview: "api_key=abcdefghijklmnop and repo " + repoPath,
      summary: "Review " + repoPath,
      affected_paths: [repoPath + "\\src\\new-dir"],
    });
    assert.equal(result.status, "completed");
    assert.equal(result.risk_level, "low");
    assert.deepEqual(result.reason_codes, ["isolated"]);
    assert.match(result.notes, /patchwarden-direct-review-/);
    assert.equal(existsSync(result.notes), false, "owned reviewer sandbox must be removed");
  });

  it("rejects a configured invocation that embeds the real repository path", async () => {
    const result = await reviewWith("leak");
    assert.equal(result.status, "spawn_failed");
    assert.deepEqual(result.reason_codes, ["reviewer_invocation_failed"]);
  });

  it("fails closed on parse errors, non-zero exits, timeout, truncation, and writes", async () => {
    assert.equal((await reviewWith("parse")).status, "parse_failed");
    assert.equal((await reviewWith("nonzero")).status, "non_zero_exit");
    assert.equal((await reviewWith("timeout", 1)).status, "timed_out");
    assert.equal((await reviewWith("truncated", 5, 128)).status, "output_truncated");
    const mutation = await reviewWith("mutate");
    assert.equal(mutation.status, "read_only_violation");
    assert.equal(mutation.read_only_violation, true);
    assert.equal(existsSync(join(repoPath, "reviewer-mutated.txt")), false);
    const sensitiveMutation = await reviewWith("mutate-sensitive");
    assert.equal(sensitiveMutation.status, "read_only_violation");
    assert.equal(sensitiveMutation.read_only_violation, true);
    const ephemeralMutation = await reviewWith("mutate-ephemeral");
    assert.equal(ephemeralMutation.status, "read_only_violation");
    assert.equal(ephemeralMutation.read_only_violation, true);
  });

  async function reviewWith(
    agent: string,
    timeoutSeconds = 5,
    maxOutputBytes = 16_384,
    proposalOverrides: Partial<{
      affected_paths: string[];
      content_preview: string;
      summary: string;
    }> = {},
  ) {
    const reviewDir = join(root, "reviews", `${agent}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(reviewDir, { recursive: true });
    return runDirectReviewer({
      reviewerAgentName: agent,
      requesterAgentName: "requester",
      repoPath,
      sessionTitle: "Review fixture",
      proposal: {
        operation_type: "mkdir",
        affected_paths: proposalOverrides.affected_paths ?? ["src/new-dir"],
        content_preview: proposalOverrides.content_preview ?? "",
        summary: proposalOverrides.summary ?? "Create a scoped directory.",
      },
      reviewDir,
      timeoutSeconds,
      maxOutputBytes,
      config,
    });
  }
});

function writeScript(dir: string, name: string, source: string): void {
  writeFileSync(join(dir, name), source, "utf-8");
}

