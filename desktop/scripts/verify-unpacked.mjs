#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const argv = process.argv.slice(2);
const option = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
};
const desktopRoot = resolve(import.meta.dirname, "..");
const unpackedRoot = resolve(option("--path") || join(desktopRoot, "..", "release", "desktop", "win-unpacked"));
const receiptPath = resolve(option("--receipt") || join(dirname(unpackedRoot), "unpacked-verification.json"));
const maxBytes = 325 * 1024 * 1024;

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function walk(directory, canonicalRoot) {
  let files = 0;
  let bytes = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`Unpacked artifact contains a link: ${relative(unpackedRoot, path)}`);
    const canonical = realpathSync.native(path);
    const rel = relative(canonicalRoot, canonical);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`Unpacked artifact escapes its root: ${path}`);
    if (stat.isDirectory()) {
      const nested = walk(path, canonicalRoot);
      files += nested.files;
      bytes += nested.bytes;
    } else if (stat.isFile()) {
      files += 1;
      bytes += stat.size;
    } else {
      throw new Error(`Unsupported artifact entry: ${path}`);
    }
  }
  return { files, bytes };
}

if (!existsSync(unpackedRoot)) throw new Error(`Unpacked artifact not found: ${unpackedRoot}`);
const rootStat = lstatSync(unpackedRoot);
if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("Unpacked artifact root must be a real directory");
const canonicalRoot = realpathSync.native(unpackedRoot);
const executable = join(unpackedRoot, "PatchWarden.exe");
const asar = join(unpackedRoot, "resources", "app.asar");
const core = join(unpackedRoot, "resources", "core");
for (const path of [executable, asar, join(core, "dist", "index.js"), join(core, "package.json")]) {
  if (!existsSync(path)) throw new Error(`Unpacked artifact is missing ${relative(unpackedRoot, path)}`);
}
const totals = walk(unpackedRoot, canonicalRoot);
if (totals.bytes > maxBytes) throw new Error(`Unpacked artifact exceeds ${maxBytes} bytes: ${totals.bytes}`);
const locales = readdirSync(join(unpackedRoot, "locales"), { withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name)
  .sort();
if (JSON.stringify(locales) !== JSON.stringify(["en-US.pak", "zh-CN.pak"])) {
  throw new Error(`Unexpected Electron locale set: ${locales.join(", ")}`);
}
const manifest = JSON.parse(readFileSync(join(core, "package.json"), "utf-8"));
const receipt = {
  schema_version: "patchwarden-desktop-unpacked-verification-v1",
  verified_at: new Date().toISOString(),
  artifact_path: unpackedRoot,
  version: manifest.version,
  file_count: totals.files,
  size_bytes: totals.bytes,
  max_size_bytes: maxBytes,
  locales,
  executable: { name: basename(executable), size_bytes: lstatSync(executable).size, sha256: sha256(executable) },
  app_asar: { size_bytes: lstatSync(asar).size, sha256: sha256(asar) },
};
writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
console.log(`[desktop:verify-unpacked] OK: ${totals.files} files, ${totals.bytes} bytes, locales=${locales.join(",")}`);
