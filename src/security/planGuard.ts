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

export function guardPlanContent(title: string, content: string): void {
  const text = `${title}\n${content}`;
  for (const rule of PLAN_RULES) {
    const match = text.match(rule.pattern);
    if (!match) continue;
    const index = match.index || 0;
    const context = text.slice(Math.max(0, index - 40), index + match[0].length);
    if (rule.category === "credential_access" && /(?:do not|don't|never|must not|禁止|不要|不得|严禁).{0,30}(?:read|open|cat|dump|extract|读取|查看|打开|导出)/is.test(context)) {
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
