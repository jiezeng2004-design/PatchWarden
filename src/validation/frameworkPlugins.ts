import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export type FrameworkId = "nextjs" | "nodejs" | "python" | "rust" | "electron" | "generic";

export interface FrameworkCheck {
  check: string;
  status: "pass" | "warn" | "not_applicable";
  detail: string;
  source: string;
}

export interface FrameworkPluginResult {
  framework: FrameworkId;
  detected: boolean;
  detection_sources: string[];
  generated_paths: string[];
  recommended_commands: string[];
  checks: FrameworkCheck[];
  overrides_applied: boolean;
}

export interface FrameworkValidationReport {
  mode: "framework_plugins" | "generic_fallback";
  detected_frameworks: FrameworkId[];
  plugins: FrameworkPluginResult[];
  override_file: string | null;
  warnings: string[];
}

export function validateFrameworks(repoPath: string): FrameworkValidationReport {
  const manifest = readJsonFile(join(repoPath, "package.json"));
  const dependencies = {
    ...asRecord(manifest?.dependencies),
    ...asRecord(manifest?.devDependencies),
  };
  const scripts = asRecord(manifest?.scripts);
  const sources = new Set<string>();
  const detected: Array<Exclude<FrameworkId, "generic">> = [];
  if (manifest) { detected.push("nodejs"); sources.add("package.json"); }
  if (typeof dependencies.next === "string") detected.push("nextjs");
  if (typeof dependencies.electron === "string") detected.push("electron");
  if (["pyproject.toml", "requirements.txt", "setup.py", "Pipfile"].some((file) => existsSync(join(repoPath, file)))) detected.push("python");
  if (existsSync(join(repoPath, "Cargo.toml"))) detected.push("rust");

  const overridePath = join(repoPath, ".patchwarden", "framework-validation.json");
  const overrides = readOverrideFile(overridePath);
  const uniqueDetected = [...new Set(detected)];
  if (uniqueDetected.length === 0) {
    return {
      mode: "generic_fallback",
      detected_frameworks: ["generic"],
      plugins: [genericPlugin()],
      override_file: overrides ? ".patchwarden/framework-validation.json" : null,
      warnings: overrides ? ["Framework override file exists, but no supported framework was detected; generic validation remains active."] : [],
    };
  }

  const plugins = uniqueDetected.map((framework) => applyOverride(
    pluginFor(framework, repoPath, scripts),
    asRecord(asRecord(overrides?.plugins)[framework]),
  ));
  return {
    mode: "framework_plugins",
    detected_frameworks: uniqueDetected,
    plugins,
    override_file: overrides ? ".patchwarden/framework-validation.json" : null,
    warnings: plugins.flatMap((plugin) => plugin.checks.filter((check) => check.status === "warn").map((check) => `${plugin.framework}:${check.check}`)),
  };
}

function pluginFor(framework: Exclude<FrameworkId, "generic">, repoPath: string, scripts: Record<string, unknown>): FrameworkPluginResult {
  switch (framework) {
    case "nextjs": {
      const nextBuildScripts = Object.entries(scripts).filter(([, value]) => typeof value === "string" && /(^|\s)next\s+build(?:\s|$)/.test(value)).map(([name]) => `npm run ${name}`);
      const routes = discoverNextRoutes(repoPath);
      return {
        framework, detected: true, detection_sources: ["package.json:dependencies.next"], generated_paths: [".next/**"], recommended_commands: nextBuildScripts,
        overrides_applied: false,
        checks: [
          check("next_build_script", nextBuildScripts.length > 0, nextBuildScripts.join(", ") || "No package.json script invokes exact next build.", "package.json:scripts"),
          { check: "route_manifest", status: routes.length > 0 ? "pass" : "warn", detail: routes.length ? `${routes.length} route(s): ${routes.slice(0, 20).join(", ")}` : "No app/ or pages/ route files detected.", source: "app/**|pages/**" },
          presenceCheck(repoPath, "public", "static_assets"),
          anyPresenceCheck(repoPath, ["app/layout.tsx", "app/layout.jsx", "pages/_document.tsx", "pages/_document.js"], "metadata_entry"),
          anyPresenceCheck(repoPath, ["app/sitemap.ts", "app/sitemap.js", "public/sitemap.xml"], "sitemap"),
          anyPresenceCheck(repoPath, ["app/robots.ts", "app/robots.js", "public/robots.txt"], "robots"),
          { check: "runtime_console", status: "not_applicable", detail: "Validated by runtimeValidation when enabled for the task.", source: "runtimeValidation" },
        ],
      };
    }
    case "nodejs":
      return { framework, detected: true, detection_sources: ["package.json"], generated_paths: ["dist/**", "build/**", "coverage/**"], recommended_commands: scriptCommands(scripts), overrides_applied: false, checks: [check("package_scripts", Object.keys(scripts).length > 0, `${Object.keys(scripts).length} script(s) detected.`, "package.json:scripts")] };
    case "python":
      return { framework, detected: true, detection_sources: ["pyproject.toml|requirements.txt|setup.py|Pipfile"], generated_paths: ["__pycache__/**", ".pytest_cache/**", "dist/**", "build/**"], recommended_commands: ["pytest"], overrides_applied: false, checks: [anyPresenceCheck(repoPath, ["pyproject.toml", "requirements.txt", "setup.py", "Pipfile"], "python_manifest")] };
    case "rust":
      return { framework, detected: true, detection_sources: ["Cargo.toml"], generated_paths: ["target/**"], recommended_commands: ["cargo test", "cargo build"], overrides_applied: false, checks: [presenceCheck(repoPath, "Cargo.toml", "cargo_manifest")] };
    case "electron":
      return { framework, detected: true, detection_sources: ["package.json:dependencies.electron"], generated_paths: ["dist/**", "out/**", "release/**"], recommended_commands: scriptCommands(scripts).filter((command) => /build|pack|test/.test(command)), overrides_applied: false, checks: [check("electron_entry", typeof (readJsonFile(join(repoPath, "package.json")) || {}).main === "string", "package.json main entry", "package.json:main")] };
  }
}

function applyOverride(plugin: FrameworkPluginResult, override: Record<string, unknown>): FrameworkPluginResult {
  if (Object.keys(override).length === 0) return plugin;
  const generated = safeStringList(override.generated_paths, 64, "generated_paths");
  const commands = safeStringList(override.recommended_commands, 20, "recommended_commands");
  return {
    ...plugin,
    generated_paths: generated ?? plugin.generated_paths,
    recommended_commands: commands ?? plugin.recommended_commands,
    overrides_applied: true,
  };
}

function readOverrideFile(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 128 * 1024) throw new Error("framework-validation.json must be a regular JSON file no larger than 128 KiB");
  const parsed = JSON.parse(readFileSync(path, "utf-8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("framework-validation.json root must be an object");
  return parsed as Record<string, unknown>;
}

function discoverNextRoutes(repoPath: string): string[] {
  const routes: string[] = [];
  for (const rootName of ["app", "pages"]) {
    const root = join(repoPath, rootName);
    if (!existsSync(root)) continue;
    walk(root, 5, 500, (file) => {
      const rel = relative(root, file).replace(/\\/g, "/");
      if (rootName === "app" && /(^|\/)page\.(?:js|jsx|ts|tsx)$/.test(rel)) routes.push("/" + rel.replace(/(^|\/)page\.(?:js|jsx|ts|tsx)$/, "").replace(/\([^/]+\)\//g, ""));
      if (rootName === "pages" && /\.(?:js|jsx|ts|tsx)$/.test(rel) && !/(^|\/)_/.test(rel) && !/(^|\/)api\//.test(rel)) routes.push("/" + rel.replace(/\.(?:js|jsx|ts|tsx)$/, "").replace(/\/index$/, ""));
    });
  }
  return [...new Set(routes.map((route) => route.replace(/\/+$/, "") || "/"))].sort();
}

function walk(root: string, maxDepth: number, maxFiles: number, visit: (file: string) => void): void {
  const queue = [{ path: root, depth: 0 }]; let seen = 0;
  while (queue.length && seen < maxFiles) {
    const current = queue.shift()!;
    for (const entry of readdirSync(current.path, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const path = join(current.path, entry.name);
      if (entry.isDirectory() && current.depth < maxDepth) queue.push({ path, depth: current.depth + 1 });
      else if (entry.isFile()) { seen++; visit(path); }
      if (seen >= maxFiles) break;
    }
  }
}

function genericPlugin(): FrameworkPluginResult { return { framework: "generic", detected: true, detection_sources: ["fallback"], generated_paths: [], recommended_commands: [], checks: [{ check: "generic_mode", status: "pass", detail: "No supported framework detected; generic repository validation remains active.", source: "fallback" }], overrides_applied: false }; }
function scriptCommands(scripts: Record<string, unknown>): string[] { return Object.keys(scripts).slice(0, 50).map((name) => `npm run ${name}`); }
function check(name: string, passed: boolean, detail: string, source: string): FrameworkCheck { return { check: name, status: passed ? "pass" : "warn", detail, source }; }
function presenceCheck(repoPath: string, path: string, name: string): FrameworkCheck { return check(name, existsSync(join(repoPath, path)), existsSync(join(repoPath, path)) ? `${path} exists.` : `${path} not found.`, path); }
function anyPresenceCheck(repoPath: string, paths: string[], name: string): FrameworkCheck { const found = paths.find((path) => existsSync(join(repoPath, path))); return check(name, Boolean(found), found ? `${found} exists.` : `None found: ${paths.join(", ")}.`, paths.join("|")); }
function readJsonFile(path: string): Record<string, unknown> | null { try { if (!existsSync(path)) return null; const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512 * 1024) return null; const value = JSON.parse(readFileSync(path, "utf-8")); return value && typeof value === "object" && !Array.isArray(value) ? value : null; } catch { return null; } }
function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function safeStringList(value: unknown, max: number, field: string): string[] | null { if (value === undefined) return null; if (!Array.isArray(value) || value.length > max || value.some((entry) => typeof entry !== "string" || !entry.trim() || entry.length > 256 || entry.includes("\0") || entry.split(/[\\/]/).includes(".."))) throw new Error(`framework override ${field} is invalid`); return [...new Set(value.map((entry) => String(entry).trim()))]; }
