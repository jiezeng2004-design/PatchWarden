import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = process.env.PATCHWARDEN_DESKTOP_OUTPUT
  ? resolve(desktopRoot, process.env.PATCHWARDEN_DESKTOP_OUTPUT)
  : resolve(desktopRoot, "..", "release", "desktop");
const installers = readdirSync(output).filter((name) => /^PatchWarden-Setup-.*-x64\.exe$/i.test(name));
if (installers.length !== 1) throw new Error(`Expected one desktop installer, found ${installers.length}`);
const name = installers[0];
const sha256 = createHash("sha256").update(readFileSync(join(output, name))).digest("hex");
writeFileSync(join(output, "PatchWarden-Desktop-SHA256SUMS.txt"), `${sha256}  ${name}\n`, "utf8");
console.log(`[desktop:checksum] ${name} ${sha256}`);
