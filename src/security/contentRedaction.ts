export interface RedactionResult {
  content: string;
  redacted: boolean;
  redaction_categories: string[];
}

export interface StructuredRedactionResult<T> {
  value: T;
  redacted: boolean;
  redaction_categories: string[];
}

interface RedactionRule {
  category: string;
  reason: string;
  pattern: RegExp;
  replace: string;
}

const RULES: RedactionRule[] = [
  {
    category: "private_key",
    reason: "matched private key block",
    pattern: /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gi,
    replace: "[REDACTED PRIVATE KEY]",
  },
  {
    category: "bearer_token",
    reason: "matched bearer token",
    pattern: /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}={0,2}/gi,
    replace: "Bearer [REDACTED]",
  },
  {
    category: "npm_token",
    reason: "matched npm auth token",
    pattern: /(\b_?authToken\s*=\s*)[^\s\r\n]+/gi,
    replace: "$1[REDACTED]",
  },
  {
    category: "credential_assignment",
    reason: "matched credential assignment",
    pattern: /\b((?:(?:[A-Za-z][A-Za-z0-9]*[_ -])*(?:access[_ -]?token|refresh[_ -]?token|api[_ -]?key|secret(?:[_ -]?access)?[_ -]?key|client[_ -]?secret|private[_ -]?key|secret|password|credential|token))\s*[:=]\s*)(["']?)([^\s,"'\]}]{8,})(["']?)/gi,
    replace: "$1$2[REDACTED]$4",
  },
  {
    category: "known_token_format",
    reason: "matched known token format",
    pattern: /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}|sk_[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_-]{16,}|github_pat_[A-Za-z0-9_-]{16,}|glpat-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|(?:hf|npm)_[A-Za-z0-9_-]{16,}|(?:sk|rk)_live_[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g,
    replace: "[REDACTED TOKEN]",
  },
];

export interface RedactionCategoryCount {
  category: string;
  reason: string;
  count: number;
}

export function countRedactionsByCategory(input: string): RedactionCategoryCount[] {
  const counts = new Map<string, number>();
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    const matches = input.match(rule.pattern);
    if (matches && matches.length > 0) {
      counts.set(rule.category, (counts.get(rule.category) || 0) + matches.length);
    }
  }
  const result: RedactionCategoryCount[] = [];
  for (const rule of RULES) {
    const count = counts.get(rule.category);
    if (count) result.push({ category: rule.category, reason: rule.reason, count });
  }
  return result;
}

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

export function redactSensitiveValue<T>(input: T): StructuredRedactionResult<T> {
  const categories: string[] = [];
  const visit = (value: unknown): unknown => {
    if (typeof value === "string") {
      const result = redactSensitiveContent(value);
      categories.push(...result.redaction_categories);
      return result.content;
    }
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, visit(entry)])
      );
    }
    return value;
  };
  return {
    value: visit(input) as T,
    redacted: categories.length > 0,
    redaction_categories: [...new Set(categories)],
  };
}
