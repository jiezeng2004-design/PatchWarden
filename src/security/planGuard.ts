import { PatchWardenError } from "../errors.js";
import { redactSensitiveContent } from "./contentRedaction.js";

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
    pattern: /(?:\b(?:read|open|cat|dump|extract|steal|exfiltrat\w*|leak)\b|读取|查看|打开|导出|窃取|泄露)[^.!?;。！？；\r\n]{0,60}?(?:\.env\b|\.npmrc\b|access[ _-]?token|api[ _-]?key|token\b|credentials?\b|id_rsa\b|id_ed25519\b|ssh[^.!?;。！？；\r\n]{0,12}private[^.!?;。！？；\r\n]{0,8}key|private[^.!?;。！？；\r\n]{0,8}key|密钥|令牌|凭据|私钥)/is,
    suggestion: "Rewrite the plan to avoid reading, exporting, or exposing credentials and secret files.",
  },
  {
    id: "plan_secret_access_reversed",
    category: "credential_access",
    pattern: /(?:\.env\b|\.npmrc\b|access[ _-]?token|api[ _-]?key|credentials?\b|id_rsa\b|id_ed25519\b|ssh[^.!?;。！？；\r\n]{0,12}private[^.!?;。！？；\r\n]{0,8}key|private[^.!?;。！？；\r\n]{0,8}key|密钥|令牌|凭据|私钥)[^.!?;。！？；\r\n]{0,60}?(?:\b(?:read|open|cat|dump|extract|steal|exfiltrat\w*|leak)\b|读取|查看|打开|导出|窃取|泄露)/is,
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
    pattern: /(?:\b(?:install|create|deploy)\b|植入|安装|创建).{0,50}(?:backdoor|keylogger|credential stealer|data stealer|后门|键盘记录|窃密)|(?:\b(?:persist|persistence)\b|持久化).{0,40}(?:malware|payload|backdoor|恶意|后门)/is,
    suggestion: "Remove persistence, backdoor, credential theft, or data-exfiltration instructions.",
  },
];

export function guardPlanContent(title: string, content: string): void {
  const text = `${title}\n${content}`;
  for (const rule of PLAN_RULES) {
    for (const match of text.matchAll(globalPattern(rule.pattern))) {
      const index = match.index ?? 0;
      if (isDirectlyNegated(text, index, match[0])) continue;

      throw new PatchWardenError(
        rule.id,
        `save_plan blocked content in category "${rule.category}".`,
        rule.suggestion,
        true,
        {
          operation: "save_plan",
          matched_category: rule.category,
          matched_text: redactSensitiveContent(match[0]).content.slice(0, 160),
        }
      );
    }
  }
}

function globalPattern(pattern: RegExp): RegExp {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  return new RegExp(pattern.source, flags);
}

function isDirectlyNegated(text: string, matchIndex: number, matchedText: string): boolean {
  const prefix = currentClause(text.slice(Math.max(0, matchIndex - 160), matchIndex));
  const englishDirect = /\b(?:do not|don't|never|must not|should not|shall not|cannot|can't|won't|shouldn't|mustn't|avoid|refrain from|forbids?|blocks?|prevents?)\s+(?:(?:any|all|the|a|an|users?|agents?|tools?|process(?:es)?|attempts?)\s+){0,5}(?:(?:from|to)\s+)?$/i;
  const chineseDirect = /(?:禁止|不要|不得|严禁|避免|防止|阻止|勿|别|不可|不应)(?:(?:任何|所有|用户|代理|工具|程序|进程|尝试|执行|进行)\s*){0,4}$/;
  if (englishDirect.test(prefix) || chineseDirect.test(prefix)) return true;

  const clauseAndMatch = `${prefix}${matchedText}`;
  const englishNegatedAction = /\b(?:do not|don't|never|must not|should not|shall not|cannot|can't|won't|shouldn't|mustn't|avoid|refrain from|forbids?|blocks?|prevents?)\s+(?:(?:any|all|the|a|an|users?|agents?|tools?|process(?:es)?|attempts?)\s+){0,5}(?:(?:from|to)\s+)?(?:read|open|cat|dump|extract|steal|exfiltrat\w*|leak|delete|remove|install|create|deploy)\b/i;
  const chineseNegatedAction = /(?:禁止|不要|不得|严禁|避免|防止|阻止|勿|别|不可|不应)(?:(?:任何|所有|用户|代理|工具|程序|进程|尝试|执行|进行)\s*){0,4}(?:读取|查看|打开|导出|窃取|泄露|删除|安装|创建|植入)/s;
  if (englishNegatedAction.test(clauseAndMatch) || chineseNegatedAction.test(clauseAndMatch)) return true;

  const englishReversed = /\b(?:must not|should not|shall not|cannot|can't|may not|never)\s+be\s+(?:read|opened|dumped|extracted|exported|deleted|removed|installed|created|deployed)\b/i;
  const chineseReversed = /(?:禁止|不得|严禁|不可|不应).{0,12}(?:读取|查看|打开|导出|窃取|泄露|删除|安装|创建|植入)/s;
  return englishReversed.test(matchedText) || chineseReversed.test(matchedText);
}

function currentClause(prefix: string): string {
  const boundary = Math.max(
    prefix.lastIndexOf("\n"),
    prefix.lastIndexOf("."),
    prefix.lastIndexOf("!"),
    prefix.lastIndexOf("?"),
    prefix.lastIndexOf(";"),
    prefix.lastIndexOf("。"),
    prefix.lastIndexOf("！"),
    prefix.lastIndexOf("？"),
    prefix.lastIndexOf("；")
  );
  return prefix.slice(boundary + 1);
}
