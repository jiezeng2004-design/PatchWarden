import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { detectTunnelClient, validateTunnelClientPath } from "../src/runtime-settings.mjs";

describe("desktop tunnel client discovery", () => {
  it("validates only an existing tunnel-client.exe", () => {
    const root = mkdtempSync(join(tmpdir(), "patchwarden-tunnel-"));
    const executable = join(root, "tunnel-client.exe");
    writeFileSync(executable, "fixture");
    assert.deepEqual(validateTunnelClientPath(executable), { ok: true, path: executable });
    assert.equal(validateTunnelClientPath(join(root, "other.exe")).ok, false);
  });

  it("finds a bounded workspace sibling without a machine-specific path", () => {
    const root = mkdtempSync(join(tmpdir(), "patchwarden-nearby-"));
    const workspaceRoot = join(root, "workspace", "projects");
    const toolDirectory = join(root, "workspace", "tools", "tunnel-client-v1");
    mkdirSync(workspaceRoot, { recursive: true });
    mkdirSync(toolDirectory, { recursive: true });
    const executable = join(toolDirectory, "tunnel-client.exe");
    writeFileSync(executable, "fixture");
    const result = detectTunnelClient({ config: { workspaceRoot }, env: { PATH: "" } });
    assert.equal(result.available, true);
    assert.equal(result.path, executable);
    assert.equal(result.source, "工作区附近");
  });
});
