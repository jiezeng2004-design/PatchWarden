import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { resolve, join, relative } from "node:path";
import { getPlansDir, getConfig } from "../config.js";
import { guardPath } from "../security/pathGuard.js";
import { guardPlanContent } from "../security/planGuard.js";
import { PatchWardenError } from "../errors.js";

export interface SavePlanInput {
  title: string;
  content: string;
  plan_ref?: string;
}

export interface SavePlanOutput {
  plan_id: string;
  path: string;
  title: string;
}

export function savePlan(input: SavePlanInput): SavePlanOutput {
  const config = getConfig();
  const plansDir = getPlansDir(config);

  let content = input.content || "";
  let title = input.title || "";

  if (input.plan_ref) {
    // 收缩 #3: plan_ref 只能读取 .patchwarden/plans 内文件，禁止任意路径
    // plan_ref is relative to plansDir, not workspaceRoot
    const targetPath = resolve(plansDir, input.plan_ref);
    // Guard: must stay inside workspace and inside plansDir
    guardPath(targetPath, config.workspaceRoot, config.plansDir);
    const relativeToPlans = relative(plansDir, targetPath);
    if (relativeToPlans.startsWith("..")) {
      throw new PatchWardenError(
        "plan_ref_outside_plans_dir",
        `plan_ref must point to a file inside .patchwarden/plans.`,
        "Use a path relative to .patchwarden/plans/.",
        true,
        { plan_ref: input.plan_ref, resolved: targetPath }
      );
    }
    if (!existsSync(targetPath)) {
      throw new PatchWardenError(
        "plan_ref_not_found",
        `plan_ref file not found: "${input.plan_ref}".`,
        "Place the plan file under .patchwarden/plans/ first, then reference it.",
        true,
        { plan_ref: input.plan_ref }
      );
    }
    content = readFileSync(targetPath, "utf-8");
    if (!title || title.trim() === "") {
      title = "Plan from file";
    }
  } else {
    // Without plan_ref, content is required
    if (!content || content.trim() === "") {
      throw new PatchWardenError(
        "plan_content_required",
        "save_plan requires content or plan_ref.",
        "Pass content with the plan text, or use plan_ref to load a file from .patchwarden/plans."
      );
    }
  }

  // Default title when empty
  if (!title || title.trim() === "") {
    title = "Inline plan";
  }

  guardPlanContent(title, content);

  const planId = `plan_${Date.now()}_${sanitizeTitle(title)}`;
  const planDir = resolve(plansDir, planId);

  // Guards: plan dir & file must stay inside workspace
  guardPath(planDir, config.workspaceRoot, config.plansDir);
  mkdirSync(planDir, { recursive: true });

  const planFile = join(planDir, "plan.md");
  const header = `# ${title}\n\n> Plan ID: ${planId}\n> Created: ${new Date().toISOString()}\n\n`;
  writeFileSync(planFile, header + content, "utf-8");

  return {
    plan_id: planId,
    path: planFile,
    title: title,
  };
}

function sanitizeTitle(title: string): string {
  return title
    .replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, "_")
    .slice(0, 64);
}
