import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { reloadConfig } from "../../../config.js";
import { runRuntimeValidation } from "../../../validation/runtimeValidation.js";

const roots: string[] = [];
const runtimeBrowserAvailable = await canLaunchRuntimeBrowser();

afterEach(() => {
  reloadConfig();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("controlled browser runtime validation", { skip: !runtimeBrowserAvailable }, () => {
  it("captures positive route evidence and terminates its owned server", { timeout: 30_000 }, async () => {
    const fixture = await createFixture(["/good"]);
    const report = await runRuntimeValidation(fixture);

    assert.equal(report.status, "passed", report.error || JSON.stringify(report.route_results));
    assert.equal(report.routes_checked, 2);
    assert.equal(report.broken_image_count, 0);
    assert.equal(report.console_error_count, 0);
    assert.equal(report.overflow_count, 0);
    assert.equal(report.server.terminated, true);
    assert.equal(report.screenshots.length, 2);
    assert.ok(report.screenshots.every((path) => existsSync(join(fixture.taskDir, path))));
  });

  it("fails on console errors, broken images, and horizontal overflow without leaking the server", { timeout: 30_000 }, async () => {
    const fixture = await createFixture(["/bad"]);
    const report = await runRuntimeValidation(fixture);

    assert.equal(report.status, "failed");
    assert.equal(report.console_error_count > 0, true);
    assert.equal(report.broken_image_count > 0, true);
    assert.equal(report.overflow_count > 0, true);
    assert.equal(report.server.terminated, true);
  });

  it("fails navigation even when console checking is disabled", { timeout: 30_000 }, async () => {
    const fixture = await createFixture(["/drop"]);
    const report = await runRuntimeValidation({
      ...fixture,
      settings: { ...fixture.settings, checkConsoleErrors: false },
    });

    assert.equal(report.status, "failed");
    assert.equal(report.route_results[0]?.navigation_error?.startsWith("navigation:"), true);
    assert.equal(report.server.terminated, true);
  });

  it("keeps route screenshot evidence distinct for query variants", { timeout: 30_000 }, async () => {
    const fixture = await createFixture(["/good"]);
    const report = await runRuntimeValidation({
      ...fixture,
      settings: { ...fixture.settings, routes: ["/good?theme=light", "/good?theme=dark"] },
    });

    assert.equal(report.status, "passed", report.error || JSON.stringify(report.route_results));
    assert.equal(report.screenshots.length, 4);
    assert.equal(new Set(report.screenshots).size, 4);
    assert.ok(report.screenshots.every((path) => existsSync(join(fixture.taskDir, path))));
  });
});

async function canLaunchRuntimeBrowser(): Promise<boolean> {
  try {
    const { chromium } = await import("playwright-core");
    for (const channel of ["msedge", "chrome", undefined] as const) {
      let browser = null;
      try {
        browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
        return true;
      } catch {
        // The production validator reports this failure when explicitly enabled.
      } finally {
        await browser?.close().catch(() => {});
      }
    }
  } catch {
    // The optional runtime smoke has no browser dependency in this environment.
  }
  return false;
}

async function createFixture(routes: string[]) {
  const root = mkdtempSync(join(tmpdir(), "patchwarden-runtime-validation-"));
  roots.push(root);
  const taskDir = join(root, ".patchwarden", "tasks", "runtime-test");
  mkdirSync(taskDir, { recursive: true });
  const port = await freePort();
  const serverFile = join(root, "runtime-fixture.mjs");
  writeFileSync(serverFile, `
import http from "node:http";
const port = Number(process.argv[2]);
const server = http.createServer((req, res) => {
  res.setHeader("content-type", "text/html; charset=utf-8");
  if (req.url === "/drop") { req.socket.destroy(); return; }
  if (req.url === "/missing.png") { res.statusCode = 404; res.end("missing"); return; }
  if (req.url === "/bad") {
    res.end('<!doctype html><meta charset="utf-8"><script>console.error("runtime fixture error")</script><img src="/missing.png"><div style="width:200vw">wide</div>');
    return;
  }
  res.end('<!doctype html><meta charset="utf-8"><title>Good</title><main>ok</main>');
});
server.listen(port, "127.0.0.1");
`, "utf-8");
  const startCommand = `node runtime-fixture.mjs ${port}`;
  const configPath = join(root, "patchwarden.config.json");
  writeFileSync(configPath, JSON.stringify({
    workspaceRoot: root,
    allowedTestCommands: [startCommand],
    runtimeValidation: {
      enabled: true,
      startCommand,
      baseUrl: `http://127.0.0.1:${port}`,
      routes,
      viewports: [
        { name: "desktop", width: 800, height: 600 },
        { name: "mobile", width: 390, height: 844 },
      ],
      startupTimeoutSeconds: 10,
      navigationTimeoutSeconds: 10,
    },
  }), "utf-8");
  const config = reloadConfig(configPath);
  return { repoPath: root, taskDir, config, settings: config.runtimeValidation! };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => server.listen(0, "127.0.0.1", resolvePromise).once("error", reject));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  return port;
}
