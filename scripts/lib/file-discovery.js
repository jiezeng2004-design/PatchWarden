import { readdirSync } from "node:fs";
import { resolve } from "node:path";

export function collectMatchingFiles(directory, predicate) {
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return collectMatchingFiles(path, predicate);
      return entry.isFile() && predicate(entry.name, path) ? [path] : [];
    });
}
