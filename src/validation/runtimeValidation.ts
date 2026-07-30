import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { basename, join, relative } from "node:path";
import type { Browser, BrowserContext } from "playwright-core";
import type { PatchWardenConfig, RuntimeValidationConfig, RuntimeValidationViewport } from "../config.js";
import { guardTestCommand } from "../security/commandGuard.js";
import {
  buildChildEnvironment,
  prepareShellFreeCommand,
  resolveTrustedExecutable,
  SecureProcessLogCapture,
} from "../runner/processSecurity.js";
import { atomicWriteJsonFileSync } from "../utils/atomicFile.js";

export interface RuntimeRouteResult {
  route: string;
  viewport: string;
  url: string;
  status_code: number | null;
  console_errors: string[];
  broken_images: Array<{ src: string }>;
  horizontal_overflow: number;
  navigation_error: string | null;
  screenshot: string | null;
  status: "passed" | "failed";
}

export interface RuntimeValidationReport {
  schema_version: "patchwarden-runtime-validation-v1";
  status: "passed" | "failed" | "skipped";
  started_at: string;
  finished_at: string;
  base_url: string;
  routes_checked: number;
  viewports_checked: number;
  console_error_count: number;
  broken_image_count: number;
  overflow_count: number;
  screenshots: string[];
  route_results: RuntimeRouteResult[];
  server: {
    command: string;
    pid: number | null;
    ready: boolean;
    terminated: boolean;
  };
  error: string | null;
}

export async function runRuntimeValidation(input: {
  repoPath: string;
  taskDir: string;
  config: PatchWardenConfig;
  settings: RuntimeValidationConfig;
}): Promise<RuntimeValidationReport> {
  const startedAt = new Date().toISOString();
  const report = emptyReport(input.settings, startedAt);
  if (!input.settings.enabled) {
    report.finished_at = new Date().toISOString();
    atomicWriteJsonFileSync(join(input.taskDir, "runtime-validation.json"), report);
    return report;
  }

  let server: ChildProcess | null = null;
  let browser: Browser | null = null;
  const logCapture = new SecureProcessLogCapture([
    join(input.taskDir, "runtime-server.stdout.log"),
    join(input.taskDir, "runtime-server.stderr.log"),
  ], 512 * 1024);
  try {
    const command = guardTestCommand(input.settings.startCommand, input.config, input.repoPath);
    if (await isLoopbackReachable(input.settings.baseUrl, 1000)) {
      throw new Error("Runtime validation base URL is already in use; refusing to attach to an unowned service");
    }
    const [rawExecutable, ...args] = command.split(/\s+/).filter(Boolean);
    const env = buildChildEnvironment({ cwd: input.repoPath });
    const prepared = prepareShellFreeCommand(rawExecutable, args, input.repoPath, { pathValue: env.PATH });
    const executable = resolveTrustedExecutable(prepared.command, input.repoPath, { pathValue: env.PATH });
    server = spawn(executable, prepared.args, {
      cwd: input.repoPath,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
      env,
    });
    report.server.pid = server.pid ?? null;
    server.stdout?.on("data", (chunk: Buffer) => logCapture.append(join(input.taskDir, "runtime-server.stdout.log"), chunk));
    server.stderr?.on("data", (chunk: Buffer) => logCapture.append(join(input.taskDir, "runtime-server.stderr.log"), chunk));
    await waitForLoopbackServer(input.settings.baseUrl, input.settings.startupTimeoutSeconds * 1000, server);
    report.server.ready = true;

    browser = await launchSystemBrowser();
    const screenshotDir = join(input.taskDir, "runtime-screenshots");
    if (input.settings.captureScreenshots) mkdirSync(screenshotDir, { recursive: true });
    for (const [viewportIndex, viewport] of input.settings.viewports.entries()) {
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
      try {
        await restrictContextToLoopback(context, input.settings.baseUrl);
        for (const [routeIndex, route] of input.settings.routes.entries()) {
          const result = await validateRoute(context, input.settings, viewport, viewportIndex, route, routeIndex, screenshotDir, input.taskDir);
          report.route_results.push(result);
        }
      } finally {
        await context.close();
      }
    }
    report.routes_checked = report.route_results.length;
    report.viewports_checked = input.settings.viewports.length;
    report.console_error_count = report.route_results.reduce((total, item) => total + item.console_errors.length, 0);
    report.broken_image_count = report.route_results.reduce((total, item) => total + item.broken_images.length, 0);
    report.overflow_count = report.route_results.filter((item) => item.horizontal_overflow > 0).length;
    report.screenshots = report.route_results.map((item) => item.screenshot).filter((value): value is string => Boolean(value));
    report.status = report.route_results.every((item) => item.status === "passed") ? "passed" : "failed";
  } catch (error) {
    report.status = "failed";
    report.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) report.server.terminated = await terminateOwnedProcessTree(server, input.settings.baseUrl);
    logCapture.flush();
    report.finished_at = new Date().toISOString();
    atomicWriteJsonFileSync(join(input.taskDir, "runtime-validation.json"), report);
  }
  return report;
}

function emptyReport(settings: RuntimeValidationConfig, startedAt: string): RuntimeValidationReport {
  return {
    schema_version: "patchwarden-runtime-validation-v1",
    status: settings.enabled ? "failed" : "skipped",
    started_at: startedAt,
    finished_at: startedAt,
    base_url: settings.baseUrl,
    routes_checked: 0,
    viewports_checked: 0,
    console_error_count: 0,
    broken_image_count: 0,
    overflow_count: 0,
    screenshots: [],
    route_results: [],
    server: { command: settings.startCommand, pid: null, ready: false, terminated: false },
    error: null,
  };
}

async function launchSystemBrowser(): Promise<Browser> {
  let chromium: typeof import("playwright-core")["chromium"];
  try {
    ({ chromium } = await import("playwright-core"));
  } catch {
    throw new Error("Runtime browser validation requires an explicit local playwright-core installation");
  }
  const failures: string[] = [];
  for (const channel of ["msedge", "chrome", undefined] as const) {
    try {
      return await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
    } catch (error) {
      failures.push(`${channel || "bundled"}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    }
  }
  throw new Error(`No supported Playwright browser could launch (${failures.join("; ")}). Install Edge/Chrome or a Playwright Chromium browser.`);
}

async function restrictContextToLoopback(context: BrowserContext, baseUrl: string): Promise<void> {
  const allowedOrigin = new URL(baseUrl).origin;
  await context.route("**/*", async (route) => {
    const url = route.request().url();
    if (/^(?:data|blob|about):/i.test(url) || new URL(url).origin === allowedOrigin) await route.continue();
    else await route.abort("blockedbyclient");
  });
}

async function validateRoute(
  context: BrowserContext,
  settings: RuntimeValidationConfig,
  viewport: RuntimeValidationViewport,
  viewportIndex: number,
  route: string,
  routeIndex: number,
  screenshotDir: string,
  taskDir: string,
): Promise<RuntimeRouteResult> {
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && consoleErrors.length < 50) consoleErrors.push(message.text().slice(0, 1000));
  });
  page.on("pageerror", (error) => {
    if (consoleErrors.length < 50) consoleErrors.push(error.message.slice(0, 1000));
  });
  let statusCode: number | null = null;
  let finalUrl = new URL(route, settings.baseUrl).href;
  let brokenImages: Array<{ src: string }> = [];
  let horizontalOverflow = 0;
  let screenshot: string | null = null;
  let navigationError: string | null = null;
  try {
    const response = await page.goto(finalUrl, { waitUntil: "domcontentloaded", timeout: settings.navigationTimeoutSeconds * 1000 });
    await page.waitForTimeout(250);
    statusCode = response?.status() ?? null;
    finalUrl = page.url();
    if (new URL(finalUrl).origin !== new URL(settings.baseUrl).origin) throw new Error("Route redirected outside the configured loopback origin");
    if (settings.checkBrokenImages) {
      brokenImages = await page.locator("img").evaluateAll((images) => images
        .filter((image) => !(image as HTMLImageElement).complete || (image as HTMLImageElement).naturalWidth === 0)
        .slice(0, 100)
        .map((image) => ({ src: (image as HTMLImageElement).currentSrc || (image as HTMLImageElement).src })));
    }
    if (settings.checkHorizontalOverflow) {
      horizontalOverflow = await page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth));
    }
    if (settings.captureScreenshots) {
      const filename = `v${viewportIndex}-${viewport.name}-r${routeIndex}-${routeSlug(route)}-${routeHash(route)}.png`;
      await page.screenshot({ path: join(screenshotDir, filename), fullPage: true });
      screenshot = relative(taskDir, join(screenshotDir, filename)).replace(/\\/g, "/");
    }
  } catch (error) {
    navigationError = `navigation: ${error instanceof Error ? error.message : String(error)}`.slice(0, 1000);
    consoleErrors.push(navigationError);
  } finally {
    await page.close();
  }
  const failed = (statusCode !== null && statusCode >= 400)
    || navigationError !== null
    || (settings.checkConsoleErrors && consoleErrors.length > 0)
    || (settings.checkBrokenImages && brokenImages.length > 0)
    || (settings.checkHorizontalOverflow && horizontalOverflow > 0);
  return {
    route,
    viewport: viewport.name,
    url: finalUrl,
    status_code: statusCode,
    console_errors: consoleErrors,
    broken_images: brokenImages,
    horizontal_overflow: horizontalOverflow,
    navigation_error: navigationError,
    screenshot,
    status: failed ? "failed" : "passed",
  };
}

async function waitForLoopbackServer(baseUrl: string, timeoutMs: number, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (childHasExited(child)) {
      throw new Error(`Runtime server exited before readiness with ${child.exitCode !== null ? `code ${child.exitCode}` : `signal ${child.signalCode}`}`);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    try {
      const response = await fetch(baseUrl, { signal: controller.signal, redirect: "manual", cache: "no-store" });
      if (response.status < 500) return;
    } catch {
      // The process may still be starting.
    } finally {
      clearTimeout(timer);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(`Runtime server did not become ready within ${Math.round(timeoutMs / 1000)} seconds`);
}

async function terminateOwnedProcessTree(child: ChildProcess, baseUrl: string): Promise<boolean> {
  if (!child.pid || childHasExited(child)) return true;
  try {
    if (process.platform === "win32") {
      const systemRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
      const taskkill = resolveTrustedExecutable(`${systemRoot}\\System32\\taskkill.exe`, process.cwd());
      const result = spawnSync(taskkill, ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore", timeout: 5000, windowsHide: true, env: buildChildEnvironment({ cwd: process.cwd() }),
      });
      if (result.status !== 0) child.kill("SIGKILL");
    } else {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    try { child.kill("SIGKILL"); } catch {}
  }
  for (let attempt = 0; attempt < 40; attempt++) {
    if (childHasExited(child) && !(await isLoopbackReachable(baseUrl, 100))) return true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  return childHasExited(child) && !(await isLoopbackReachable(baseUrl, 250));
}

function childHasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function isLoopbackReachable(baseUrl: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(baseUrl, { signal: controller.signal, redirect: "manual", cache: "no-store" });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function routeSlug(route: string): string {
  const value = route.replace(/[?#].*$/, "").replace(/^\/+|\/+$/g, "").replace(/[^A-Za-z0-9_-]+/g, "-");
  return (value || "home").slice(0, 80);
}

function routeHash(route: string): string {
  return createHash("sha256").update(route, "utf8").digest("hex").slice(0, 12);
}
