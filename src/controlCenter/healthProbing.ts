import { get as httpGet } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { errorMessage, readJsonFileSafe } from "./helpers.js";
import { getRuntimeRoot } from "./constants.js";

// ── Health probing ────────────────────────────────────────────────

export interface HealthProbe {
  available: boolean;
  status: number | null;
  reason: string | null;
}

export function probeHealthStatus(targetUrl: string): Promise<HealthProbe> {
  return new Promise((resolve) => {
    const controller = new AbortController();
    let settled = false;
    const finish = (result: HealthProbe) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try { controller.abort(); } catch { /* ignore */ }
      finish({ available: false, status: null, reason: "timeout after 2000ms" });
    }, 2000);
    try {
      const req = httpGet(targetUrl, { signal: controller.signal }, (resp) => {
        resp.resume();
        const status = resp.statusCode ?? 0;
        if (status >= 200 && status < 300) {
          finish({ available: true, status, reason: null });
        } else {
          finish({ available: false, status, reason: `unexpected status ${status}` });
        }
      });
      req.on("error", (err) => {
        finish({ available: false, status: null, reason: err.message });
      });
    } catch (err) {
      finish({ available: false, status: null, reason: errorMessage(err) });
    }
  });
}

export interface RuntimeHealth {
  available: boolean;
  reason: string | null;
  healthz: { status: number } | null;
  readyz: { status: number } | null;
}

export async function probeRuntimeHealth(baseUrl: string): Promise<RuntimeHealth> {
  const [h, r] = await Promise.all([
    probeHealthStatus(`${baseUrl}/healthz`),
    probeHealthStatus(`${baseUrl}/readyz`),
  ]);
  if (h.available && r.available && h.status !== null && r.status !== null) {
    return { available: true, reason: null, healthz: { status: h.status }, readyz: { status: r.status } };
  }
  const failed = !h.available ? h : r;
  return { available: false, reason: failed.reason ?? "unavailable", healthz: null, readyz: null };
}

// ── Runtime file readers ──────────────────────────────────────────

export function readTunnelStatus(direct: boolean): Record<string, unknown> {
  const filePath = join(getRuntimeRoot(direct), "tunnel-status.json");
  if (!existsSync(filePath)) return { observed: false };
  try {
    const data = readJsonFileSafe<Record<string, unknown>>(filePath);
    if (data === null) return { observed: true, error: "invalid JSON" };
    return { observed: true, ...data };
  } catch (err) {
    return { observed: true, error: errorMessage(err) };
  }
}

export interface ToolManifestSummary {
  tool_profile: string | null;
  tool_count: number | null;
  schema_epoch: string | null;
  tool_manifest_sha256: string | null;
  tool_names: string[] | null;
}

export function readToolManifest(direct: boolean): ToolManifestSummary {
  const empty: ToolManifestSummary = {
    tool_profile: null,
    tool_count: null,
    schema_epoch: null,
    tool_manifest_sha256: null,
    tool_names: null,
  };
  const filePath = join(getRuntimeRoot(direct), "tool-manifest.json");
  if (!existsSync(filePath)) return empty;
  const data = readJsonFileSafe<Record<string, unknown>>(filePath);
  if (!data) return empty;
  return {
    tool_profile: typeof data.tool_profile === "string" ? data.tool_profile : null,
    tool_count: typeof data.tool_count === "number" ? data.tool_count : null,
    schema_epoch: typeof data.schema_epoch === "string" ? data.schema_epoch : null,
    tool_manifest_sha256: typeof data.tool_manifest_sha256 === "string" ? data.tool_manifest_sha256 : null,
    tool_names: Array.isArray(data.tool_names) ? (data.tool_names as string[]) : null,
  };
}

export function readTunnelUrl(direct: boolean): { url: string | null; reason: string | null } {
  const filePath = join(getRuntimeRoot(direct), "tunnel-health-url.txt");
  if (!existsSync(filePath)) return { url: null, reason: "tunnel-health-url.txt not found" };
  try {
    const content = readFileSync(filePath, "utf-8").trim();
    if (!content) return { url: null, reason: "tunnel-health-url.txt is empty" };
    return { url: content, reason: null };
  } catch (err) {
    return { url: null, reason: errorMessage(err) };
  }
}