import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SUPPORTED_AGENTS = ["codex", "opencode"];

export function selectAgentExecutable(name, output, platform = process.platform, fileExists = existsSync) {
  if (!SUPPORTED_AGENTS.includes(name)) return null;
  const candidates = String(output || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (platform === "win32" && name === "opencode") {
    for (const candidate of candidates) {
      if (/\\WindowsApps\\/i.test(candidate)) continue;
      if (basename(candidate).toLowerCase() === "opencode.exe" && fileExists(candidate)) return candidate;
      const nativeExecutable = join(dirname(candidate), "node_modules", "opencode-ai", "bin", "opencode.exe");
      if (fileExists(nativeExecutable)) return nativeExecutable;
    }
    return null;
  }
  for (const candidate of candidates) {
    if (platform === "win32" && /\\WindowsApps\\/i.test(candidate)) continue;
    if (platform === "win32" && ![".exe", ".com"].includes(extname(candidate).toLowerCase())) continue;
    return candidate;
  }
  return null;
}

export async function detectAgents(platform = process.platform) {
  const command = platform === "win32" ? "where.exe" : "which";
  const results = [];
  for (const name of SUPPORTED_AGENTS) {
    try {
      const { stdout } = await execFileAsync(command, [name], { timeout: 5000, windowsHide: true });
      const executablePath = selectAgentExecutable(name, stdout, platform);
      results.push({
        name,
        available: Boolean(executablePath),
        executablePath,
        reason: executablePath ? null : "Only a WindowsApps desktop alias was found",
      });
    } catch {
      results.push({ name, available: false, executablePath: null, reason: "Command not found" });
    }
  }
  return results;
}
