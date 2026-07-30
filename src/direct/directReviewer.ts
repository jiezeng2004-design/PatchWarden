import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import type { PatchWardenConfig } from "../config.js";
import { buildAgentInvocation } from "../runner/agentInvocation.js";
import { runSimpleProcessSync } from "../runner/simpleProcess.js";
import { redactSensitiveContent } from "../security/contentRedaction.js";
import { isSensitivePath } from "../security/sensitiveGuard.js";
import { atomicWriteFileSync, atomicWriteJsonFileSync } from "../utils/atomicFile.js";
import type { DirectReviewOperationType } from "./directSessionStore.js";

const REVIEW_MARKER = "===DIRECT_REVIEW_JSON===";
const REVIEW_SANDBOX_PREFIX = "patchwarden-direct-review-";
const MAX_SANDBOX_ENTRIES = 512;
const MAX_SANDBOX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_SANDBOX_HASH_BYTES = 32 * 1024 * 1024;

export interface DirectReviewerProposal {
  operation_type: DirectReviewOperationType;
  affected_paths: string[];
  content_preview: string;
  summary: string;
}

export interface DirectReviewerInput {
  reviewerAgentName: string;
  requesterAgentName: string;
  repoPath: string;
  sessionTitle: string;
  proposal: DirectReviewerProposal;
  reviewDir: string;
  timeoutSeconds: number;
  maxOutputBytes: number;
  config: PatchWardenConfig;
}

export interface DirectReviewerResult {
  status:
    | "completed"
    | "not_requested"
    | "spawn_failed"
    | "timed_out"
    | "non_zero_exit"
    | "output_truncated"
    | "parse_failed"
    | "read_only_violation"
    | "not_independent"
    | "session_changed";
  risk_level: "low" | "medium" | "high";
  reason_codes: string[];
  confidence: number | null;
  notes: string;
  read_only_violation: boolean;
}

interface ReviewerOutput {
  risk_level: "low" | "medium" | "high";
  reason_codes: string[];
  confidence: number;
  notes: string;
}

interface OwnedReviewerSandbox {
  path: string;
  realPath: string;
  parentRealPath: string;
  device: number;
  inode: number;
}

interface SandboxEntry {
  kind: "directory" | "file" | "link" | "other";
  size: number;
  mode: number;
  device: number;
  inode: number;
  modified_ms: number;
  changed_ms: number;
  sha256: string | null;
  link_target: string | null;
}

type SandboxSnapshot = Record<string, SandboxEntry>;

export async function runDirectReviewer(input: DirectReviewerInput): Promise<DirectReviewerResult> {
  if (input.reviewerAgentName === input.requesterAgentName) {
    return {
      status: "not_independent",
      risk_level: "high",
      reason_codes: ["reviewer_not_independent"],
      confidence: null,
      notes: "The configured reviewer matches the requesting Agent.",
      read_only_violation: false,
    };
  }

  const prompt = buildDirectReviewPrompt(input);
  const evidencePromptPath = resolve(input.reviewDir, "review-prompt.md");
  const stdoutPath = resolve(input.reviewDir, "review-stdout.log");
  const stderrPath = resolve(input.reviewDir, "review-stderr.log");
  const resultPath = resolve(input.reviewDir, "reviewer-result.json");
  atomicWriteFileSync(evidencePromptPath, prompt, { mode: 0o600 });

  let sandbox: OwnedReviewerSandbox;
  try {
    sandbox = createReviewerSandbox();
  } catch {
    return writeResult(resultPath, {
      status: "spawn_failed",
      risk_level: "medium",
      reason_codes: ["reviewer_sandbox_create_failed"],
      confidence: null,
      notes: "Unable to create an isolated reviewer workspace.",
      read_only_violation: false,
    });
  }

  try {
    const sandboxPromptPath = resolve(sandbox.path, "review-prompt.md");
    atomicWriteFileSync(sandboxPromptPath, prompt, { mode: 0o400 });

    let before: SandboxSnapshot;
    try {
      before = captureSandboxSnapshot(sandbox);
    } catch {
      return writeResult(resultPath, {
        status: "spawn_failed",
        risk_level: "medium",
        reason_codes: ["reviewer_sandbox_snapshot_failed"],
        confidence: null,
        notes: "Unable to capture the isolated reviewer workspace baseline.",
        read_only_violation: false,
      });
    }

    let invocation;
    try {
      // Deliberately resolve both cwd and {repo} to the empty reviewer sandbox.
      // The real Direct repository path is never provided to the reviewer.
      invocation = buildAgentInvocation(
        input.reviewerAgentName,
        sandbox.path,
        prompt,
        input.config,
        sandboxPromptPath,
      );
      if (invocationExposesRepo(invocation, input.repoPath, prompt)) {
        throw new Error("Reviewer invocation exposes the Direct repository path.");
      }
    } catch {
      return writeResult(resultPath, {
        status: "spawn_failed",
        risk_level: "medium",
        reason_codes: ["reviewer_invocation_failed"],
        confidence: null,
        notes: "The configured reviewer could not be launched in an isolated workspace.",
        read_only_violation: false,
      });
    }

    const processResult = runSimpleProcessSync({
      command: invocation.command,
      args: invocation.args,
      cwd: sandbox.path,
      timeoutMs: input.timeoutSeconds * 1000,
      maxStdoutBytes: input.maxOutputBytes,
      maxStderrBytes: Math.max(16_384, Math.floor(input.maxOutputBytes / 4)),
      stdoutPath,
      stderrPath,
      environmentVariableNames: invocation.environmentVariableNames,
      blockedEnvironmentVariableNames: invocation.blockedEnvironmentVariableNames,
      environmentOverrides: invocation.environmentOverrides,
    });

    try {
      const after = captureSandboxSnapshot(sandbox);
      if (!sandboxSnapshotsEqual(before, after)) {
        return writeResult(resultPath, {
          status: "read_only_violation",
          risk_level: "high",
          reason_codes: ["reviewer_read_only_violation"],
          confidence: null,
          notes: "The reviewer changed its isolated workspace.",
          read_only_violation: true,
        });
      }
    } catch {
      return writeResult(resultPath, {
        status: "read_only_violation",
        risk_level: "high",
        reason_codes: ["reviewer_after_snapshot_failed"],
        confidence: null,
        notes: "Unable to verify that the reviewer remained read-only in its isolated workspace.",
        read_only_violation: true,
      });
    }

    if (processResult.spawnError) {
      return writeResult(resultPath, failed("spawn_failed", "reviewer_spawn_failed"));
    }
    if (processResult.timedOut) {
      return writeResult(resultPath, failed("timed_out", "reviewer_timed_out"));
    }
    if (processResult.exitCode !== 0) {
      return writeResult(resultPath, failed("non_zero_exit", "reviewer_non_zero_exit"));
    }
    if (processResult.stdoutTruncated || processResult.stderrTruncated) {
      return writeResult(resultPath, failed("output_truncated", "reviewer_output_truncated"));
    }

    const parsed = parseReviewerOutput(processResult.stdout);
    if (!parsed) {
      return writeResult(resultPath, failed("parse_failed", "reviewer_parse_failed"));
    }
    return writeResult(resultPath, {
      status: "completed",
      risk_level: parsed.risk_level,
      reason_codes: parsed.reason_codes,
      confidence: parsed.confidence,
      notes: parsed.notes,
      read_only_violation: false,
    });
  } finally {
    cleanupReviewerSandbox(sandbox);
  }
}

function buildDirectReviewPrompt(input: DirectReviewerInput): string {
  const title = reviewerSafeText(input.sessionTitle, input.repoPath, 500);
  const requester = reviewerSafeText(input.requesterAgentName, input.repoPath, 200);
  const paths = input.proposal.affected_paths
    .map((path) => reviewerSafeText(path, input.repoPath, 500))
    .filter(Boolean)
    .slice(0, 100);
  const summary = reviewerSafeText(input.proposal.summary, input.repoPath, 2000);
  const preview = reviewerSafeText(input.proposal.content_preview, input.repoPath, 8000);
  return `You are an independent READ-ONLY security reviewer for one proposed Direct operation.

Do not create, edit, delete, rename, or generate files. Do not run network or release actions.

Session title: ${title || "(none)"}
Requesting Agent: ${requester || "(unknown)"}
Operation: ${input.proposal.operation_type}
Affected paths: ${paths.join(", ") || "(none)"}
Summary: ${summary || "(none)"}
Bounded redacted context:
${preview || "(none)"}

Assess whether this exact operation should be allowed. Consider destructive effects, scope, dependencies, sensitive data, and uncertainty. Return exactly one JSON object after ${REVIEW_MARKER}:
${REVIEW_MARKER}
{
  "risk_level": "low" | "medium" | "high",
  "reason_codes": ["short_code"],
  "confidence": 0.0,
  "notes": "short explanation"
}

Limits: at most 20 reason_codes, each at most 100 characters; notes at most 1000 characters.`;
}

function createReviewerSandbox(): OwnedReviewerSandbox {
  const parentRealPath = realpathSync(tmpdir());
  const path = mkdtempSync(join(parentRealPath, REVIEW_SANDBOX_PREFIX));
  const info = lstatSync(path, { bigint: false });
  const realPath = realpathSync(path);
  const expectedPath = resolve(path);
  if (
    !info.isDirectory()
    || info.isSymbolicLink()
    || realPath !== expectedPath
    || dirname(realPath) !== parentRealPath
    || !basename(realPath).startsWith(REVIEW_SANDBOX_PREFIX)
  ) {
    try {
      if (info.isSymbolicLink()) rmSync(path, { force: true });
      else if (info.isDirectory() && realPath === expectedPath) rmSync(path, { recursive: true, force: true });
    } catch { /* do not widen an unsafe cleanup target */ }
    throw new Error("Unsafe reviewer sandbox path.");
  }
  return {
    path,
    realPath,
    parentRealPath,
    device: Number(info.dev),
    inode: Number(info.ino),
  };
}

function cleanupReviewerSandbox(sandbox: OwnedReviewerSandbox): void {
  if (!isOwnedSandboxPath(sandbox.path, sandbox.parentRealPath)) return;
  try {
    const info = lstatSync(sandbox.path, { bigint: false });
    if (info.isSymbolicLink()) {
      // Remove only the link itself; never recursively follow a reviewer-created
      // junction or symlink during cleanup.
      rmSync(sandbox.path, { force: true });
      return;
    }
    if (
      !info.isDirectory()
      || Number(info.dev) !== sandbox.device
      || Number(info.ino) !== sandbox.inode
      || realpathSync(sandbox.path) !== sandbox.realPath
    ) {
      return;
    }
    rmSync(sandbox.path, { recursive: true, force: true });
  } catch {
    // Cleanup is best effort after identity checks. Never widen the target in
    // response to a reviewer-controlled filesystem change.
  }
}

function isOwnedSandboxPath(path: string, parentRealPath: string): boolean {
  const resolved = resolve(path);
  const rel = relative(parentRealPath, resolved);
  return Boolean(
    rel
    && rel !== ".."
    && !rel.startsWith(`..${sep}`)
    && !isAbsolute(rel)
    && !rel.includes(sep)
    && basename(resolved).startsWith(REVIEW_SANDBOX_PREFIX),
  );
}

function captureSandboxSnapshot(sandbox: OwnedReviewerSandbox): SandboxSnapshot {
  const rootInfo = lstatSync(sandbox.path, { bigint: false });
  if (
    !rootInfo.isDirectory()
    || rootInfo.isSymbolicLink()
    || Number(rootInfo.dev) !== sandbox.device
    || Number(rootInfo.ino) !== sandbox.inode
    || realpathSync(sandbox.path) !== sandbox.realPath
  ) {
    throw new Error("Reviewer sandbox identity changed.");
  }

  const result: SandboxSnapshot = {
    ".": {
      kind: "directory",
      size: rootInfo.size,
      mode: rootInfo.mode,
      device: Number(rootInfo.dev),
      inode: Number(rootInfo.ino),
      modified_ms: rootInfo.mtimeMs,
      changed_ms: rootInfo.ctimeMs,
      sha256: null,
      link_target: null,
    },
  };
  let entriesSeen = 1;
  let hashedBytes = 0;
  const visit = (directory: string) => {
    const entries = readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
      entriesSeen += 1;
      if (entriesSeen > MAX_SANDBOX_ENTRIES) throw new Error("Reviewer sandbox entry limit exceeded.");
      const absolute = join(directory, entry.name);
      const rel = relative(sandbox.path, absolute).replace(/\\/g, "/");
      if (!rel || rel === ".." || rel.startsWith("../")) throw new Error("Reviewer sandbox path escaped.");
      const info = lstatSync(absolute, { bigint: false });
      let kind: SandboxEntry["kind"] = "other";
      let sha256: string | null = null;
      let linkTarget: string | null = null;
      if (info.isSymbolicLink()) {
        kind = "link";
        linkTarget = readlinkSync(absolute);
      } else if (info.isDirectory()) {
        kind = "directory";
      } else if (info.isFile()) {
        kind = "file";
        // Never read reviewer-created credential-like files. Their mere
        // presence changes the snapshot and is already a read-only violation.
        if (!isSensitivePath(rel)) {
          if (info.size > MAX_SANDBOX_FILE_BYTES || hashedBytes + info.size > MAX_SANDBOX_HASH_BYTES) {
            throw new Error("Reviewer sandbox hash limit exceeded.");
          }
          const content = readFileSync(absolute);
          hashedBytes += content.length;
          sha256 = createHash("sha256").update(content).digest("hex");
        }
      }
      result[rel] = {
        kind,
        size: info.size,
        mode: info.mode,
        device: Number(info.dev),
        inode: Number(info.ino),
        modified_ms: info.mtimeMs,
        changed_ms: info.ctimeMs,
        sha256,
        link_target: linkTarget,
      };
      if (kind === "directory") visit(absolute);
    }
  };
  visit(sandbox.path);
  return result;
}

function sandboxSnapshotsEqual(before: SandboxSnapshot, after: SandboxSnapshot): boolean {
  return JSON.stringify(sortSnapshot(before)) === JSON.stringify(sortSnapshot(after));
}

function sortSnapshot(snapshot: SandboxSnapshot): SandboxSnapshot {
  return Object.fromEntries(Object.entries(snapshot).sort(([left], [right]) => left.localeCompare(right)));
}

function invocationExposesRepo(
  invocation: ReturnType<typeof buildAgentInvocation>,
  repoPath: string,
  prompt: string,
): boolean {
  if (textContainsPath(prompt, repoPath)) return true;
  return [invocation.cwd, invocation.command, ...invocation.args, ...Object.values(invocation.environmentOverrides)]
    .some((value) => typeof value === "string" && textContainsPath(value, repoPath));
}

function reviewerSafeText(value: string, repoPath: string, maxLength: number): string {
  let content = redactSensitiveContent(value).content;
  const absoluteRepoPath = resolve(repoPath);
  if (absoluteRepoPath !== parse(absoluteRepoPath).root) {
    for (const variant of new Set([
      absoluteRepoPath,
      absoluteRepoPath.replace(/\\/g, "/"),
      absoluteRepoPath.replace(/\//g, "\\"),
    ])) {
      content = replaceCaseInsensitive(content, variant, "[WORKSPACE]");
    }
  }
  return content
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function textContainsPath(value: string, path: string): boolean {
  const absolute = resolve(path);
  if (absolute === parse(absolute).root) return false;
  const comparableValue = value.replace(/\\/g, "/").toLowerCase();
  return comparableValue.includes(absolute.replace(/\\/g, "/").toLowerCase());
}

function replaceCaseInsensitive(value: string, search: string, replacement: string): string {
  if (!search) return value;
  let result = "";
  let offset = 0;
  const comparable = value.toLowerCase();
  const target = search.toLowerCase();
  while (true) {
    const index = comparable.indexOf(target, offset);
    if (index < 0) return result + value.slice(offset);
    result += value.slice(offset, index) + replacement;
    offset = index + search.length;
  }
}

function parseReviewerOutput(stdout: string): ReviewerOutput | null {
  const marker = stdout.lastIndexOf(REVIEW_MARKER);
  if (marker < 0) return null;
  const text = stdout.slice(marker + REVIEW_MARKER.length).trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const raw = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    const risk = raw.risk_level;
    if (risk !== "low" && risk !== "medium" && risk !== "high") return null;
    const reasons = Array.isArray(raw.reason_codes)
      ? raw.reason_codes.filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 100))
        .filter(Boolean)
        .slice(0, 20)
      : [];
    const confidence = Number(raw.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
    const notes = redactSensitiveContent(typeof raw.notes === "string" ? raw.notes : "")
      .content
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .trim()
      .slice(0, 1000);
    return { risk_level: risk, reason_codes: reasons, confidence, notes };
  } catch {
    return null;
  }
}

function failed(
  status: Extract<DirectReviewerResult["status"], "spawn_failed" | "timed_out" | "non_zero_exit" | "output_truncated" | "parse_failed">,
  code: string,
): DirectReviewerResult {
  return {
    status,
    risk_level: "medium",
    reason_codes: [code],
    confidence: null,
    notes: "The reviewer did not return a usable read-only decision.",
    read_only_violation: false,
  };
}

function writeResult(path: string, result: DirectReviewerResult): DirectReviewerResult {
  atomicWriteJsonFileSync(path, result);
  return result;
}

