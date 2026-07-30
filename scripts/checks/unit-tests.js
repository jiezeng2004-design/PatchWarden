#!/usr/bin/env node
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { collectMatchingFiles } from "../lib/file-discovery.js";

const scriptDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const root = resolve(scriptDir, "..", "..");
const unitDir = resolve(root, "dist", "test", "unit");

if (!existsSync(unitDir)) {
  console.error(`[unit-tests] Missing compiled test directory: ${unitDir}`);
  console.error("[unit-tests] Run npm run build before npm run test:unit.");
  process.exit(1);
}

const testFiles = collectMatchingFiles(unitDir, (name) => name.endsWith(".test.js"));

if (testFiles.length === 0) {
  console.error(`[unit-tests] No compiled unit tests found in ${unitDir}`);
  process.exit(1);
}

const attestationDir = mkdtempSync(join(tmpdir(), "patchwarden-unit-attestations-"));
let result;
try {
  result = spawnSync(process.execPath, ["--test", ...testFiles], {
    stdio: "inherit",
    env: { ...process.env, PATCHWARDEN_ATTESTATION_DIR: attestationDir },
  });
} finally {
  rmSync(attestationDir, { recursive: true, force: true });
}

if (result.error) {
  console.error(`[unit-tests] Failed to run unit tests: ${result.error.message}`);
  process.exit(1);
}

process.exit(typeof result.status === "number" ? result.status : 1);
