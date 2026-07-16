import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import { getAgentAdapter, validateModelId } from "./agent-adapters.mjs";

const MAX_CONFIG_BYTES = 1024 * 1024;

function safeRead(path, workspaceRoot, projectScoped = false) {
  try {
    const resolved = resolve(path);
    const stat = lstatSync(resolved);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CONFIG_BYTES) return null;
    if (projectScoped) {
      const rel = relative(realpathSync(resolve(workspaceRoot)), realpathSync(resolved));
      if (rel.startsWith("..") || isAbsolute(rel)) return null;
    }
    return readFileSync(resolved, "utf8").replace(/^\uFEFF/, "");
  } catch {
    return null;
  }
}

function addModel(output, value, source) {
  try {
    const id = validateModelId(value);
    if (id) output.set(id, { id, label: id, source });
  } catch { /* ignore malformed or secret-like values */ }
}

function parseStructured(kind, text) {
  if (kind === "jsonc") return parseJsonc(text, undefined, { allowTrailingComma: true, disallowComments: false });
  if (kind === "toml") return parseToml(text);
  if (kind === "yaml") return parseYaml(text);
  return null;
}

function sourcesFor(id, workspaceRoot, env, home) {
  const xdg = env.XDG_CONFIG_HOME || join(home, ".config");
  const copilotHome = env.COPILOT_HOME || join(home, ".copilot");
  const sources = {
    codex: [{ path: join(home, ".codex", "config.toml"), kind: "toml", label: "Codex user config" }],
    opencode: [
      { path: join(xdg, "opencode", "opencode.json"), kind: "jsonc", label: "OpenCode user config" },
      { path: join(xdg, "opencode", "opencode.jsonc"), kind: "jsonc", label: "OpenCode user config" },
      { path: join(workspaceRoot, "opencode.json"), kind: "jsonc", label: "OpenCode workspace config", project: true },
      { path: join(workspaceRoot, "opencode.jsonc"), kind: "jsonc", label: "OpenCode workspace config", project: true },
    ],
    claude: [
      { path: join(home, ".claude", "settings.json"), kind: "jsonc", label: "Claude user settings" },
      { path: join(workspaceRoot, ".claude", "settings.json"), kind: "jsonc", label: "Claude workspace settings", project: true },
      { path: join(workspaceRoot, ".claude", "settings.local.json"), kind: "jsonc", label: "Claude local settings", project: true },
    ],
    gemini: [
      { path: join(home, ".gemini", "settings.json"), kind: "jsonc", label: "Gemini user settings" },
      { path: join(workspaceRoot, ".gemini", "settings.json"), kind: "jsonc", label: "Gemini workspace settings", project: true },
    ],
    copilot: [{ path: join(copilotHome, "settings.json"), kind: "jsonc", label: "Copilot user settings" }],
    qwen: [
      { path: join(home, ".qwen", "settings.json"), kind: "jsonc", label: "Qwen user settings" },
      { path: join(workspaceRoot, ".qwen", "settings.json"), kind: "jsonc", label: "Qwen workspace settings", project: true },
    ],
    kimi: [{ path: join(home, ".kimi", "config.toml"), kind: "toml", label: "Kimi user config" }],
    aider: [
      { path: join(home, ".aider.conf.yml"), kind: "yaml", label: "Aider user config" },
      { path: join(workspaceRoot, ".aider.conf.yml"), kind: "yaml", label: "Aider workspace config", project: true },
    ],
  };
  return sources[id] || [];
}

function extract(id, value, source, output) {
  if (!value || typeof value !== "object") return;
  if (id === "codex") {
    addModel(output, value.model, source);
    Object.values(value.profiles || {}).forEach((profile) => addModel(output, profile?.model, source));
  } else if (id === "opencode") {
    addModel(output, value.model, source);
    addModel(output, value.small_model, source);
    Object.entries(value.provider || {}).forEach(([providerId, provider]) => {
      Object.keys(provider?.models || {}).forEach((modelId) => addModel(output, `${providerId}/${modelId}`, source));
    });
  } else if (id === "gemini" || id === "qwen") {
    addModel(output, typeof value.model === "string" ? value.model : value.model?.name, source);
    Object.keys(value.modelConfigs?.aliases || {}).forEach((alias) => addModel(output, alias, source));
  } else if (id === "kimi") {
    addModel(output, value.default_model, source);
    Object.keys(value.models || {}).forEach((model) => addModel(output, model, source));
  } else if (id === "aider") {
    addModel(output, value.model, source);
    addModel(output, value["weak-model"], source);
    addModel(output, value["editor-model"], source);
    const aliases = Array.isArray(value.alias) ? value.alias : value.alias ? [value.alias] : [];
    aliases.forEach((alias) => addModel(output, String(alias).split(":").slice(1).join(":"), source));
  } else {
    addModel(output, value.model, source);
  }
}

export function discoverModelsForAgent(id, workspaceRoot, env = process.env, home = homedir()) {
  if (!getAgentAdapter(id)) throw new Error("不支持的 Agent");
  const models = new Map();
  const readSources = [];
  for (const source of sourcesFor(id, workspaceRoot, env, home)) {
    const text = safeRead(source.path, workspaceRoot, source.project === true);
    if (text === null) continue;
    try {
      const value = parseStructured(source.kind, text);
      extract(id, value, source.label, models);
      readSources.push(source.label);
    } catch { /* invalid local config is reported as no discovered models */ }
  }
  return { agentId: id, models: [...models.values()].sort((a, b) => a.id.localeCompare(b.id)), sources: [...new Set(readSources)] };
}
