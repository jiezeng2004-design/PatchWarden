import { PatchWardenError } from "../errors.js";

/**
 * Sensitive file guard: block reads of files likely to contain secrets.
 * Returns true if the file is ALLOWED (not sensitive).
 */
const SENSITIVE_PATTERNS = [
  // Exact filenames
  /(?:^|[\\/])\.env$/i,
  /(?:^|[\\/])\.env\..+$/i,
  /(?:^|[\\/])\.envrc$/i,
  /(?:^|[\\/])id_rsa$/i,
  /(?:^|[\\/])id_dsa$/i,
  /(?:^|[\\/])id_ed25519$/i,
  /(?:^|[\\/])id_ecdsa$/i,
  /(?:^|[\\/])\.ssh[\\/]/i,
  // Credentials / tokens
  /(?:^|[\\/])credentials(?:\.(?:txt|json|ya?ml|toml|ini|cfg|db))?$/i,
  /(?:^|[\\/])\.?aws[\\/]credentials/i,
  /(?:^|[\\/])\.netrc$/i,
  /(?:^|[\\/])\.npmrc$/i,
  /(?:^|[\\/])\.pypirc$/i,
  /(?:^|[\\/])token$/i,
  /(?:^|[\\/])tokens?\.(?:txt|json|ya?ml|toml|ini|cfg|db)$/i,
  /(?:^|[\\/])token[-_](?:store|cache|data|secret|auth|credentials|backup|local|prod|production|dev|development)(?:\.[^\\/]+)?$/i,
  /(?:^|[\\/])(?:access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret)(?:\.(?:txt|json|ya?ml|ini|cfg))?$/i,
  // Private keys
  /(?:^|[\\/])[^.]+\.pem$/i,
  /(?:^|[\\/])[^.]+\.key$/i,
  /(?:^|[\\/])[^.]+\.pfx$/i,
  /(?:^|[\\/])[^.]+\.p12$/i,
  /(?:^|[\\/])[^.]+\.ppk$/i,
  // Browser data
  /(?:^|[\\/])cookies/i,
  /(?:^|[\\/])web data$/i,
  /(?:^|[\\/])login data$/i,
  /(?:^|[\\/])local state$/i,
  // Other sensitive files
  /(?:^|[\\/])\.git-credentials$/i,
  /(?:^|[\\/])\.git[\\/]config$/i,
  /(?:^|[\\/])\.docker[\\/]config\.json$/i,
  /(?:^|[\\/])\.kube[\\/]config$/i,
  /(?:^|[\\/])kubeconfig$/i,
  /(?:^|[\\/])application_default_credentials\.json$/i,
  /(?:^|[\\/])service[-_]?account(?:[-_][^\\/]+)?\.json$/i,
  /(?:^|[\\/])config\.json$/i, // generic config files often contain local tokens or service credentials
];

/**
 * Detect a Windows NTFS alternate data stream suffix. The colon in an
 * absolute drive prefix (for example, C:\\) is the only permitted colon.
 */
export function hasWindowsAlternateDataStream(filePath: string): boolean {
  const withoutDrivePrefix = /^[A-Za-z]:[\\/]/.test(filePath)
    ? filePath.slice(2)
    : filePath;
  return withoutDrivePrefix.includes(":");
}

export function isSensitivePath(filePath: string): boolean {
  if (filePath.includes("\0")) return true;

  // ADS can hide content behind an otherwise safe-looking filename.
  if (hasWindowsAlternateDataStream(filePath)) {
    return true;
  }

  for (const pattern of SENSITIVE_PATTERNS) {
    if (pattern.test(filePath)) {
      return true;
    }
  }

  return false;
}

export function guardSensitivePath(filePath: string): void {
  if (isSensitivePath(filePath)) {
    throw new PatchWardenError(
      "sensitive_path_blocked",
      `Access denied: "${filePath}" matches a sensitive file pattern. Reading this file is not permitted.`,
      "Read only non-sensitive task artifacts or workspace files.",
      true,
      {
        path: filePath,
        operation: "read",
        safe_alternative: "Read a non-sensitive task artifact, or remove secret material and retry.",
      }
    );
  }
}
