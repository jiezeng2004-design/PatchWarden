/**
 * Control Center auth middleware — control token validation.
 *
 * POST routes are gated behind an in-memory control token generated at boot.
 * The token is exposed read-only via GET /control-token.json (handled by the
 * server router) so the local dashboard can read it, but every mutating
 * action must pass through `checkControlToken` first.
 */
import { type IncomingMessage } from "node:http";
import { firstHeaderValue, timingSafeStringEqual } from "../../security/secretComparison.js";
import { isTrustedLoopbackHostHeader } from "../../security/loopbackHost.js";
import { controlToken } from "../shared.js";

export function checkControlToken(req: IncomingMessage): boolean {
  const provided = firstHeaderValue(req.headers["x-patchwarden-control-token"]);
  return provided.length > 0 && timingSafeStringEqual(provided, controlToken);
}

/**
 * Reject non-loopback Host headers before exposing the browser-readable
 * control token. Binding to 127.0.0.1 alone does not prevent DNS rebinding.
 */
export function isTrustedControlHost(
  req: IncomingMessage,
  expectedPort: number,
): boolean {
  return isTrustedControlHostHeader(req.headers.host, expectedPort);
}

export function isTrustedControlHostHeader(
  value: string | string[] | undefined,
  expectedPort: number,
): boolean {
  return isTrustedLoopbackHostHeader(value, expectedPort);
}
