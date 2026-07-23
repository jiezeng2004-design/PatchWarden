#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanGeneratedOutput } from "./lib/clean-generated-output.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = resolve(root, "dist");

cleanGeneratedOutput(root, dist);
process.chdir(root);
await import("../node_modules/typescript/lib/tsc.js");
