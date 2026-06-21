import { SafeBifrostError } from "../errors.js";

interface PlanRule {
  id: string;
  category: string;
  pattern: RegExp;
  suggestion: string;
}

const PLAN_RULES: PlanRule[] = [
  {
    id: "plan_secret_access",
    category: "credential_access",
    pattern: /(?:read|open|cat|dump|extract|steal|exfiltrat\w*|leak|读取|查看|打开|导出|窃取|泄露).{0,60}(?:\.env\b|\.npmrc\b|access[ _-]?token|api[ _-]?key|token\b|credentials?\b|id_rsa\b|id_ed25519\b|ssh.{0,12}private.{0,8}key|private.{0,8}key|密钥|令牌|凭据|私钥)/is,
    suggestion: "Rewrite the plan to avoid reading, exporting, or exposing credentials and secret files.",
  },
  {
    id: "plan_secret_access_reversed",
    category: "credential_access",
    pattern: /(?:\.env\b|\.npmrc\b|access[ _-]?token|api[ _-]?key|credentials?\b|id_rsa\b|id_ed25519\b|ssh.{0,12}private.{0,8}key|private.{0,8}key|密钥|令牌|凭据|私钥).{0,60}(?:read|open|cat|dump|extract|steal|exfiltrat\w*|leak|读取|查看|打开|导出|窃取|泄露)/is,
    suggestion: "Rewrite the plan to avoid reading, exporting, or exposing credentials and secret files.",
  },
  {
    id: "plan_destructive_delete",
    category: "destructive_disk_operation",
    pattern: /(?:rm\s+-rf\s+(?:\/|~|[a-z]:[\\/])|remove-item.{0,80}(?:c:\\users|recurse.{0,20}force)|删除.{0,30}(?:用户目录|主目录|整个磁盘|全盘|系统盘)|清空.{0,20}(?:磁盘|用户目录|主目录))/is,
    suggestion: "Limit deletion to explicit project-local temporary files and require a preview or backup first.",
  },
  {
    id: "plan_malicious_persistence",
    category: "malicious_persistence_or_exfiltration",
    pattern: /(?:install|create|deploy|植入|安装|创建).{0,50}(?:backdoor|keylogger|credential stealer|data stealer|后门|键盘记录|窃密)|(?:persist|persistence|持久化).{0,40}(?:malware|payload|backdoor|恶意|后门)/is,
    suggestion: "Remove persistence, backdoor, credential theft, or data-exfiltration instructions.",
  },
];

// Negation patterns indicating the plan is about PREVENTING the action, not doing it.
// When found within the match context, the rule is skipped.
// Note: Chinese characters are not word chars (\w), so \b doesn't work for them.
// We use separate patterns with and without \b for CJK terms.
const NEGATION_PATTERNS = [
  // English negation + action
  /\b(?:do not|don't|never|must not|should not|shall not|cannot|won't|shouldn't|mustn't)\b.{0,40}(?:read|open|cat|dump|extract|steal|exfiltrat|leak|delete|remove|install|create|deploy|读取|查看|打开|导出|窃取|泄露|删除|安装|创建|植入)/is,
  // English avoidance terms + sensitive targets
  /\b(?:avoid|refrain|prevent|block|forbid)\b.{0,40}(?:read|open|cat|dump|extract|steal|exfiltrat|leak|delete|remove|install|create|deploy|\.env|token|key|credential|secret|password|读取|查看|打开|导出|窃取|泄露|删除|安装|创建|植入)/is,
  // Chinese negation/avoidance terms (no \b — CJK chars aren't word chars)
  /(?:禁止|不要|不得|严禁|避免|防止|阻止|勿|别|不可|不应).{0,40}(?:read|open|cat|dump|extract|steal|exfiltrat|leak|delete|remove|install|create|deploy|读取|查看|打开|导出|窃取|泄露|删除|安装|创建|植入|\.env|token|key|credential|secret|password|密钥|令牌|凭据|私钥)/is,
  // Chinese security hardening context
  /(?:安全.{0,10}(?:加固|修复|改进|增强|保护)|防护|脱敏|保护|防止泄露)/is,
  // Plans that describe a security FEATURE (e.g., "block credential access", "prevent token leak")
  /\b(?:security.{0,20}(?:feature|improvement|hardening|fix)|guard|protect|sanitize|redact)\b/is,
  // Plans that describe what NOT to do as a constraint
  /\b(?:constraints?|rules?|guidelines?|要求|约束|规则).{0,80}(?:do not|don't|never|must not|禁止|不要|不得|严禁)/is,
];

export function guardPlanContent(title: string, content: string): void {
  const text = `${title}\n${content}`;
  for (const rule of PLAN_RULES) {
    const match = text.match(rule.pattern);
    if (!match) continue;
    const index = match.index || 0;
    // Wider context window: 120 chars before the match
    const context = text.slice(Math.max(0, index - 120), index + match[0].length);

    // Check if any negation pattern applies in the surrounding context
    if (NEGATION_PATTERNS.some((pattern) => pattern.test(context))) {
      continue;
    }

    throw new SafeBifrostError(
      rule.id,
      `save_plan blocked content in category "${rule.category}".`,
      rule.suggestion,
      true,
      {
        operation: "save_plan",
        matched_category: rule.category,
        matched_text: match[0].slice(0, 160),
      }
    );
  }
}
