import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { getPlansDir, getConfig } from "../../config.js";
import { guardReadPath } from "../../security/pathGuard.js";
import { guardSensitivePath } from "../../security/sensitiveGuard.js";
import { redactSensitiveContent } from "../../security/contentRedaction.js";

export interface GetPlanInput {
  plan_id: string;
}

export interface GetPlanOutput {
  plan_id: string;
  title: string;
  content: string;
  path: string;
  redacted?: boolean;
  redaction_categories?: string[];
}

export function getPlan(input: GetPlanInput): GetPlanOutput {
  const config = getConfig();
  const plansDir = getPlansDir(config);

  // Restrict to plans directory only
  const planDir = resolve(plansDir, input.plan_id);
  const planFile = join(planDir, "plan.md");

  guardReadPath(planFile, config.workspaceRoot, config.plansDir);
  guardSensitivePath(planFile);

  if (!existsSync(planFile)) {
    throw new Error(`Plan not found: "${input.plan_id}". Check the plan ID or save a plan first.`);
  }

  const raw = readFileSync(planFile, "utf-8");
  const redaction = redactSensitiveContent(raw);
  const titleLine = raw.split("\n")[0]?.replace(/^#\s*/, "") || input.plan_id;

  return {
    plan_id: input.plan_id,
    title: titleLine,
    content: redaction.content,
    path: planFile,
    redacted: redaction.redacted,
    redaction_categories: redaction.redaction_categories,
  };
}
