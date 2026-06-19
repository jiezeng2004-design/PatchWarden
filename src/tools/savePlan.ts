import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { getPlansDir, getConfig } from "../config.js";
import { guardPath } from "../security/pathGuard.js";
import { guardPlanContent } from "../security/planGuard.js";

export interface SavePlanInput {
  title: string;
  content: string;
}

export interface SavePlanOutput {
  plan_id: string;
  path: string;
  title: string;
}

export function savePlan(input: SavePlanInput): SavePlanOutput {
  const config = getConfig();
  const plansDir = getPlansDir(config);

  guardPlanContent(input.title, input.content);

  const planId = `plan_${Date.now()}_${sanitizeTitle(input.title)}`;
  const planDir = resolve(plansDir, planId);

  // Guards: plan dir & file must stay inside workspace
  guardPath(planDir, config.workspaceRoot, config.plansDir);
  mkdirSync(planDir, { recursive: true });

  const planFile = join(planDir, "plan.md");
  const header = `# ${input.title}\n\n> Plan ID: ${planId}\n> Created: ${new Date().toISOString()}\n\n`;
  writeFileSync(planFile, header + input.content, "utf-8");

  return {
    plan_id: planId,
    path: planFile,
    title: input.title,
  };
}

function sanitizeTitle(title: string): string {
  return title
    .replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, "_")
    .slice(0, 64);
}
