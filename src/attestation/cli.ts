#!/usr/bin/env node
import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { join } from "node:path";
import { getConfig, getTasksDir } from "../config.js";
import { redactSensitiveContent } from "../security/contentRedaction.js";
import { mutateTaskStatus } from "../runner/taskStatusStore.js";
import { atomicWriteJsonFileSync } from "../utils/atomicFile.js";
import { createTaskAttestation, type AttestationDecision } from "./attestationStore.js";

function usage(): never {
  console.error("Usage: patchwarden-attest <task_id> --accept|--reject");
  process.exit(2);
}

async function main(): Promise<void> {
  const [taskId, decisionFlag, ...extra] = process.argv.slice(2);
  if (!taskId || extra.length > 0 || !["--accept", "--reject"].includes(decisionFlag || "")) usage();
  if (!stdin.isTTY || !stdout.isTTY) throw new Error("local_attestation_requires_tty");

  const decision: AttestationDecision = decisionFlag === "--accept" ? "accepted" : "rejected";
  const config = getConfig();
  const taskDir = join(getTasksDir(config), taskId);
  const statusFile = join(taskDir, "status.json");
  if (!existsSync(statusFile)) throw new Error(`Task not found: ${taskId}`);

  const terminal = createInterface({ input: stdin, output: stdout });
  try {
    console.log(`Task: ${taskId}`);
    console.log(`Decision: ${decision}`);
    console.log("The decision will be bound to the current audit and task evidence.");
    const confirmation = await terminal.question(`Type ${taskId} to confirm: `);
    if (confirmation.trim() !== taskId) throw new Error("attestation_confirmation_mismatch");
    const rawNotes = await terminal.question("Review notes (optional): ");
    const notes = redactSensitiveContent(rawNotes).content.slice(0, 10_000);
    const attestation = createTaskAttestation({
      taskId,
      taskDir,
      workspaceRoot: config.workspaceRoot,
      decision,
      notes,
    });
    mutateTaskStatus(statusFile, (current) => {
      if (!new Set(["done", "done_by_agent", "accepted", "rejected", "needs_fix", "blocked"]).has(String(current.status || ""))) {
        throw new Error("task_not_reviewable");
      }
      const next = {
        ...current,
        acceptance_status: decision,
        acceptance_reviewed_at: attestation.reviewed_at,
        attestation_authority: "external_ledger_v1",
        updated_at: new Date().toISOString(),
      };
      return { next, result: next };
    });
    atomicWriteJsonFileSync(join(taskDir, "acceptance.json"), {
      status: decision,
      reviewed_at: attestation.reviewed_at,
      reviewer: "local_human",
      authority: "external_ledger_v1",
      evidence_sha256: attestation.evidence_sha256,
      notes,
    });
    console.log(`Recorded authoritative ${decision} attestation for ${taskId}.`);
  } finally {
    terminal.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
