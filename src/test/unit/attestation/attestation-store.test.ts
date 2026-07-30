import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  computeTaskEvidenceDigest,
  createTaskAttestation,
  registerTaskAttestationRequirement,
  verifyTaskAttestation,
  workspaceAttestationId,
} from "../../../attestation/attestationStore.js";

describe("authoritative task attestation", () => {
  let root: string;
  let workspace: string;
  let store: string;
  let taskDir: string;
  const taskId = "task_20260729_attest";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pw-attestation-"));
    workspace = join(root, "workspace");
    store = join(root, "external-ledger");
    taskDir = join(workspace, ".patchwarden", "tasks", taskId);
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "audit.json"), JSON.stringify({ acceptance: { status: "accepted" } }));
    writeFileSync(join(taskDir, "result.md"), "verified result");
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("fails closed when workspace acceptance is forged but the external record is missing", () => {
    registerTaskAttestationRequirement(taskId, workspace, { baseDir: store });
    writeFileSync(join(taskDir, "acceptance.json"), JSON.stringify({ status: "accepted", reviewer: "human" }));
    const result = verifyTaskAttestation(taskId, taskDir, workspace, { baseDir: store });
    assert.equal(result.required, true);
    assert.equal(result.valid, false);
    assert.equal(result.reason, "attestation_missing");
  });

  it("binds a signed local-human decision to the current evidence digest", () => {
    registerTaskAttestationRequirement(taskId, workspace, { baseDir: store });
    const digest = computeTaskEvidenceDigest(taskDir);
    const record = createTaskAttestation({
      taskId,
      taskDir,
      workspaceRoot: workspace,
      decision: "accepted",
      notes: "reviewed",
    }, { baseDir: store, allowNonTty: true });
    assert.equal(record.evidence_sha256, digest);
    assert.deepEqual(verifyTaskAttestation(taskId, taskDir, workspace, { baseDir: store }), {
      required: true,
      legacy: false,
      valid: true,
      decision: "accepted",
      reason: "verified",
      attestation: record,
    });

    writeFileSync(join(taskDir, "result.md"), "changed after review");
    assert.equal(
      verifyTaskAttestation(taskId, taskDir, workspace, { baseDir: store }).reason,
      "attestation_evidence_changed",
    );
  });

  it("rejects a tampered external ledger record", () => {
    registerTaskAttestationRequirement(taskId, workspace, { baseDir: store });
    createTaskAttestation({
      taskId,
      taskDir,
      workspaceRoot: workspace,
      decision: "accepted",
    }, { baseDir: store, allowNonTty: true });
    const recordPath = join(store, workspaceAttestationId(workspace), "records", `${taskId}.json`);
    const record = JSON.parse(readFileSync(recordPath, "utf-8"));
    record.decision = "rejected";
    writeFileSync(recordPath, JSON.stringify(record));
    assert.equal(
      verifyTaskAttestation(taskId, taskDir, workspace, { baseDir: store }).reason,
      "attestation_signature_invalid",
    );
  });

  it("requires an interactive terminal for production attestation", () => {
    registerTaskAttestationRequirement(taskId, workspace, { baseDir: store });
    assert.throws(() => createTaskAttestation({
      taskId,
      taskDir,
      workspaceRoot: workspace,
      decision: "accepted",
    }, { baseDir: store }), /local_attestation_requires_tty/);
  });

  it("refuses acceptance when the machine audit has not accepted the task", () => {
    writeFileSync(join(taskDir, "audit.json"), JSON.stringify({ acceptance: { status: "needs_fix" } }));
    registerTaskAttestationRequirement(taskId, workspace, { baseDir: store });
    assert.throws(() => createTaskAttestation({
      taskId,
      taskDir,
      workspaceRoot: workspace,
      decision: "accepted",
    }, { baseDir: store, allowNonTty: true }), /attestation_machine_audit_not_accepted/);
  });
});
