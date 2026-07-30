#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHATGPT_CORE_TOOL_NAMES,
  CHATGPT_DIRECT_TOOL_NAMES,
} from "../../dist/tools/catalog/toolCatalog.js";
import { PATCHWARDEN_VERSION } from "../../dist/version.js";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const readText = (path) => readFileSync(join(root, path), "utf-8");
const readJson = (path) => JSON.parse(readText(path));

const packageVersion = readJson("package.json").version;
const declaredVersions = new Map([
  ["built Core", PATCHWARDEN_VERSION],
  ["root package lock", readJson("package-lock.json").packages[""].version],
  ["Desktop package", readJson("desktop/package.json").version],
  ["Desktop package lock", readJson("desktop/package-lock.json").packages[""].version],
]);

for (const [label, version] of declaredVersions) {
  assert.equal(version, packageVersion, `${label} version must match package.json`);
}

const changelogVersion = readText("CHANGELOG.md").match(/^## v([^\s]+)\s/m)?.[1];
assert.equal(changelogVersion, packageVersion, "the first CHANGELOG release must match package.json");

for (const [path, pattern] of [
  ["docs/CODE_WIKI.md", `源码版本：**v${packageVersion}**`],
  ["docs/evidence-pack-schema.md", `"patchwarden_version": "${packageVersion}"`],
  ["docs/evidence-pack-schema.md", `"package_version": "${packageVersion}"`],
  ["docs/release-evidence.md", `Local \`package.json\` | \`patchwarden@${packageVersion}\``],
  ["docs/open-source-application.md", `Local source version in \`package.json\`: \`${packageVersion}\``],
]) {
  assert.ok(readText(path).includes(pattern), `${path} must contain ${pattern}`);
}

const tunnelExample = readText("examples/openai-tunnel/README.md").replace(/\r\n?/g, "\n");
const coreCount = CHATGPT_CORE_TOOL_NAMES.length;
const directCount = CHATGPT_DIRECT_TOOL_NAMES.length;
assert.match(
  tunnelExample,
  new RegExp(`fixed\\s+${coreCount}-tool Core catalog and\\s+the ${directCount}-tool Direct catalog`),
  "the tunnel example must match the built Core and Direct catalog counts",
);
assert.ok(
  tunnelExample.includes(`v${packageVersion} Core manifest contains ${coreCount} tools`),
  "the tunnel example must identify the current Core manifest version and count",
);
assert.ok(
  tunnelExample.includes(`enabled Direct manifest contains\n${directCount} tools`),
  "the tunnel example must identify the current enabled Direct manifest count",
);

console.log(
  `[release-metadata-check] OK: v${packageVersion}, Core ${coreCount} tools, Direct ${directCount} tools.`,
);
