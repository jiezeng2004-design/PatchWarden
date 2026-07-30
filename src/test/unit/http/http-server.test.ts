import { strict as assert } from "node:assert";
import { request as httpRequest } from "node:http";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { reloadConfig, type PatchWardenConfig } from "../../../config.js";
import { createPatchWardenHttpServer } from "../../../httpServer.js";

describe("HTTP MCP security budgets", () => {
  let root: string;
  let configPath: string;
  let config: PatchWardenConfig;
  let previousConfig: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pw-http-unit-"));
    mkdirSync(join(root, "workspace"), { recursive: true });
    configPath = join(root, "patchwarden.config.json");
    writeFileSync(configPath, JSON.stringify({
      workspaceRoot: join(root, "workspace"),
      plansDir: ".patchwarden/plans",
      tasksDir: ".patchwarden/tasks",
      agents: {},
      allowedTestCommands: ["npm test"],
    }));
    previousConfig = process.env.PATCHWARDEN_CONFIG;
    process.env.PATCHWARDEN_CONFIG = configPath;
    config = reloadConfig(configPath);
  });

  afterEach(() => {
    if (previousConfig === undefined) delete process.env.PATCHWARDEN_CONFIG;
    else process.env.PATCHWARDEN_CONFIG = previousConfig;
    reloadConfig(previousConfig);
    rmSync(root, { recursive: true, force: true });
  });

  it("enforces minimal health, authentication, body, concurrency, and socket budgets on a dynamic port", async () => {
    const token = "unit-owner-token-123456";
    const server = createPatchWardenHttpServer({
      config,
      ownerToken: token,
      port: 0,
      limits: {
        maxMcpBodyBytes: 256,
        maxConcurrentRequests: 1,
        bodyReadTimeoutMs: 500,
        handlerTimeoutMs: 2_000,
        headersTimeoutMs: 900,
        requestTimeoutMs: 2_500,
        keepAliveTimeoutMs: 700,
        maxHeadersCount: 24,
      },
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      assert.equal(server.headersTimeout, 900);
      assert.equal(server.requestTimeout, 2_500);
      assert.equal(server.keepAliveTimeout, 700);
      assert.equal(server.maxHeadersCount, 24);

      const health = await fetch(`${base}/healthz`);
      const minimal = await health.json() as Record<string, unknown>;
      assert.equal(health.status, 200);
      assert.deepEqual(Object.keys(minimal).sort(), ["ready", "service", "status"]);

      assert.equal((await fetch(`${base}/healthz?detail=full`)).status, 401);
      assert.equal((await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })).status, 401);

      const oversized = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ value: "x".repeat(300) }),
      });
      assert.equal(oversized.status, 413);

      const slow = httpRequest({
        hostname: "127.0.0.1",
        port: address.port,
        path: "/mcp",
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${token}`,
          "transfer-encoding": "chunked",
        },
      });
      slow.on("error", () => {});
      slow.write("{");
      await new Promise((resolve) => setTimeout(resolve, 40));
      const limited = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
        body: "{}",
      });
      assert.equal(limited.status, 429);
      assert.equal(limited.headers.get("retry-after"), "1");
      slow.destroy();
    } finally {
      server.close();
      await once(server, "close");
    }
  });
});
