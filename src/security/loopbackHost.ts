import { firstHeaderValue } from "./secretComparison.js";

const LOOPBACK_HOST_RE = /^(127\.0\.0\.1|localhost)(?::([0-9]{1,5}))?$/i;

/** Validate an HTTP Host header for a service bound to IPv4 loopback. */
export function isTrustedLoopbackHostHeader(
  value: string | string[] | undefined,
  expectedPort: number,
): boolean {
  const raw = firstHeaderValue(value).trim();
  const match = LOOPBACK_HOST_RE.exec(raw);
  if (!match) return false;
  if (match[2] === undefined) return true;
  const declaredPort = Number(match[2]);
  return Number.isInteger(declaredPort)
    && declaredPort >= 1
    && declaredPort <= 65_535
    && declaredPort === expectedPort;
}
