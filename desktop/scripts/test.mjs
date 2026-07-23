import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const desktopRoot = resolve(import.meta.dirname, "..");
const distEntry = resolve(desktopRoot, "dist", "agent-adapters.js");
if (!existsSync(distEntry)) {
  console.error("[desktop] dist/ not found. Run 'npm run build:ts' before running tests.");
  process.exit(1);
}

const testDir = resolve(desktopRoot, "test");
const files = readdirSync(testDir)
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => resolve(testDir, name));

if (files.length === 0) {
  console.error("No desktop test files were found.");
  process.exit(1);
}

for (const file of files) {
  await import(pathToFileURL(file).href);
}
