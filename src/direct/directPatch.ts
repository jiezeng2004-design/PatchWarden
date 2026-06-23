import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { PatchWardenError } from "../errors.js";

// ── Types ──────────────────────────────────────────────────────────

export type PatchOperationType =
  | "replace_exact"
  | "insert_before"
  | "insert_after"
  | "replace_whole_file";

export interface PatchOperation {
  type: PatchOperationType;
  old_text?: string;
  new_text: string;
  occurrence?: "first" | "all" | "exactly_once";
}

export interface ApplyPatchResult {
  before_sha256: string;
  after_sha256: string;
  operations_applied: number;
  bytes_changed: number;
}

// ── Hash helpers ───────────────────────────────────────────────────

export function computeFileSha256(filePath: string): string {
  const content = readFileSync(filePath);
  return createHash("sha256").update(content).digest("hex");
}

export function computeContentSha256(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

export function validateExpectedSha256(
  filePath: string,
  expectedSha256: string
): string {
  if (!existsSync(filePath)) {
    throw new PatchWardenError(
      "file_hash_mismatch",
      `File does not exist: "${filePath}".`,
      "Ensure the file path is correct and the file exists before applying a patch.",
      true,
      { expected_sha256: expectedSha256 }
    );
  }

  const currentHash = computeFileSha256(filePath);
  if (currentHash !== expectedSha256) {
    throw new PatchWardenError(
      "file_hash_mismatch",
      `File hash mismatch. Expected "${expectedSha256}" but got "${currentHash}".`,
      "Re-read the file to get the current sha256, then retry the patch with the updated expected_sha256.",
      true,
      { expected_sha256: expectedSha256, actual_sha256: currentHash }
    );
  }

  return currentHash;
}

// ── Patch application ──────────────────────────────────────────────

export function applyPatchOperations(
  filePath: string,
  operations: PatchOperation[]
): ApplyPatchResult {
  if (!existsSync(filePath)) {
    throw new PatchWardenError(
      "patch_anchor_not_found",
      `File does not exist: "${filePath}".`,
      "Ensure the file exists before applying a patch. Direct mode does not support creating new files.",
      true,
      { path: filePath }
    );
  }

  const beforeContent = readFileSync(filePath, "utf-8");
  const beforeSha256 = computeContentSha256(beforeContent);
  let content = beforeContent;
  let operationsApplied = 0;

  for (const op of operations) {
    content = applySingleOperation(content, op);
    operationsApplied++;
  }

  const afterSha256 = computeContentSha256(content);
  const bytesChanged = Math.abs(
    Buffer.byteLength(content, "utf-8") - Buffer.byteLength(beforeContent, "utf-8")
  );

  // Ensure parent directory exists (should already exist for existing files)
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf-8");

  return {
    before_sha256: beforeSha256,
    after_sha256: afterSha256,
    operations_applied: operationsApplied,
    bytes_changed: bytesChanged,
  };
}

function applySingleOperation(
  content: string,
  op: PatchOperation
): string {
  switch (op.type) {
    case "replace_exact":
      return applyReplaceExact(content, op);
    case "insert_before":
      return applyInsertBefore(content, op);
    case "insert_after":
      return applyInsertAfter(content, op);
    case "replace_whole_file":
      return op.new_text;
    default:
      throw new PatchWardenError(
        "patch_anchor_not_found",
        `Unknown operation type: "${op.type}".`,
        "Use one of: replace_exact, insert_before, insert_after, replace_whole_file.",
        true,
        { operation_type: op.type }
      );
  }
}

function applyReplaceExact(
  content: string,
  op: PatchOperation
): string {
  if (op.old_text === undefined || op.old_text === "") {
    throw new PatchWardenError(
      "patch_anchor_not_found",
      "replace_exact requires a non-empty old_text.",
      "Provide the exact text to replace.",
      true,
      { operation: "replace_exact" }
    );
  }

  const occurrence = op.occurrence || "first";
  const oldText = op.old_text;
  const newText = op.new_text;

  if (occurrence === "all") {
    if (!content.includes(oldText)) {
      throw new PatchWardenError(
        "patch_anchor_not_found",
        `old_text not found in file content.`,
        "Ensure old_text exactly matches content in the file.",
        true,
        { operation: "replace_exact", occurrence: "all" }
      );
    }
    return content.split(oldText).join(newText);
  }

  if (occurrence === "exactly_once") {
    const firstIndex = content.indexOf(oldText);
    if (firstIndex === -1) {
      throw new PatchWardenError(
        "patch_anchor_not_found",
        `old_text not found in file content.`,
        "Ensure old_text exactly matches content in the file.",
        true,
        { operation: "replace_exact", occurrence: "exactly_once" }
      );
    }
    const secondIndex = content.indexOf(oldText, firstIndex + 1);
    if (secondIndex !== -1) {
      throw new PatchWardenError(
        "patch_ambiguous",
        `old_text appears multiple times in file content, but occurrence is "exactly_once".`,
        "Use occurrence: \"first\" to replace the first match, or occurrence: \"all\" to replace all matches.",
        true,
        { operation: "replace_exact", occurrence: "exactly_once" }
      );
    }
    return content.slice(0, firstIndex) + newText + content.slice(firstIndex + oldText.length);
  }

  // occurrence === "first" (default)
  if (!content.includes(oldText)) {
    throw new PatchWardenError(
      "patch_anchor_not_found",
      `old_text not found in file content.`,
      "Ensure old_text exactly matches content in the file.",
      true,
      { operation: "replace_exact", occurrence: "first" }
    );
  }
  const index = content.indexOf(oldText);
  return content.slice(0, index) + newText + content.slice(index + oldText.length);
}

function applyInsertBefore(
  content: string,
  op: PatchOperation
): string {
  if (op.old_text === undefined || op.old_text === "") {
    throw new PatchWardenError(
      "patch_anchor_not_found",
      "insert_before requires a non-empty old_text as anchor.",
      "Provide the anchor text before which new_text should be inserted.",
      true,
      { operation: "insert_before" }
    );
  }

  const index = content.indexOf(op.old_text);
  if (index === -1) {
    throw new PatchWardenError(
      "patch_anchor_not_found",
      `Anchor text not found in file content for insert_before.`,
      "Ensure old_text exactly matches content in the file.",
      true,
      { operation: "insert_before" }
    );
  }

  return content.slice(0, index) + op.new_text + content.slice(index);
}

function applyInsertAfter(
  content: string,
  op: PatchOperation
): string {
  if (op.old_text === undefined || op.old_text === "") {
    throw new PatchWardenError(
      "patch_anchor_not_found",
      "insert_after requires a non-empty old_text as anchor.",
      "Provide the anchor text after which new_text should be inserted.",
      true,
      { operation: "insert_after" }
    );
  }

  const index = content.indexOf(op.old_text);
  if (index === -1) {
    throw new PatchWardenError(
      "patch_anchor_not_found",
      `Anchor text not found in file content for insert_after.`,
      "Ensure old_text exactly matches content in the file.",
      true,
      { operation: "insert_after" }
    );
  }

  const insertPos = index + op.old_text.length;
  return content.slice(0, insertPos) + op.new_text + content.slice(insertPos);
}
