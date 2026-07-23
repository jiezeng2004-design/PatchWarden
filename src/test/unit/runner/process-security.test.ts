import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  buildChildEnvironment,
  buildGitEnvironment,
  resolveTrustedExecutable,
} from "../../../runner/processSecurity.js";

describe("process security child environment", () => {
  it("reconstructs Windows lifecycle shell defaults omitted by MCP transports", () => {
    const env = buildChildEnvironment({
      cwd: "C:\\workspace\\repo",
      platform: "win32",
      sourceEnvironment: {
        SystemRoot: "C:\\Windows",
        PATH: "C:\\Tools",
      },
    });

    assert.equal(env.ComSpec, "C:\\Windows\\System32\\cmd.exe");
    assert.equal(env.PATHEXT, ".COM;.EXE;.BAT;.CMD");
  });

  it("preserves Windows lifecycle shell values when the host supplied them", () => {
    const env = buildChildEnvironment({
      cwd: "C:\\workspace\\repo",
      platform: "win32",
      sourceEnvironment: {
        SystemRoot: "C:\\Windows",
        ComSpec: "D:\\Trusted\\cmd.exe",
        PATHEXT: ".EXE;.CMD",
        PATH: "C:\\Tools",
      },
    });

    assert.equal(env.ComSpec, "D:\\Trusted\\cmd.exe");
    assert.equal(env.PATHEXT, ".EXE;.CMD");
  });
});

describe("process security Git environment", () => {
  it("forces non-interactive Git and disables repo-defined execution hooks", () => {
    const root = mkdtempSync(join(tmpdir(), "pw-git-env-"));
    try {
      const env = buildGitEnvironment(root);
      const git = resolveTrustedExecutable("git", root, { pathValue: env.PATH });
      assert.equal(env.GIT_TERMINAL_PROMPT, "0");
      assert.equal(env.GCM_INTERACTIVE, "Never");
      assert.equal(env.GIT_OPTIONAL_LOCKS, "0");
      assert.equal(
        execFileSync(git, ["config", "--get", "core.fsmonitor"], { cwd: root, env, encoding: "utf-8" }).trim(),
        "false",
      );
      assert.equal(
        execFileSync(git, ["config", "--get", "core.hooksPath"], { cwd: root, env, encoding: "utf-8" }).trim(),
        "/dev/null",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
