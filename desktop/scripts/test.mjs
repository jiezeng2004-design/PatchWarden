import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const testDir = resolve(import.meta.dirname, "..", "test");
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
