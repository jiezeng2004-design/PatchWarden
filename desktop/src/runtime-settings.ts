import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, parse } from "node:path";

/** Result of validating a user-selected tunnel-client.exe path. */
export type TunnelValidationResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly error: string };

/** Result of detecting an available tunnel client. */
export interface TunnelDetectionResult {
  readonly available: boolean;
  readonly path: string | null;
  readonly source: string | null;
}

/** Input for tunnel client detection. */
export interface TunnelDetectInput {
  readonly config?: { tunnelClientPath?: string | null; workspaceRoot?: string | null } | null;
  readonly env?: NodeJS.ProcessEnv;
}

/** Queue entry used by the bounded sibling search. */
interface SearchEntry {
  readonly path: string;
  readonly depth: number;
}

export function validateTunnelClientPath(value: unknown): TunnelValidationResult {
  if (typeof value !== "string" || !isAbsolute(value)) return { ok: false, error: "请选择 tunnel-client.exe 的绝对路径" };
  if (basename(value).toLowerCase() !== "tunnel-client.exe") return { ok: false, error: "所选文件必须名为 tunnel-client.exe" };
  try {
    if (!existsSync(value) || !statSync(value).isFile()) return { ok: false, error: "所选 tunnel-client.exe 不存在" };
  } catch {
    return { ok: false, error: "无法读取所选 tunnel-client.exe" };
  }
  return { ok: true, path: value };
}

function pathCandidates(env: NodeJS.ProcessEnv): string[] {
  const result: string[] = [];
  for (const entry of String(env.PATH || "").split(delimiter)) {
    if (entry) result.push(join(entry, "tunnel-client.exe"));
  }
  if (env.LOCALAPPDATA) result.push(join(env.LOCALAPPDATA, "PatchWarden", "tunnel-client.exe"));
  if (env.APPDATA) result.push(join(env.APPDATA, "tunnel-client", "tunnel-client.exe"));
  if (env.USERPROFILE) result.push(join(env.USERPROFILE, "tunnel-client", "tunnel-client.exe"));
  return result;
}

function boundedSiblingSearch(workspaceRoot: string | null | undefined): string[] {
  if (!workspaceRoot || !isAbsolute(workspaceRoot)) return [];
  const parent = dirname(workspaceRoot);
  if (parent === parse(parent).root) return [];
  const matches: string[] = [];
  let visited = 0;
  const queue: SearchEntry[] = [{ path: parent, depth: 0 }];
  while (queue.length && visited < 2000) {
    const current = queue.shift()!;
    let entries: import("node:fs").Dirent[] = [];
    try { entries = readdirSync(current.path, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      visited += 1;
      if (visited >= 2000) break;
      const full = join(current.path, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === "tunnel-client.exe") matches.push(full);
      if (entry.isDirectory() && current.depth < 2 && !entry.name.startsWith(".") && !["node_modules", "$recycle.bin", "system volume information"].includes(entry.name.toLowerCase())) {
        queue.push({ path: full, depth: current.depth + 1 });
      }
    }
  }
  return matches;
}

export function detectTunnelClient({ config, env = process.env }: TunnelDetectInput): TunnelDetectionResult {
  const candidates: Array<{ path: string | null | undefined; source: string }> = [
    { path: config && config.tunnelClientPath, source: "配置" },
    { path: env.PATCHWARDEN_TUNNEL_CLIENT_EXE || env.TUNNEL_CLIENT_EXE, source: "环境变量" },
    ...pathCandidates(env).map((path) => ({ path, source: "用户目录或 PATH" })),
    ...boundedSiblingSearch(config && config.workspaceRoot).map((path) => ({ path, source: "工作区附近" })),
  ];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate.path || seen.has(String(candidate.path).toLowerCase())) continue;
    seen.add(String(candidate.path).toLowerCase());
    const validation = validateTunnelClientPath(candidate.path);
    if (validation.ok) return { available: true, path: validation.path, source: candidate.source };
  }
  return { available: false, path: null, source: null };
}
