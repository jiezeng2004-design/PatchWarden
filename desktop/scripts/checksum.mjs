import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = process.env.PATCHWARDEN_DESKTOP_OUTPUT
  ? resolve(desktopRoot, process.env.PATCHWARDEN_DESKTOP_OUTPUT)
  : resolve(desktopRoot, "..", "release", "desktop");
const version = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf8")).version;
const installer = `PatchWarden-Setup-${version}-x64.exe`;
const zipSource = `PatchWarden-Setup-${version}-x64.zip`;
const portable = `PatchWarden-Portable-${version}-x64.zip`;
if (existsSync(join(output, zipSource))) renameSync(join(output, zipSource), join(output, portable));
const artifacts = [installer, portable];
for (const name of artifacts) if (!existsSync(join(output, name))) throw new Error(`Desktop artifact is missing: ${name}`);
const lines = artifacts.map((name) => {
  const sha256 = createHash("sha256").update(readFileSync(join(output, name))).digest("hex");
  console.log(`[desktop:checksum] ${name} ${sha256}`);
  return `${sha256}  ${name}`;
});
writeFileSync(join(output, "PatchWarden-Desktop-SHA256SUMS.txt"), `${lines.join("\n")}\n`, "utf8");
