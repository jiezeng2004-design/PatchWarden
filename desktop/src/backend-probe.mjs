import { createHash } from "node:crypto";
import { resolve } from "node:path";

export function configIdentity(path, platform = process.platform) {
  const normalized = platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
  return createHash("sha256").update(normalized).digest("hex");
}

export async function probeControlCenter(fetchImpl, baseUrl = "http://127.0.0.1:8090", expectedConfigPath = null) {
  try {
    const response = await fetchImpl(`${baseUrl}/api/diagnostics`);
    if (!response || typeof response.ok !== "boolean") return { kind: "foreign", version: null };
    if (!response.ok) return { kind: "foreign", version: null };
    const body = await response.json();
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

export function mayStopBackend(ownedChild, candidateChild) {
  return Boolean(ownedChild && candidateChild && ownedChild === candidateChild);
}
