import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { atomicWriteJsonFileSync } from "../utils/atomicFile.js";
import { stableJsonStringify } from "../utils/stableJson.js";

const REQUIREMENT_SCHEMA = "patchwarden-attestation-requirement-v1";
const ATTESTATION_SCHEMA = "patchwarden-task-attestation-v1";
const EVIDENCE_FILES = [
  "audit.json",
  "independent-review.md",
  "ACCEPTANCE.md",
  "result.json",
  "result.md",
  "verify.json",
  "changed-files.json",
  "git-before.json",
  "git-after.json",
  "git.diff",
] as const;

export type AttestationDecision = "accepted" | "rejected";

interface SignedRecord {
  signature: string;
}

export interface AttestationRequirement extends SignedRecord {
  schema_version: typeof REQUIREMENT_SCHEMA;
  workspace_id: string;
  task_id: string;
  created_at: string;
  nonce: string;
}

export interface TaskAttestation extends SignedRecord {
  schema_version: typeof ATTESTATION_SCHEMA;
  workspace_id: string;
  task_id: string;
  decision: AttestationDecision;
  reviewed_at: string;
  reviewer: "local_human";
  evidence_sha256: string;
  requirement_nonce: string;
  notes: string;
}

export interface AttestationVerification {
  required: boolean;
  legacy: boolean;
  valid: boolean;
  decision: AttestationDecision | null;
  reason: string;
  attestation: TaskAttestation | null;
}

export interface AttestationStoreOptions {
  /** Test-only dependency injection. Production callers must omit this. */
  baseDir?: string;
  /** Test-only bypass. Production callers must require a real terminal. */
  allowNonTty?: boolean;
}

function defaultBaseDir(): string {
  // Trusted process-level override for isolated dev/CI runs. Agent child
  // processes cannot alter the already-running Core process environment.
  if (process.env.PATCHWARDEN_ATTESTATION_DIR) {
    return resolve(process.env.PATCHWARDEN_ATTESTATION_DIR);
  }
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) return join(localAppData, "PatchWarden", "attestations");
  }
  const home = homedir();
  return home ? join(home, ".patchwarden", "attestations") : join(tmpdir(), "patchwarden-attestations");
}

function normalizeWorkspace(workspaceRoot: string): string {
  const absolute = resolve(workspaceRoot);
  const canonical = existsSync(absolute) ? realpathSync.native(absolute) : absolute;
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

export function workspaceAttestationId(workspaceRoot: string): string {
  return createHash("sha256").update(normalizeWorkspace(workspaceRoot)).digest("hex");
}

function validateTaskId(taskId: string): void {
  if (!/^task[_-][A-Za-z0-9_-]{1,160}$/.test(taskId)) {
    throw new Error("invalid_attestation_task_id");
  }
}

function storePaths(workspaceRoot: string, taskId: string, options: AttestationStoreOptions = {}) {
  validateTaskId(taskId);
  const baseDir = resolve(options.baseDir || defaultBaseDir());
  const workspaceId = workspaceAttestationId(workspaceRoot);
  const workspaceDir = join(baseDir, workspaceId);
  return {
    baseDir,
    workspaceId,
    workspaceDir,
    keyPath: join(baseDir, "ledger.key"),
    requirementPath: join(workspaceDir, "requirements", `${taskId}.json`),
    attestationPath: join(workspaceDir, "records", `${taskId}.json`),
  };
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("attestation_directory_invalid");
}

function loadOrCreateKey(baseDir: string, keyPath: string): Buffer {
  ensurePrivateDirectory(baseDir);
  if (!existsSync(keyPath)) {
    try {
      writeFileSync(keyPath, randomBytes(32), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const stat = lstatSync(keyPath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("attestation_key_invalid");
  const key = readFileSync(keyPath);
  if (key.length !== 32) throw new Error("attestation_key_invalid");
  return key;
}

function signRecord(record: Omit<SignedRecord, "signature">, key: Buffer): string {
  return createHmac("sha256", key).update(stableJsonStringify(record)).digest("hex");
}

function verifySignedRecord(record: SignedRecord & Record<string, unknown>, key: Buffer): boolean {
  if (!/^[a-f0-9]{64}$/.test(record.signature || "")) return false;
  const { signature, ...unsigned } = record;
  const expected = Buffer.from(signRecord(unsigned, key), "hex");
  const actual = Buffer.from(signature, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function readJsonRecord(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) return null;
    const value = JSON.parse(readFileSync(path, "utf-8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function registerTaskAttestationRequirement(
  taskId: string,
  workspaceRoot: string,
  options: AttestationStoreOptions = {},
): AttestationRequirement {
  const paths = storePaths(workspaceRoot, taskId, options);
  const key = loadOrCreateKey(paths.baseDir, paths.keyPath);
  const existing = readJsonRecord(paths.requirementPath);
  if (existing) {
    if (!verifySignedRecord(existing as SignedRecord & Record<string, unknown>, key)
      || existing.schema_version !== REQUIREMENT_SCHEMA
      || existing.workspace_id !== paths.workspaceId
      || existing.task_id !== taskId) {
      throw new Error("attestation_requirement_invalid");
    }
    return existing as unknown as AttestationRequirement;
  }
  const unsigned = {
    schema_version: REQUIREMENT_SCHEMA,
    workspace_id: paths.workspaceId,
    task_id: taskId,
    created_at: new Date().toISOString(),
    nonce: randomBytes(24).toString("hex"),
  } as const;
  const requirement: AttestationRequirement = { ...unsigned, signature: signRecord(unsigned, key) };
  ensurePrivateDirectory(resolve(paths.requirementPath, ".."));
  atomicWriteJsonFileSync(paths.requirementPath, requirement, 0o600);
  return requirement;
}

export function computeTaskEvidenceDigest(taskDir: string): string {
  const absoluteTaskDir = resolve(taskDir);
  const taskStat = lstatSync(absoluteTaskDir);
  if (taskStat.isSymbolicLink() || !taskStat.isDirectory()) throw new Error("attestation_task_directory_invalid");
  const canonicalTaskDir = realpathSync.native(absoluteTaskDir);
  const hash = createHash("sha256");
  hash.update("patchwarden-task-evidence-v1\0");
  for (const name of EVIDENCE_FILES) {
    const path = join(absoluteTaskDir, name);
    hash.update(name);
    hash.update("\0");
    if (!existsSync(path)) {
      hash.update("missing\0");
      continue;
    }
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("attestation_evidence_file_invalid");
    const canonicalFile = realpathSync.native(path);
    const rel = relative(canonicalTaskDir, canonicalFile);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("attestation_evidence_outside_task");
    hash.update(createHash("sha256").update(readFileSync(path)).digest());
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function createTaskAttestation(input: {
  taskId: string;
  taskDir: string;
  workspaceRoot: string;
  decision: AttestationDecision;
  notes?: string;
}, options: AttestationStoreOptions = {}): TaskAttestation {
  if (!options.allowNonTty && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new Error("local_attestation_requires_tty");
  }
  const paths = storePaths(input.workspaceRoot, input.taskId, options);
  const key = loadOrCreateKey(paths.baseDir, paths.keyPath);
  const requirementRecord = readJsonRecord(paths.requirementPath);
  if (!requirementRecord
    || !verifySignedRecord(requirementRecord as SignedRecord & Record<string, unknown>, key)
    || requirementRecord.schema_version !== REQUIREMENT_SCHEMA
    || requirementRecord.workspace_id !== paths.workspaceId
    || requirementRecord.task_id !== input.taskId) {
    throw new Error("attestation_requirement_missing_or_invalid");
  }
  const taskDir = resolve(input.taskDir);
  if (basename(taskDir) !== input.taskId) throw new Error("attestation_task_path_mismatch");
  const audit = readJsonRecord(join(taskDir, "audit.json"));
  const machineStatus = (audit?.acceptance as Record<string, unknown> | undefined)?.status;
  if (input.decision === "accepted" && machineStatus !== "accepted") {
    throw new Error("attestation_machine_audit_not_accepted");
  }
  const notes = String(input.notes || "").slice(0, 10_000);
  const unsigned = {
    schema_version: ATTESTATION_SCHEMA,
    workspace_id: paths.workspaceId,
    task_id: input.taskId,
    decision: input.decision,
    reviewed_at: new Date().toISOString(),
    reviewer: "local_human" as const,
    evidence_sha256: computeTaskEvidenceDigest(taskDir),
    requirement_nonce: String(requirementRecord.nonce),
    notes,
  } as const;
  const attestation: TaskAttestation = { ...unsigned, signature: signRecord(unsigned, key) };
  ensurePrivateDirectory(resolve(paths.attestationPath, ".."));
  atomicWriteJsonFileSync(paths.attestationPath, attestation, 0o600);
  return attestation;
}

export function verifyTaskAttestation(
  taskId: string,
  taskDir: string,
  workspaceRoot: string,
  options: AttestationStoreOptions = {},
): AttestationVerification {
  const paths = storePaths(workspaceRoot, taskId, options);
  if (!existsSync(paths.requirementPath)) {
    return { required: false, legacy: true, valid: false, decision: null, reason: "legacy_unattested", attestation: null };
  }
  let key: Buffer;
  try {
    const keyStat = lstatSync(paths.keyPath);
    if (keyStat.isSymbolicLink() || !keyStat.isFile()) throw new Error("invalid key path");
    key = readFileSync(paths.keyPath);
    if (key.length !== 32) throw new Error("invalid key");
  } catch {
    return { required: true, legacy: false, valid: false, decision: null, reason: "attestation_key_invalid", attestation: null };
  }
  const requirement = readJsonRecord(paths.requirementPath);
  if (!requirement
    || !verifySignedRecord(requirement as SignedRecord & Record<string, unknown>, key)
    || requirement.schema_version !== REQUIREMENT_SCHEMA
    || requirement.workspace_id !== paths.workspaceId
    || requirement.task_id !== taskId) {
    return { required: true, legacy: false, valid: false, decision: null, reason: "attestation_requirement_invalid", attestation: null };
  }
  const record = readJsonRecord(paths.attestationPath);
  if (!record) {
    return { required: true, legacy: false, valid: false, decision: null, reason: "attestation_missing", attestation: null };
  }
  const validShape = record.schema_version === ATTESTATION_SCHEMA
    && record.workspace_id === paths.workspaceId
    && record.task_id === taskId
    && (record.decision === "accepted" || record.decision === "rejected")
    && record.reviewer === "local_human"
    && record.requirement_nonce === requirement.nonce;
  if (!validShape || !verifySignedRecord(record as SignedRecord & Record<string, unknown>, key)) {
    return { required: true, legacy: false, valid: false, decision: null, reason: "attestation_signature_invalid", attestation: null };
  }
  const attestation = record as unknown as TaskAttestation;
  if (attestation.evidence_sha256 !== computeTaskEvidenceDigest(taskDir)) {
    return { required: true, legacy: false, valid: false, decision: attestation.decision, reason: "attestation_evidence_changed", attestation };
  }
  return { required: true, legacy: false, valid: true, decision: attestation.decision, reason: "verified", attestation };
}
