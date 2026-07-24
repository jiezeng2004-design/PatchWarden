import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildManageEnvironment, classifySupervisorFailure, resolveManageProfiles } from "../../../control/routes/process.js";
import { buildConnectionSummary, buildExperienceStatus, buildSuggestions, reconcileTunnelStatus } from "../../../control/routes/status.js";
import { config } from "../../../control/shared.js";

describe("Control Center profile selection", () => {
  it("exposes bounded connection identity without a raw Tunnel ID", () => {
    const summary = buildConnectionSummary("direct", {
      ready: true,
      profile: "patchwarden-direct",
      tunnel_id_masked: "tun_***1234",
    }, {
      tool_profile: "chatgpt_direct",
      tool_count: 14,
      tool_manifest_sha256: "a".repeat(64),
    });
    assert.equal(summary.ready, true);
    assert.equal(summary.tool_count, 14);
    assert.equal(summary.tunnel_id_masked, "tun_***1234");
    assert.match(summary.reconnect_guidance, /new chat/);
    assert.equal(Object.hasOwn(summary, "tunnel_id"), false);
  });

  it("starts only Core and reports Direct skipped when Direct is disabled", () => {
    assert.deepEqual(resolveManageProfiles("all", "start", false), { selected: ["core"], skipped: ["direct"] });
    assert.deepEqual(resolveManageProfiles("all", "restart", false), { selected: ["core"], skipped: ["direct"] });
  });

  it("still stops both profiles and preserves explicit Direct selection", () => {
    assert.deepEqual(resolveManageProfiles("all", "stop", false), { selected: ["core", "direct"], skipped: [] });
    assert.deepEqual(resolveManageProfiles("direct", "start", false), { selected: ["direct"], skipped: [] });
  });
});

describe("Control Center supervisor failure classification", () => {
  it("returns stable, localizable startup categories", () => {
    assert.equal(classifySupervisorFailure("Tool manifest preflight failed"), "tool_manifest_check_failed");
    assert.equal(classifySupervisorFailure("spawn EPERM"), "supervisor_permission_denied");
    assert.equal(classifySupervisorFailure("proxy connection refused"), "proxy_unreachable");
    assert.equal(classifySupervisorFailure("401 unauthorized"), "auth_failed");
    assert.equal(classifySupervisorFailure("unsupported_country_region_territory"), "unsupported_region");
    assert.equal(classifySupervisorFailure("unexpected early exit"), "supervisor_exited");
  });
});

describe("Control Center manager environment", () => {
  it("drops ambient credentials while preserving explicit lifecycle inputs", () => {
    const names = [
      "CONTROL_PLANE_API_KEY",
      "PATCHWARDEN_OWNER_TOKEN",
      "OPENAI_API_KEY",
      "PATCHWARDEN_TEST_PROVIDER_KEY",
      "PATCHWARDEN_CONFIG",
    ] as const;
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    const previousAgent = config.agents.__environment_test;
    process.env.CONTROL_PLANE_API_KEY = "control-plane-canary-value";
    process.env.PATCHWARDEN_OWNER_TOKEN = "owner-token-canary-value";
    process.env.OPENAI_API_KEY = "provider-key-canary-value";
    process.env.PATCHWARDEN_TEST_PROVIDER_KEY = "explicit-provider-canary-value";
    process.env.PATCHWARDEN_CONFIG = "C:\\PatchWarden\\test-config.json";
    config.agents.__environment_test = {
      command: process.execPath,
      args: [],
      envAllowlist: ["PATCHWARDEN_TEST_PROVIDER_KEY"],
    };
    try {
      const env = buildManageEnvironment();
      assert.equal(env.CONTROL_PLANE_API_KEY, undefined);
      assert.equal(env.PATCHWARDEN_OWNER_TOKEN, undefined);
      assert.equal(env.OPENAI_API_KEY, undefined);
      assert.equal(env.PATCHWARDEN_TEST_PROVIDER_KEY, "explicit-provider-canary-value");
      assert.equal(env.PATCHWARDEN_AGENT_ENV_ALLOWLIST, "PATCHWARDEN_TEST_PROVIDER_KEY");
      assert.equal(env.PATCHWARDEN_CONFIG, "C:\\PatchWarden\\test-config.json");
      assert.equal(typeof env.PATCHWARDEN_TUNNEL_PROXY_MODE, "string");
      assert.equal(typeof env.PATCHWARDEN_DIRECT_PROXY_MODE, "string");
      assert.equal(Object.hasOwn(env, "PATCHWARDEN_TUNNEL_PROXY_URL"), true);
      assert.equal(Object.hasOwn(env, "PATCHWARDEN_DIRECT_PROXY_URL"), true);
    } finally {
      if (previousAgent === undefined) delete config.agents.__environment_test;
      else config.agents.__environment_test = previousAgent;
      for (const name of names) {
        const value = previous[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});

describe("Control Center tunnel status", () => {
  it("uses a live ready endpoint over a stale stopped runtime file", () => {
    const result = reconcileTunnelStatus(
      { observed: true, status: "stopped", ready: false, reason_code: "stopped_by_manager" },
      { available: true, reason: null, healthz: { status: 200 }, readyz: { status: 200 } },
    );
    assert.equal(result.status, "running");
    assert.equal(result.ready, true);
    assert.equal(result.reason_code, "health_endpoint_ready");
  });

  it("keeps the runtime file when the endpoint is unavailable", () => {
    const status = { observed: true, status: "stopped", ready: false };
    assert.equal(
      reconcileTunnelStatus(status, { available: false, reason: "refused", healthz: null, readyz: null }),
      status,
    );
  });

  it("offers idempotent start instead of restart and ignores disabled Direct", () => {
    const suggestions = buildSuggestions({
      core: { available: false, reason: "refused", healthz: null, readyz: null },
      direct: { available: false, reason: "refused", healthz: null, readyz: null },
      watcher: {
        status: "healthy",
        available: true,
        stale_after_seconds: 30,
        last_heartbeat_at: new Date().toISOString(),
        heartbeat_age_seconds: 0,
        heartbeat_pid: 123,
        instance_id: "test",
        launcher_pid: 122,
        reason: null,
        activity: null,
      },
      tunnel: {
        core: { observed: true, ready: false },
        direct: { observed: true, ready: false },
      },
      agents: [],
      tasks: { total: 0, active: 0, stale: 0, stale_task_ids: [], tasks: [], reason: null },
      direct_profile_enabled: false,
    });
    assert.equal(suggestions.some((item) => item.code === "direct_stopped"), false);
    assert.equal(suggestions.find((item) => item.code === "tunnel_not_ready")?.action, "/api/start-all");
  });

  it("restarts only Core when the Core watcher is stale", () => {
    const suggestions = buildSuggestions({
      core: { available: true, reason: null, healthz: { status: 200 }, readyz: { status: 200 } },
      direct: { available: true, reason: null, healthz: { status: 200 }, readyz: { status: 200 } },
      watcher: {
        status: "stale",
        available: false,
        stale_after_seconds: 30,
        last_heartbeat_at: null,
        heartbeat_age_seconds: 60,
        heartbeat_pid: null,
        instance_id: null,
        launcher_pid: null,
        reason: "stale",
        activity: null,
      },
      tunnel: { core: { ready: true }, direct: { ready: true } },
      agents: [],
      tasks: { total: 0, active: 0, stale: 0, stale_task_ids: [], tasks: [], reason: null },
      direct_profile_enabled: true,
    });
    assert.equal(suggestions.find((item) => item.code === "watcher_stale")?.action, "/api/core/restart");
  });
});

describe("Control Center experience status", () => {
  const watcher = {
    status: "healthy" as const,
    available: true,
    stale_after_seconds: 30,
    last_heartbeat_at: new Date().toISOString(),
    heartbeat_age_seconds: 0,
    heartbeat_pid: 123,
    instance_id: "test",
    launcher_pid: 122,
    reason: null,
    activity: null,
  };

  it("treats disabled Direct and historical evidence as non-blocking", () => {
    const result = buildExperienceStatus({
      core: { available: true, reason: null, healthz: { status: 200 }, readyz: { status: 200 } },
      direct: { available: false, reason: "disabled", healthz: null, readyz: null },
      watcher,
      tunnel: { core: { ready: true }, direct: { ready: false } },
      agents: [
        {
          name: "opencode",
          available: true,
          configured: true,
          command: "opencode.exe",
          adapter: "opencode",
          model: null,
          capabilities: { model_override: true },
          availability_scope: "executable_only",
          provider_status: "not_checked",
          reason: null,
          checked_at: new Date().toISOString(),
        },
      ],
      tasks: { total: 0, active: 0, stale: 2, stale_task_ids: [], tasks: [], reason: null },
      direct_profile_enabled: false,
    });
    assert.equal(result.readiness, "ready");
    assert.equal(result.live_checks.find((check) => check.key === "direct")?.state, "optional");
    assert.equal(result.historical_summary.stale_tasks, 2);
  });

  it("blocks only when the current workspace has no available agent", () => {
    const result = buildExperienceStatus({
      core: { available: false, reason: "stopped", healthz: null, readyz: null },
      direct: { available: false, reason: "disabled", healthz: null, readyz: null },
      watcher,
      tunnel: { core: { ready: false }, direct: { ready: false } },
      agents: [],
      tasks: { total: 0, active: 0, stale: 0, stale_task_ids: [], tasks: [], reason: null },
      direct_profile_enabled: false,
    });
    assert.equal(result.readiness, "blocked");
  });

  it("reports an enabled but unhealthy Direct profile as a non-blocking action", () => {
    const result = buildExperienceStatus({
      core: { available: true, reason: null, healthz: { status: 200 }, readyz: { status: 200 } },
      direct: { available: false, reason: "stopped", healthz: null, readyz: null },
      watcher,
      tunnel: { core: { ready: true }, direct: { ready: false } },
      agents: [{
        name: "opencode", available: true, configured: true, command: "opencode.exe", adapter: "opencode", model: null,
        capabilities: { model_override: true }, reason: null, checked_at: new Date().toISOString(),
        availability_scope: "executable_only", provider_status: "not_checked",
      }],
      tasks: { total: 1, active: 0, stale: 0, stale_task_ids: [], tasks: [{ task_id: "task_failed", status: "failed" }], reason: null },
      direct_profile_enabled: true,
    });
    assert.equal(result.readiness, "needs_action");
    assert.equal(result.live_checks.find((check) => check.key === "direct")?.state, "needs_action");
    assert.equal(result.historical_summary.failed_tasks, 1);
  });

  it("keeps a missing Watcher distinct from Core and historical health", () => {
    const result = buildExperienceStatus({
      core: { available: true, reason: null, healthz: { status: 200 }, readyz: { status: 200 } },
      direct: { available: false, reason: "disabled", healthz: null, readyz: null },
      watcher: { ...watcher, status: "missing", available: false },
      tunnel: { core: { ready: true }, direct: { ready: false } },
      agents: [{
        name: "opencode", available: true, configured: true, command: "opencode.exe", adapter: "opencode", model: null,
        capabilities: { model_override: true }, reason: null, checked_at: new Date().toISOString(),
        availability_scope: "executable_only", provider_status: "not_checked",
      }],
      tasks: { total: 0, active: 0, stale: 0, stale_task_ids: [], tasks: [], reason: null },
      direct_profile_enabled: false,
    });
    assert.equal(result.readiness, "needs_action");
    assert.equal(result.live_checks.find((check) => check.key === "watcher")?.state, "needs_action");
  });
});
