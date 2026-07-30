import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { reloadConfig } from "../../../config.js";
import { PatchWardenError } from "../../../errors.js";
import { readDirectSession } from "../../../direct/directSessionStore.js";
import { createDirectSession } from "../../../tools/direct/createDirectSession.js";
import { finalizeDirectSession } from "../../../tools/direct/finalizeDirectSession.js";
import { createDirectFile, deleteDirectFile, mkdirDirect, moveDirectFile } from "../../../tools/workspace/directFileOperations.js";

describe("Direct native file operations", () => {
  let root: string;
  let repo: string;
  let sessionId: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "patchwarden-direct-file-ops-"));
    repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "old.ts"), "export const oldValue = 1;\n", "utf-8");
    writeFileSync(join(repo, "delete.md"), "delete me\n", "utf-8");
    execFileSync("git", ["init"], { cwd: repo, windowsHide: true });
    execFileSync("git", ["add", "."], { cwd: repo, windowsHide: true });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture"], { cwd: repo, windowsHide: true });
    const configPath = join(root, "patchwarden.config.json");
    writeFileSync(configPath, JSON.stringify({ workspaceRoot: root, enableDirectProfile: true }), "utf-8");
    process.env.PATCHWARDEN_CONFIG = configPath;
    reloadConfig();
    sessionId = (await createDirectSession({ repo_path: "repo" })).session_id;
  });

  afterEach(() => {
    delete process.env.PATCHWARDEN_CONFIG;
    reloadConfig();
    rmSync(root, { recursive: true, force: true });
  });

  it("creates directories/files, moves by hash, confirms deletion, and records diff evidence", async () => {
    mkdirDirect({ session_id: sessionId, path: "scripts" });
    const created = createDirectFile({ session_id: sessionId, path: "scripts/Start.cmd", content: "@echo off\r\necho safe\r\n" });
    assert.equal(existsSync(join(repo, "scripts", "Start.cmd")), true);
    assert.match(created.after_sha256, /^[a-f0-9]{64}$/);

    const sourceHash = sha256(readFileSync(join(repo, "old.ts"), "utf-8"));
    moveDirectFile({ session_id: sessionId, source_path: "old.ts", target_path: "new.ts", expected_source_sha256: sourceHash });
    assert.equal(existsSync(join(repo, "old.ts")), false);
    assert.equal(existsSync(join(repo, "new.ts")), true);

    const deleteHash = sha256(readFileSync(join(repo, "delete.md"), "utf-8"));
    assert.throws(
      () => deleteDirectFile({ session_id: sessionId, path: "delete.md", expected_sha256: deleteHash, confirm_delete: false }),
      (error: unknown) => error instanceof PatchWardenError && error.reason === "direct_delete_confirmation_required",
    );
    deleteDirectFile({ session_id: sessionId, path: "delete.md", expected_sha256: deleteHash, confirm_delete: true });

    const operations = readDirectSession(sessionId).operations.map((operation) => operation.operation_type);
    assert.deepEqual(operations, ["mkdir", "create", "move", "delete"]);
    const finalized = await finalizeDirectSession({ session_id: sessionId });
    assert.equal(finalized.finalized, true);
    assert.equal(finalized.source_changes.some((change) => change.path === "scripts/Start.cmd"), true);
    assert.equal(finalized.source_changes.some((change) => change.path === "new.ts" && change.change === "renamed"), true);
    assert.equal(finalized.source_changes.some((change) => change.path === "delete.md" && change.change === "deleted"), true);
  });

  it("rejects traversal, sensitive content, target conflicts, and stale hashes", () => {
    assert.throws(() => createDirectFile({ session_id: sessionId, path: "../outside.ts", content: "safe" }), PatchWardenError);
    assert.throws(() => createDirectFile({ session_id: sessionId, path: "secret.ts", content: `const token = "ghp_${"a".repeat(24)}";` }), (error: unknown) => error instanceof PatchWardenError && error.reason === "sensitive_content_blocked");
    assert.throws(() => moveDirectFile({ session_id: sessionId, source_path: "old.ts", target_path: "delete.md", expected_source_sha256: sha256(readFileSync(join(repo, "old.ts"), "utf-8")) }), (error: unknown) => error instanceof PatchWardenError && error.reason === "direct_target_exists");
    assert.throws(() => deleteDirectFile({ session_id: sessionId, path: "delete.md", expected_sha256: "0".repeat(64), confirm_delete: true }), (error: unknown) => error instanceof PatchWardenError && error.reason === "file_hash_mismatch");
  });
});

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf-8").digest("hex");
}
