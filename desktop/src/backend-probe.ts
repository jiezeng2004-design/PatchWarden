import { createHash } from "node:crypto";
import { resolve } from "node:path";

/** Discriminated result of probing the local Control Center. */
export type ProbeResult =
  | { readonly kind: "patchwarden"; readonly version: string }
  | { readonly kind: "foreign"; readonly version: null }
  | { readonly kind: "absent"; readonly version: null }
  | { readonly kind: "mismatched_patchwarden"; readonly version: string };

/** Minimal fetch-like implementation used by probeControlCenter. */
export interface ProbeFetchImpl {
  (url: string): Promise<{ ok: boolean; json(): Promise<unknown> }>;
}

export function configIdentity(path: string, platform: string = process.platform): string {
  const normalized = platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
  return createHash("sha256").update(normalized).digest("hex");
}

export async function probeControlCenter(
  fetchImpl: ProbeFetchImpl,
  baseUrl: string = "http://127.0.0.1:8090",
  expectedConfigPath: string | null = null,
): Promise<ProbeResult> {
  try {
    const response = await fetchImpl(`${baseUrl}/api/diagnostics`);
    if (!response || typeof response.ok !== "boolean") return { kind: "foreign", version: null };
    if (!response.ok) return { kind: "foreign", version: null };
    const body = await response.json() as { server_version?: unknown; config_identity_sha256?: unknown };
    if (body && typeof body.server_version === "string" && body.server_version.length > 0) {
      if (expectedConfigPath && body.config_identity_sha256 !== configIdentity(expectedConfigPath)) {
        return { kind: "mismatched_patchwarden", version: body.server_version };
      }
      return { kind: "patchwarden", version: body.server_version };
    }
    return { kind: "foreign", version: null };
  } catch {
    return { kind: "absent", version: null };
  }
}

export function mayStopBackend(ownedChild: unknown, candidateChild: unknown): boolean {
  return Boolean(ownedChild && candidateChild && ownedChild === candidateChild);
}
