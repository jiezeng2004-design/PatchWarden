/**
 * Control Center routes — evidence packs (/api/evidence-packs/*).
 *
 * Lists exported evidence packs (bounded to 50), reads a single pack detail,
 * and exports a pack for a lineage on demand. The export endpoint is a POST
 * route gated by the control token in the server router.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type ServerResponse } from "node:http";
import {
  exportTaskEvidencePack,
  listEvidencePacks,
  readEvidencePack,
  type SafeEvidencePack,
} from "../../tools/tasks/evidencePack.js";
import { errorMessage, sendJson, config } from "../shared.js";

function augmentEvidencePackSummary(pack: SafeEvidencePack): SafeEvidencePack & {
  export_status: "exported" | "pending";
  evidence_json_exists: boolean;
  evidence_md_exists: boolean;
  exported_at: string;
} {
  const jsonExists = existsSync(pack.files.json);
  const mdExists = existsSync(pack.files.markdown);
  return {
    ...pack,
    export_status: jsonExists ? "exported" : "pending",
    evidence_json_exists: jsonExists,
    evidence_md_exists: mdExists,
    exported_at: pack.generated_at,
  };
}

export function handleEvidencePacks(res: ServerResponse): void {
  try {
    const list = listEvidencePacks({ max_items: 50 });
    const packs = list.evidence_packs.map((pack) => augmentEvidencePackSummary(pack));
    // Detect lineages that exist but have no exported evidence pack yet, so the
    // dashboard can show an "Export evidence pack" action for the most recent one.
    const lineagesRoot = join(config.workspaceRoot, ".patchwarden", "lineages");
    let lineageCount = 0;
    const exportedIds = new Set(packs.map((p) => p.lineage_id));
    const pendingLineageIds: string[] = [];
    if (existsSync(lineagesRoot)) {
      const dirs = readdirSync(lineagesRoot, { withFileTypes: true }).filter((e) => e.isDirectory());
      lineageCount = dirs.length;
      for (const dir of dirs) {
        if (!exportedIds.has(dir.name)) pendingLineageIds.push(dir.name);
      }
    }
    sendJson(res, 200, {
      evidence_packs: packs,
      total: packs.length,
      truncated: list.truncated,
      has_lineages: lineageCount > 0,
      lineage_count: lineageCount,
      pending_lineage_ids: pendingLineageIds.slice(0, 20),
      reason: null,
    });
  } catch (err) {
    sendJson(res, 200, { evidence_packs: [], total: 0, reason: errorMessage(err) });
  }
}

export function handleEvidencePackDetail(res: ServerResponse, lineageId: string): void {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(lineageId)) {
      sendJson(res, 400, { error: "Invalid lineage id" });
      return;
    }
    const pack = readEvidencePack(lineageId);
    if (!pack) {
      sendJson(res, 404, { error: "Evidence pack not found" });
      return;
    }
    sendJson(res, 200, augmentEvidencePackSummary(pack));
  } catch (err) {
    sendJson(res, 200, { lineage_id: lineageId, error: errorMessage(err), bounded: true });
  }
}

export function handleEvidencePackExport(res: ServerResponse, lineageId: string): void {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(lineageId)) {
      sendJson(res, 400, { error: "Invalid lineage id" });
      return;
    }
    // Check lineage exists.
    const lineageFile = join(config.workspaceRoot, ".patchwarden", "lineages", lineageId, "lineage.json");
    if (!existsSync(lineageFile)) {
      sendJson(res, 404, { error: "Lineage not found" });
      return;
    }
    // Check if already exported.
    const evidenceJsonPath = join(config.workspaceRoot, ".patchwarden", "evidence-packs", lineageId, "evidence.json");
    if (existsSync(evidenceJsonPath)) {
      sendJson(res, 200, { ok: true, already_exported: true, lineage_id: lineageId });
      return;
    }
    const pack = exportTaskEvidencePack({ lineage_id: lineageId });
    sendJson(res, 200, { ok: true, exported: true, lineage_id: lineageId, evidence_pack_id: pack.evidence_pack_id });
  } catch (err) {
    sendJson(res, 200, { ok: false, lineage_id: lineageId, error: errorMessage(err) });
  }
}
