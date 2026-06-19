export class SafeBifrostError extends Error {
  constructor(
    public readonly reason: string,
    message: string,
    public readonly suggestion: string,
    public readonly blocked = true,
    public readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "SafeBifrostError";
  }
}

export function errorPayload(error: unknown) {
  if (error instanceof SafeBifrostError) {
    return {
      blocked: error.blocked,
      reason: error.reason,
      rule_id: error.reason,
      error: error.message,
      suggestion: error.suggestion,
      ...error.details,
    };
  }
  return { error: error instanceof Error ? error.message : String(error) };
}
