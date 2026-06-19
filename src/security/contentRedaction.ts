export interface RedactionResult {
  content: string;
  redacted: boolean;
  redaction_categories: string[];
}

interface RedactionRule {
  category: string;
  pattern: RegExp;
  replace: string;
}

const RULES: RedactionRule[] = [
  {
    category: "private_key",
    pattern: /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gi,
    replace: "[REDACTED PRIVATE KEY]",
  },
  {
    category: "bearer_token",
    pattern: /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}={0,2}/gi,
    replace: "Bearer [REDACTED]",
  },
  {
    category: "npm_token",
    pattern: /(\b_?authToken\s*=\s*)[^\s\r\n]+/gi,
    replace: "$1[REDACTED]",
  },
  {
    category: "credential_assignment",
    pattern: /\b((?:access[_ -]?token|api[_ -]?key|secret|password|credential|token)\s*[:=]\s*)(["']?)([^\s,"'\]}]{8,})(["']?)/gi,
    replace: "$1$2[REDACTED]$4",
  },
  {
    category: "known_token_format",
    pattern: /\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{16,}\b/g,
    replace: "[REDACTED TOKEN]",
  },
];

export function redactSensitiveContent(input: string): RedactionResult {
  let content = input;
  const categories: string[] = [];
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    if (!rule.pattern.test(content)) continue;
    rule.pattern.lastIndex = 0;
    content = content.replace(rule.pattern, rule.replace);
    categories.push(rule.category);
  }
  return {
    content,
    redacted: categories.length > 0,
    redaction_categories: [...new Set(categories)],
  };
}
