import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { runSimpleProcess, runSimpleProcessSync } from "../../../runner/simpleProcess.js";

describe("runSimpleProcessSync log append", () => {
  let root: string;

  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "pw-simple-process-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it("appends repeated process output without read-modify-write", () => {
    const outputPath = join(root, "stdout.log");
    for (const value of ["first", "second"]) {
      const result = runSimpleProcessSync({
        command: process.execPath,
        args: ["-e", `process.stdout.write(${JSON.stringify(value)})`],
        cwd: root,
        timeoutMs: 5000,
        stdoutPath: outputPath,
      });
      assert.equal(result.exitCode, 0);
    }
    assert.equal(readFileSync(outputPath, "utf-8"), "firstsecond");
  });

  it("flushes the complete child output to disk after stdio closes", async () => {
    const outputPath = join(root, "large-stdout.log");
    const outputBytes = 512 * 1024;
    const result = await runSimpleProcess({
      command: process.execPath,
      args: ["-e", `process.stdout.write("x".repeat(${outputBytes}))`],
      cwd: root,
      timeoutMs: 5000,
      maxStdoutBytes: 1024,
      stdoutPath: outputPath,
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdoutTruncated, true);
    assert.equal(readFileSync(outputPath).length, outputBytes);
  });

  it("does not inherit ambient secrets unless their names are explicitly allowed", () => {
    const variable = "PATCHWARDEN_PROCESS_CANARY_SECRET";
    const previous = process.env[variable];
    process.env[variable] = "ambient-secret-canary-value";
    try {
      const result = runSimpleProcessSync({
        command: process.execPath,
        args: ["-e", `process.stdout.write(process.env.${variable} ? "visible" : "missing")`],
        cwd: root,
        timeoutMs: 5000,
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout, "missing");
    } finally {
      if (previous === undefined) delete process.env[variable];
      else process.env[variable] = previous;
    }
  });

  it("passes an explicitly allow-listed provider variable without persisting its value", async () => {
    const variable = "PATCHWARDEN_PROCESS_PROVIDER_CANARY";
    const secret = "provider-secret-canary-value-1234";
    const previous = process.env[variable];
    const outputPath = join(root, "provider.log");
    process.env[variable] = secret;
    try {
      const visibility = runSimpleProcessSync({
        command: process.execPath,
        args: ["-e", `process.stdout.write(process.env.${variable} === ${JSON.stringify(secret)} ? "visible" : "missing")`],
        cwd: root,
        timeoutMs: 5000,
        environmentVariableNames: [variable],
      });
      assert.equal(visibility.exitCode, 0);
      assert.equal(visibility.stdout, "visible");

      const logged = await runSimpleProcess({
        command: process.execPath,
        args: ["-e", `process.stdout.write("PROVIDER_TOKEN=" + process.env.${variable})`],
        cwd: root,
        timeoutMs: 5000,
        environmentVariableNames: [variable],
        stdoutPath: outputPath,
      });
      const persisted = readFileSync(outputPath, "utf-8");
      assert.equal(logged.exitCode, 0);
      assert.equal(logged.stdout.includes(secret), false);
      assert.equal(persisted.includes(secret), false);
      assert.match(persisted, /REDACTED/);
    } finally {
      if (previous === undefined) delete process.env[variable];
      else process.env[variable] = previous;
    }
  });

  it("never passes the tunnel owner credential, even when requested", () => {
    const previous = process.env.CONTROL_PLANE_API_KEY;
    process.env.CONTROL_PLANE_API_KEY = "owner-key-canary-value";
    try {
      const result = runSimpleProcessSync({
        command: process.execPath,
        args: ["-e", "process.stdout.write(process.env.CONTROL_PLANE_API_KEY ? 'visible' : 'missing')"],
        cwd: root,
        timeoutMs: 5000,
        environmentVariableNames: ["CONTROL_PLANE_API_KEY"],
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout, "missing");
    } finally {
      if (previous === undefined) delete process.env.CONTROL_PLANE_API_KEY;
      else process.env.CONTROL_PLANE_API_KEY = previous;
    }
  });

  it("binds a bare Windows executable before entering an untrusted repo cwd", { skip: process.platform !== "win32" }, () => {
    writeFileSync(join(root, "node.cmd"), "@echo HIJACKED\r\n", "utf-8");
    const result = runSimpleProcessSync({
      command: "node",
      args: ["-e", "process.stdout.write('trusted-node')"],
      cwd: root,
      timeoutMs: 5000,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "trusted-node");
  });

  it("replaces the Direct cmd/npm wrapper with a trusted shell-free CLI", { skip: process.platform !== "win32" }, () => {
    writeFileSync(join(root, "npm.cmd"), "@echo HIJACKED\r\n@exit /b 99\r\n", "utf-8");
    const result = runSimpleProcessSync({
      command: process.env.ComSpec || "cmd.exe",
      args: ["/c", "npm", "--version"],
      cwd: root,
      timeoutMs: 5000,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.includes("HIJACKED"), false);
    assert.match(result.stdout, /^\d+\.\d+\.\d+/);
  });

  it("resolves a direct npm.cmd invocation without executing a repo-local shim", { skip: process.platform !== "win32" }, () => {
    writeFileSync(join(root, "npm.cmd"), "@echo HIJACKED\r\n@exit /b 99\r\n", "utf-8");
    const result = runSimpleProcessSync({
      command: "npm.cmd",
      args: ["--version"],
      cwd: root,
      timeoutMs: 5000,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.includes("HIJACKED"), false);
    assert.match(result.stdout, /^\d+\.\d+\.\d+/);
  });

  it("rejects other Windows command-shell wrappers", { skip: process.platform !== "win32" }, () => {
    const result = runSimpleProcessSync({
      command: process.env.ComSpec || "cmd.exe",
      args: ["/c", "echo", "unsafe"],
      cwd: root,
      timeoutMs: 5000,
    });
    assert.equal(result.exitCode, null);
    assert.match(result.spawnError || "", /command shells are not allowed/);
  });

  it("caps the total persisted process log and records truncation", async () => {
    const outputPath = join(root, "bounded.log");
    const result = await runSimpleProcess({
      command: process.execPath,
      args: ["-e", "process.stdout.write('x'.repeat(4096))"],
      cwd: root,
      timeoutMs: 5000,
      maxStdoutBytes: 8192,
      maxLogBytes: 256,
      stdoutPath: outputPath,
    });
    const persisted = readFileSync(outputPath, "utf-8");
    assert.equal(result.exitCode, 0);
    assert.ok(Buffer.byteLength(persisted, "utf-8") <= 256);
    assert.match(persisted, /PATCHWARDEN LOG TRUNCATED/);
  });

  it("keeps returned output bounded when exact-value redaction expands it", () => {
    const variable = "PATCHWARDEN_SHORT_PROVIDER_CANARY";
    const previous = process.env[variable];
    process.env[variable] = "12345678";
    try {
      const result = runSimpleProcessSync({
        command: process.execPath,
        args: ["-e", `process.stdout.write(process.env.${variable}.repeat(20))`],
        cwd: root,
        timeoutMs: 5000,
        maxStdoutBytes: 160,
        environmentVariableNames: [variable],
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout.length, 160);
      assert.equal(result.stdoutTruncated, true);
      assert.equal(result.stdout.includes("12345678"), false);
    } finally {
      if (previous === undefined) delete process.env[variable];
      else process.env[variable] = previous;
    }
  });

  it("redacts a token split across multiple stdout chunks before persistence", async () => {
    const outputPath = join(root, "split-token.log");
    const token = `ghp_${"a".repeat(24)}`;
    const result = await runSimpleProcess({
      command: process.execPath,
      args: ["-e", `process.stdout.write(${JSON.stringify(token.slice(0, 10))});setTimeout(()=>process.stdout.write(${JSON.stringify(token.slice(10))}),20)`],
      cwd: root,
      timeoutMs: 5000,
      stdoutPath: outputPath,
    });
    const persisted = readFileSync(outputPath, "utf-8");
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.includes(token), false);
    assert.equal(persisted.includes(token), false);
    assert.match(persisted, /REDACTED TOKEN/);
  });
});
