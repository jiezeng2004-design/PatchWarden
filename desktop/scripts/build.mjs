#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanGeneratedOutput } from "../../scripts/lib/clean-generated-output.js";

const desktopRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
cleanGeneratedOutput(desktopRoot, resolve(desktopRoot, "dist"));
process.chdir(desktopRoot);
await import("../node_modules/typescript/lib/tsc.js");
