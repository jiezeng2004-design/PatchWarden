/**
 * Control Center auth middleware — control token validation.
 *
 * POST routes are gated behind an in-memory control token generated at boot.
 * The token is exposed read-only via GET /control-token.json (handled by the
 * server router) so the local dashboard can read it, but every mutating
 * action must pass through `checkControlToken` first.
 */
import { type IncomingMessage } from "node:http";
import { controlToken } from "../shared.js";

export function checkControlToken(req: IncomingMessage): boolean {
  const header = req.headers["x-patchwarden-control-token"];
  const provided = Array.isArray(header) ? header[0] : header;
  if (typeof provided !== "string" || provided.length === 0) return false;
  return provided === controlToken;
}
