/**
 * Sensitive file guard: block reads of files likely to contain secrets.
 * Returns true if the file is ALLOWED (not sensitive).
 */
const SENSITIVE_PATTERNS = [
  // Exact filenames
  /(?:^|[\\/])\.env$/i,
  /(?:^|[\\/])\.env\..+$/i,
  /(?:^|[\\/])id_rsa$/i,
  /(?:^|[\\/])id_ed25519$/i,
  /(?:^|[\\/])id_ecdsa$/i,
  /(?:^|[\\/])\.ssh[\\/]/i,
  // Credentials / tokens
  /(?:^|[\\/])credentials/i,
  /(?:^|[\\/])\.?aws[\\/]credentials/i,
  /(?:^|[\\/])\.netrc$/i,
  /(?:^|[\\/])\.npmrc$/i,
  /(?:^|[\\/])\.pypirc$/i,
  /(?:^|[\\/])token/i,
  // Private keys
  /(?:^|[\\/])[^.]+\.pem$/i,
  /(?:^|[\\/])[^.]+\.key$/i,
  /(?:^|[\\/])[^.]+\.pfx$/i,
  /(?:^|[\\/])[^.]+\.p12$/i,
  // Browser data
  /(?:^|[\\/])cookies/i,
  /(?:^|[\\/])web data$/i,
  /(?:^|[\\/])login data$/i,
  /(?:^|[\\/])local state$/i,
  // Other sensitive files
  /(?:^|[\\/])\.git-credentials$/i,
  /(?:^|[\\/])\.docker[\\/]config\.json$/i,
  /(?:^|[\\/])\.kube[\\/]config$/i,
  /(?:^|[\\/])config\.json$/i, // generic config files often contain local tokens or service credentials
];

// Files specifically inside .safe-bifrost are always allowed
const SAFE_PREFIX = ".safe-bifrost";

export function isSensitivePath(filePath: string): boolean {
  // Files inside .safe-bifrost are always safe
  const normalized = filePath.replace(/\\/g, "/");
  if (normalized.includes(`${SAFE_PREFIX}/`) || normalized.endsWith(SAFE_PREFIX)) {
    return false;
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
    throw new Error(
      `Access denied: "${filePath}" matches a sensitive file pattern. Reading this file is not permitted.`
    );
  }
}
