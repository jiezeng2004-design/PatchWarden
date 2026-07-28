import { createHash } from "node:crypto";
import { resolve } from "node:path";

/** Discriminated result of probing the local Control Center. */
export type ProbeResult =
  | { readonly kind: "patchwarden"; readonly version: string; readonly desktop_instance_sha256?: string }
  | { readonly kind: "foreign"; readonly version: null }
  | { readonly kind: "absent"; readonly version: null }
  | { readonly kind: "outdated_patchwarden"; readonly version: string }
  | { readonly kind: "mismatched_patchwarden"; readonly version: string };

/** Minimal fetch-like implementation used by probeControlCenter. */
export interface ProbeFetchImpl {
  (url: string): Promise<{ ok: boolean; json(): Promise<unknown> }>;
}

export const DEFAULT_BACKEND_START_TIMEOUT_MS = 45_000;
export const DEFAULT_BACKEND_POLL_INTERVAL_MS = 350;
export const DEFAULT_BACKEND_FINAL_PROBE_GRACE_MS = 350;

export interface BackendStartupWaitResult {
  readonly probe: ProbeResult;
  readonly elapsedMs: number;
  readonly attempts: number;
  readonly finalProbeUsed: boolean;
  readonly stoppedEarly: boolean;
}

export interface BackendStartupWaitOptions {
  readonly probe: () => Promise<ProbeResult>;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly finalProbeGraceMs?: number;
  readonly now?: () => number;
  readonly sleep?: (delayMs: number) => Promise<void>;
  readonly shouldContinue?: () => boolean;
}

/**
 * Wait for a newly spawned Control Center without dropping the readiness probe
 * that falls on the timeout boundary. A short grace period followed by one
 * final probe covers cold-start antivirus scanning and scheduler jitter.
 */
export async function waitForBackendStartup({
  probe,
  timeoutMs = DEFAULT_BACKEND_START_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_BACKEND_POLL_INTERVAL_MS,
  finalProbeGraceMs = DEFAULT_BACKEND_FINAL_PROBE_GRACE_MS,
  now = Date.now,
  sleep = (delayMs) => new Promise((resolveSleep) => setTimeout(resolveSleep, delayMs)),
  shouldContinue = () => true,
}: BackendStartupWaitOptions): Promise<BackendStartupWaitResult> {
  const startedAt = now();
  const deadline = startedAt + Math.max(0, timeoutMs);
  const interval = Math.max(1, pollIntervalMs);
  let attempts = 0;
  let lastProbe: ProbeResult = { kind: "absent", version: null };

  const result = (finalProbeUsed: boolean, stoppedEarly: boolean): BackendStartupWaitResult => ({
    probe: lastProbe,
    elapsedMs: Math.max(0, now() - startedAt),
    attempts,
    finalProbeUsed,
    stoppedEarly,
  });

  while (now() < deadline) {
    if (!shouldContinue()) return result(false, true);
    lastProbe = await probe();
    attempts += 1;
    if (lastProbe.kind !== "absent") return result(false, false);
    if (!shouldContinue()) return result(false, true);
    const remainingMs = deadline - now();
    if (remainingMs <= 0) break;
    await sleep(Math.min(interval, remainingMs));
  }

  if (!shouldContinue()) return result(false, true);
  if (finalProbeGraceMs > 0) await sleep(finalProbeGraceMs);
  if (!shouldContinue()) return result(false, true);
  lastProbe = await probe();
  attempts += 1;
  return result(true, false);
}

export function configIdentity(path: string, platform: string = process.platform): string {
  const normalized = platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
  return createHash("sha256").update(normalized).digest("hex");
}

export function desktopInstanceIdentity(instanceId: string): string {
  return createHash("sha256").update(instanceId).digest("hex");
}

export function hasExpectedDesktopInstance(probe: ProbeResult, instanceId: string): boolean {
  return probe.kind === "patchwarden"
    && typeof probe.desktop_instance_sha256 === "string"
    && probe.desktop_instance_sha256 === desktopInstanceIdentity(instanceId);
}

export async function probeControlCenter(
  fetchImpl: ProbeFetchImpl,
  baseUrl: string = "http://127.0.0.1:8090",
  expectedConfigPath: string | null = null,
  expectedVersion: string | null = null,
): Promise<ProbeResult> {
  try {
    const response = await fetchImpl(`${baseUrl}/api/diagnostics`);
    if (!response || typeof response.ok !== "boolean") return { kind: "foreign", version: null };
    if (!response.ok) return { kind: "foreign", version: null };
    const body = await response.json() as {
      server_version?: unknown;
      config_identity_sha256?: unknown;
      desktop_instance_sha256?: unknown;
    };
    if (body && typeof body.server_version === "string" && body.server_version.length > 0) {
      if (expectedConfigPath && body.config_identity_sha256 !== configIdentity(expectedConfigPath)) {
        return { kind: "mismatched_patchwarden", version: body.server_version };
      }
      if (expectedVersion && body.server_version !== expectedVersion) {
        return { kind: "outdated_patchwarden", version: body.server_version };
      }
      return {
        kind: "patchwarden",
        version: body.server_version,
        ...(typeof body.desktop_instance_sha256 === "string" ? { desktop_instance_sha256: body.desktop_instance_sha256 } : {}),
      };
    }
    return { kind: "foreign", version: null };
  } catch {
    return { kind: "absent", version: null };
  }
}

export function mayStopBackend(ownedChild: unknown, candidateChild: unknown): boolean {
  return Boolean(ownedChild && candidateChild && ownedChild === candidateChild);
}
