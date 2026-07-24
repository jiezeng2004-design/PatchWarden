const DANGEROUS_ALLOWED_TEST_COMMAND_PATTERNS = [
  /(^|\s)rm\s+-rf(?:\s|$)/i,
  /(^|\s)del\s+\/s(?:\s|$)/i,
  /(^|\s)format(?:\.exe)?(?:\s|$)/i,
  /(^|\s)shutdown(?:\.exe)?(?:\s|$)/i,
  /curl\s+[^\r\n|]*\|/i,
  /wget\s+[^\r\n|]*\|/i,
];

export function isDangerousAllowedTestCommand(command: string): boolean {
  return DANGEROUS_ALLOWED_TEST_COMMAND_PATTERNS.some((pattern) => pattern.test(command));
}
