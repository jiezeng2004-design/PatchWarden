import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { atomicWriteJson } from "../src/config-store.mjs";
import { forgetTunnelCredential, getTunnelSetupStatus, maskTunnelId, provisionTunnelProfile, revalidateTunnelProfile } from "../src/tunnel-provisioner.mjs";

function fixture() {
  const root = join(tmpdir(), `patchwarden-provision-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const appData = join(root, "AppData", "Roaming");
  const local = join(root, "Local");
  const exe = join(root, "tunnel-client.exe");
  const configPath = join(root, "patchwarden.config.json");
  const statusPath = join(local, "tunnel-setup-status.json");
  const credentialPath = join(appData, "patchwarden", "control-plane-api-key.dpapi");
  mkdirSync(root, { recursive: true });
  writeFileSync(exe, "fixture", "utf8");
  atomicWriteJson(configPath, { workspaceRoot: root, tunnelClientPath: exe }, false);
  return { root, appData, local, configPath, statusPath, credentialPath, env: { APPDATA: appData, LOCALAPPDATA: local, PATH: "" } };
}

function fakeSpawn(result, capture) {
  return (command, args, options) => {
    capture.command = command; capture.args = args; capture.options = options; capture.stdin = "";
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin.on("data", (chunk) => { capture.stdin += chunk.toString(); });
    child.kill = () => {};
    queueMicrotask(() => { child.stdout.end(`${JSON.stringify(result)}\n`); child.emit("close", result.ok ? 0 : 1); });
    return child;
  };
}

describe("desktop tunnel provisioning", () => {
  it("masks tunnel ids and reports existence-only status", () => {
    const f = fixture();
    const profile = join(f.appData, "tunnel-client", "patchwarden.yaml");
    mkdirSync(join(f.appData, "tunnel-client"), { recursive: true });
    writeFileSync(profile, 'tunnel_id: "tun_1234567890"\n', "utf8");
    mkdirSync(join(f.appData, "patchwarden"), { recursive: true });
    writeFileSync(f.credentialPath, "encrypted", "utf8");
    const status = getTunnelSetupStatus({ mode: "core", configPath: f.configPath, statusPath: f.statusPath, credentialPath: f.credentialPath, env: f.env });
    assert.equal(maskTunnelId("tun_1234567890"), "tun_...7890");
    assert.deepEqual([status.program_present, status.profile_present, status.credential_configured], [true, true, true]);
    assert.equal(status.tunnel_id_masked, "tun_...7890");
    assert.equal(Object.hasOwn(status, "runtimeKey"), false);
  });

  it("passes the runtime key only through stdin and never persists or returns it", async () => {
    const f = fixture(); const capture = {}; const secret = "runtime-secret-fixture";
    const result = await provisionTunnelProfile({
      mode: "core", tunnelId: "tun_fixture", runtimeKey: secret, configPath: f.configPath,
      statusPath: f.statusPath, credentialPath: f.credentialPath, projectRoot: f.root,
      env: { ...f.env, CONTROL_PLANE_API_KEY: "stale-secret" },
      spawnImpl: fakeSpawn({ ok: true, reason_code: "configured", next_step: "start_core" }, capture),
    });
    assert.equal(capture.stdin, `${secret}\n`);
    assert.equal(capture.args.includes(secret), false);
    assert.equal(Object.values(capture.options.env).includes(secret), false);
    assert.equal(Object.hasOwn(capture.options.env, "CONTROL_PLANE_API_KEY"), false);
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.equal(readFileSync(f.statusPath, "utf8").includes(secret), false);
    assert.equal(readFileSync(f.configPath, "utf8").includes(secret), false);
  });

  it("rejects an empty key and preserves doctor failure categories", async () => {
    const f = fixture();
    const empty = await provisionTunnelProfile({ mode: "core", tunnelId: "tun_fixture", runtimeKey: "", configPath: f.configPath, statusPath: f.statusPath, credentialPath: f.credentialPath, projectRoot: f.root, env: f.env });
    assert.equal(empty.reason_code, "runtime_key_missing");
    const failed = await provisionTunnelProfile({
      mode: "core", tunnelId: "tun_fixture", runtimeKey: "secret", configPath: f.configPath,
      statusPath: f.statusPath, credentialPath: f.credentialPath, projectRoot: f.root, env: f.env,
      spawnImpl: fakeSpawn({ ok: false, reason_code: "authentication_failed", next_step: "replace_runtime_key" }, {}),
    });
    assert.deepEqual(failed, { ok: false, reason_code: "authentication_failed", next_step: "replace_runtime_key" });
  });

  it("reports abnormal spawn and forgets only the DPAPI file", async () => {
    const f = fixture();
    const failed = await provisionTunnelProfile({ mode: "core", tunnelId: "tun_fixture", runtimeKey: "secret", configPath: f.configPath, statusPath: f.statusPath, credentialPath: f.credentialPath, projectRoot: f.root, env: f.env, spawnImpl: () => { throw new Error("boom"); } });
    assert.equal(failed.reason_code, "provisioning_spawn_failed");
    mkdirSync(join(f.appData, "patchwarden"), { recursive: true });
    writeFileSync(f.credentialPath, "encrypted", "utf8");
    assert.deepEqual(forgetTunnelCredential(f.credentialPath), { ok: true, credential_configured: false });
    assert.equal(existsSync(f.credentialPath), false);
    assert.equal(existsSync(f.configPath), true);
  });

  it("revalidates with the saved DPAPI credential without renderer key material", async () => {
    const f = fixture(); const capture = {};
    mkdirSync(join(f.appData, "patchwarden"), { recursive: true });
    mkdirSync(join(f.appData, "tunnel-client"), { recursive: true });
    writeFileSync(f.credentialPath, "encrypted", "utf8");
    writeFileSync(join(f.appData, "tunnel-client", "patchwarden.yaml"), 'tunnel_id: "tun_fixture"\n', "utf8");
    const result = await revalidateTunnelProfile({
      mode: "core", configPath: f.configPath, statusPath: f.statusPath, credentialPath: f.credentialPath,
      projectRoot: f.root, env: { ...f.env, CONTROL_PLANE_API_KEY: "stale-secret" },
      spawnImpl: fakeSpawn({ ok: true, reason_code: "configured", next_step: "start_core" }, capture),
    });
    assert.equal(result.ok, true);
    assert.ok(capture.args.includes("-UseSavedCredential"));
    assert.equal(capture.args.includes("stale-secret"), false);
    assert.equal(Object.hasOwn(capture.options.env, "CONTROL_PLANE_API_KEY"), false);
  });
});
