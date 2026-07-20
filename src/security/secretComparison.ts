import { timingSafeEqual } from "node:crypto";

/** Compare secret text without content-dependent byte comparison. */
export function timingSafeStringEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, "utf-8");
  const expectedBytes = Buffer.from(expected, "utf-8");
  return actualBytes.length === expectedBytes.length
    && timingSafeEqual(actualBytes, expectedBytes);
}

export function firstHeaderValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] || "") : (value || "");
}
