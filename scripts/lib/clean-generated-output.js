import { rmSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

export function cleanGeneratedOutput(projectRoot, outputPath) {
  const root = resolve(projectRoot);
  const output = resolve(outputPath);
  if (dirname(output) !== root || basename(output).toLowerCase() !== "dist") {
    throw new Error(`Refusing to clean non-dist output: ${output}`);
  }
  rmSync(output, { recursive: true, force: true });
}
