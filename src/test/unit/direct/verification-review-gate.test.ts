import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { reloadConfig } from "../../../config.js";
import { requestDirectReview, type RequestDirectReviewInput } from "../../../direct/directReviewGate.js";
import {
  createDirectSession,
  getDirectSessionDir,
  readDirectSession,
} from "../../../direct/directSessionStore.js";
import { PatchWardenError } from "../../../errors.js";
import { runDirectVerificationBundle } from "../../../tools/direct/runDirectVerificationBundle.js";
import { finalizeDirectSession } from "../../../tools/direct/finalizeDirectSession.js";
import { auditSession } from "../../../tools/diagnostics/auditSession.js";
import { runVerification } from "../../../tools/tasks/runVerification.js";

describe("Direct verification review gate", () => {
  let root: string;
  let repoPath: string;
  let sessionId: string;
  let configPath: string;
  const originalConfigPath = process.env.PATCHWARDEN_CONFIG;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "patchwarden-verification-review-"));
    repoPath = join(root, "repo");
    mkdirSync(repoPath, { recursive: true });
    configPath = join(root, "patchwarden.config.json");
    writeDirectReviewConfig("enforce");
    process.env.PATCHWARDEN_CONFIG = configPath;
    reloadConfig();

    const now = new Date().toISOString();
    sessionId = createDirectSession({
      repo_path: "repo",
      resolved_repo_path: repoPath,
      requester_agent: "requester",
      expected_changes: false,
      snapshot: {
        captured_at: now,
        is_git: false,
        head: null,
        status: "",
        workspace_dirty: false,
        files: {},
        dirty_paths: [],
        warnings: [],
      },
    }).session_id;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (originalConfigPath === undefined) delete process.env.PATCHWARDEN_CONFIG;
    else process.env.PATCHWARDEN_CONFIG = originalConfigPath;
    reloadConfig();
  });

  it("requires and consumes one matching ticket for run_verification", async () => {
    await assert.rejects(
      runVerification({ session_id: sessionId, command: "node --version" }),
      (error: unknown) => error instanceof PatchWardenError && error.reason === "direct_review_required",
    );

    const review = await requestAllowedReview({
      session_id: sessionId,
      operation_type: "verification",
      command: "node --version",
    });
    const result = await runVerification({
      session_id: sessionId,
      command: "node --version",
      review_id: review.review_id,
    });

    assert.equal(result.passed, true);
    assert.equal(readDirectSession(sessionId).verification_runs.length, 1);
    const record = readReviewRecord(review.review_id);
    assert.equal(record.operation_type, "verification");
    assert.equal(record.execution_status, "executed");
    assert.equal(typeof record.used_at, "string");
  });

  it("uses one bundle ticket for all commands and keeps each run as audit evidence", async () => {
    const commands = ["node --version", "node --version"];
    const review = await requestAllowedReview({
      session_id: sessionId,
      operation_type: "verification_bundle",
      commands,
    });
    const result = await runDirectVerificationBundle({
      session_id: sessionId,
      commands,
      review_id: review.review_id,
    });

    assert.equal(result.status, "passed");
    assert.equal(result.command_count, 2);
    const session = readDirectSession(sessionId);
    assert.equal(session.verification_runs.length, 2);
    assert.deepEqual(session.verification_runs.map((entry) => entry.command), commands);
    assert.deepEqual(session.review_events.map((entry) => ({
      review_id: entry.review_id,
      operation_type: entry.operation_type,
      status: entry.status,
    })), [{
      review_id: review.review_id,
      operation_type: "verification_bundle",
      status: "executed",
    }]);
    const record = readReviewRecord(review.review_id);
    assert.equal(record.operation_type, "verification_bundle");
    assert.equal(record.execution_status, "executed");
    assert.equal(typeof record.used_at, "string");
  });

  it("does not consume a verification ticket after repository semantics drift", async () => {
    const scriptPath = join(repoPath, "verify-script.mjs");
    writeFileSync(scriptPath, "process.exit(0);\n", "utf-8");
    const review = await requestAllowedReview({
      session_id: sessionId,
      operation_type: "verification",
      command: "node verify-script.mjs",
    });
    writeFileSync(scriptPath, "process.exit(7);\n", "utf-8");

    await assert.rejects(
      runVerification({
        session_id: sessionId,
        command: "node verify-script.mjs",
        review_id: review.review_id,
      }),
      (error: unknown) => error instanceof PatchWardenError && error.reason === "direct_review_mismatch",
    );
    assert.equal(readReviewRecord(review.review_id).used_at, null);
    assert.equal(readDirectSession(sessionId).verification_runs.length, 0);
  });

  it("does not consume a verification ticket when a reviewed script link is retargeted", async (t) => {
    const allowed = join(repoPath, "allowed.mjs");
    const changed = join(repoPath, "changed.mjs");
    const scriptPath = join(repoPath, "verify-script.mjs");
    writeFileSync(allowed, "process.exit(0);\n", "utf-8");
    writeFileSync(changed, "process.exit(7);\n", "utf-8");
    if (!tryCreateFileLink("allowed.mjs", scriptPath)) {
      t.skip("File symlink creation is unavailable on this Windows host.");
      return;
    }
    const review = await requestAllowedReview({
      session_id: sessionId,
      operation_type: "verification",
      command: "node verify-script.mjs",
    });
    unlinkSync(scriptPath);
    symlinkSync("changed.mjs", scriptPath, "file");

    await assert.rejects(
      runVerification({
        session_id: sessionId,
        command: "node verify-script.mjs",
        review_id: review.review_id,
      }),
      (error: unknown) => error instanceof PatchWardenError && error.reason === "direct_review_mismatch",
    );
    assert.equal(readReviewRecord(review.review_id).used_at, null);
    assert.equal(readDirectSession(sessionId).verification_runs.length, 0);
  });

  it("invalidates a verification ticket when dependency metadata changes", async () => {
    const lockPath = join(repoPath, "package-lock.json");
    writeFileSync(lockPath, "{\"lockfileVersion\":3,\"packages\":{}}\n", "utf-8");
    const review = await requestAllowedReview({
      session_id: sessionId,
      operation_type: "verification",
      command: "node --version",
    });
    writeFileSync(lockPath, "{\"lockfileVersion\":3,\"packages\":{\"node_modules/example\":{}}}\n", "utf-8");

    await assert.rejects(
      runVerification({
        session_id: sessionId,
        command: "node --version",
        review_id: review.review_id,
      }),
      (error: unknown) => error instanceof PatchWardenError && error.reason === "direct_review_mismatch",
    );
    assert.equal(readReviewRecord(review.review_id).used_at, null);
    assert.equal(readDirectSession(sessionId).verification_runs.length, 0);
  });

  it("invalidates a verification ticket when an installed dependency changes", async () => {
    const dependencyRoot = join(repoPath, "node_modules", "example");
    const dependencyEntry = join(dependencyRoot, "index.cjs");
    const scriptPath = join(repoPath, "verify-script.mjs");
    mkdirSync(dependencyRoot, { recursive: true });
    writeFileSync(join(dependencyRoot, "package.json"), "{\"name\":\"example\",\"main\":\"index.cjs\"}\n", "utf-8");
    writeFileSync(dependencyEntry, "module.exports = 0;\n", "utf-8");
    writeFileSync(scriptPath, "process.exit(require(\"example\"));\n", "utf-8");
    const review = await requestAllowedReview({
      session_id: sessionId,
      operation_type: "verification",
      command: "node verify-script.mjs",
    });
    writeFileSync(dependencyEntry, "module.exports = 7;\n", "utf-8");

    await assert.rejects(
      runVerification({
        session_id: sessionId,
        command: "node verify-script.mjs",
        review_id: review.review_id,
      }),
      (error: unknown) => error instanceof PatchWardenError && error.reason === "direct_review_mismatch",
    );
    assert.equal(readReviewRecord(review.review_id).used_at, null);
    assert.equal(readDirectSession(sessionId).verification_runs.length, 0);
  });

  it("keeps shadow verification running while recording an incomplete dependency snapshot as would_block", async () => {
    writeDirectReviewConfig("shadow");
    reloadConfig();
    const now = new Date().toISOString();
    const shadowSessionId = createDirectSession({
      repo_path: "repo",
      resolved_repo_path: repoPath,
      requester_agent: "requester",
      expected_changes: false,
      snapshot: {
        captured_at: now,
        is_git: false,
        head: null,
        status: "",
        workspace_dirty: false,
        files: {},
        dirty_paths: [],
        warnings: [],
      },
    }).session_id;
    const dependencyRoot = join(repoPath, "node_modules", "example");
    mkdirSync(dependencyRoot, { recursive: true });
    writeFileSync(join(dependencyRoot, ".env"), "DO_NOT_READ=secret\n", "utf-8");
    let reviewerCalled = false;
    const review = await requestDirectReview({
      session_id: shadowSessionId,
      operation_type: "verification",
      command: "node --version",
    }, {
      reviewer: async () => {
        reviewerCalled = true;
        throw new Error("The deterministic snapshot failure must skip reviewer execution.");
      },
      now: () => new Date(),
    });
    assert.equal(reviewerCalled, false);
    assert.equal(review.decision, "blocked");
    assert.ok(review.reason_codes.includes("direct_verification_workspace_snapshot_incomplete"));

    const result = await runVerification({
      session_id: shadowSessionId,
      command: "node --version",
      review_id: review.review_id,
    });
    assert.equal(result.passed, true);
    const event = readDirectSession(shadowSessionId).review_events.at(-1);
    assert.equal(event?.status, "would_block");
    assert.ok(event?.reason_codes.includes("direct_verification_workspace_snapshot_incomplete"));
  });

  it("keeps an authenticated enforce receipt valid through Direct audit", async () => {
    const review = await requestAllowedReview({
      session_id: sessionId,
      operation_type: "verification",
      command: "node --version",
    });
    await runVerification({
      session_id: sessionId,
      command: "node --version",
      review_id: review.review_id,
    });
    await finalizeDirectSession({ session_id: sessionId });
    const audit = auditSession({ session_id: sessionId });
    assert.equal(audit.reason_codes.includes("direct_review_receipt_invalid"), false);
  });

  async function requestAllowedReview(input: RequestDirectReviewInput) {
    return requestDirectReview(input, {
      reviewer: async () => ({
        status: "completed",
        risk_level: "low",
        reason_codes: ["reviewer_allow"],
        confidence: 0.99,
        notes: "Scoped allow-listed verification.",
        read_only_violation: false,
      }),
      now: () => new Date(),
    });
  }

  function readReviewRecord(reviewId: string): Record<string, unknown> {
    return JSON.parse(readFileSync(
      join(getDirectSessionDir(sessionId), "reviews", reviewId, "review.json"),
      "utf-8",
    )) as Record<string, unknown>;
  }

  function writeDirectReviewConfig(mode: "enforce" | "shadow"): void {
    writeFileSync(configPath, JSON.stringify({
      workspaceRoot: root,
      agents: {
        requester: { command: "node", args: ["--version"] },
        reviewer: { command: "node", args: ["--version"] },
      },
      directAllowedCommands: ["node --version", "node verify-script.mjs"],
      directReview: {
        mode,
        requesterAgentName: "requester",
        reviewerAgentName: "reviewer",
        autoReviewRequired: true,
        ttlSeconds: 300,
      },
    }), "utf-8");
  }
});

function tryCreateFileLink(target: string, path: string): boolean {
  try {
    symlinkSync(target, path, "file");
    return true;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String((error as NodeJS.ErrnoException).code || "")
      : "";
    if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP") return false;
    throw error;
  }
}

