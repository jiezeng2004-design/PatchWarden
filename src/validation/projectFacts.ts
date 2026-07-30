import { existsSync, lstatSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { redactSensitiveContent } from "../security/contentRedaction.js";
import type { ChangedFile } from "../runner/changeCapture.js";

const FACT_FILE_CANDIDATES = [".patchwarden/project-facts.json", "PROJECT_FACTS.json"];
const MAX_FACT_FILE_BYTES = 256 * 1024;
const MAX_SCAN_FILES = 200;
const MAX_SCAN_FILE_BYTES = 512 * 1024;
const MAX_SCAN_TOTAL_BYTES = 4 * 1024 * 1024;

export interface ProjectFactFinding {
  severity: "warn" | "fail";
  rule_id: string;
  path: string | null;
  line: number | null;
  matched_text: string | null;
  source: string | null;
}

export interface ProjectFactValidation {
  status: "not_configured" | "passed" | "warn" | "failed" | "invalid";
  fact_file: string | null;
  facts_source: string | null;
  findings: ProjectFactFinding[];
  files_checked: number;
  files_skipped: number;
  warnings: number;
  errors: number;
}

export function validateProjectFacts(repoPath: string, changedFiles: ChangedFile[]): ProjectFactValidation {
  const factPath = FACT_FILE_CANDIDATES.map((candidate) => resolve(repoPath, candidate)).find((path) => existsSync(path));
  if (!factPath) return empty("not_configured");
  let facts: Record<string, unknown>;
  try {
    const metadata = lstatSync(factPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_FACT_FILE_BYTES) throw new Error("fact_file_unreadable");
    const raw = readFileSync(factPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("fact_file_invalid_json");
    facts = parsed as Record<string, unknown>;
  } catch {
    return {
      ...empty("invalid"),
      fact_file: toRepoPath(repoPath, factPath),
      findings: [{ severity: "fail", rule_id: "project_facts_invalid", path: toRepoPath(repoPath, factPath), line: null, matched_text: null, source: null }],
      errors: 1,
    };
  }

  const allowedContacts = collectAllowedContacts(facts);
  const forbiddenClaims = stringList(facts.forbidden_claims, projectRecords(facts).flatMap((project) => stringList(project.forbidden_claims)));
  const confirmedClaims = stringList(facts.confirmed_claims, projectRecords(facts).flatMap((project) => stringList(project.confirmed_claims)));
  const expectedLicense = firstString(facts.license, ...projectRecords(facts).map((project) => project.license));
  const factsSource = firstString(facts.source, ...projectRecords(facts).map((project) => project.source));
  const findings: ProjectFactFinding[] = [];
  let filesChecked = 0;
  let filesSkipped = 0;
  let totalBytes = 0;

  for (const changed of changedFiles.slice(0, MAX_SCAN_FILES)) {
    if (changed.change === "deleted" || !changed.path || isNonContentPath(changed.path)) continue;
    const path = resolve(repoPath, changed.path);
    if (!isInside(repoPath, path)) { filesSkipped++; continue; }
    try {
      const metadata = lstatSync(path);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_SCAN_FILE_BYTES || totalBytes + metadata.size > MAX_SCAN_TOTAL_BYTES) {
        filesSkipped++;
        continue;
      }
      const content = readFileSync(path, "utf-8");
      if (content.includes("\0")) { filesSkipped++; continue; }
      totalBytes += Buffer.byteLength(content, "utf-8");
      filesChecked++;
      scanContent(content, changed.path.replace(/\\/g, "/"), allowedContacts, forbiddenClaims, confirmedClaims, expectedLicense, factsSource, findings);
    } catch {
      filesSkipped++;
    }
  }

  const errors = findings.filter((finding) => finding.severity === "fail").length;
  const warnings = findings.filter((finding) => finding.severity === "warn").length;
  return {
    status: errors ? "failed" : warnings ? "warn" : "passed",
    fact_file: toRepoPath(repoPath, factPath),
    facts_source: factsSource,
    findings: findings.slice(0, 100),
    files_checked: filesChecked,
    files_skipped: filesSkipped,
    warnings,
    errors,
  };
}

function scanContent(
  content: string,
  path: string,
  allowedContacts: Set<string>,
  forbiddenClaims: string[],
  confirmedClaims: string[],
  expectedLicense: string | null,
  factsSource: string | null,
  findings: ProjectFactFinding[],
): void {
  const lower = content.toLowerCase();
  for (const claim of forbiddenClaims) {
    if (claim && lower.includes(claim.toLowerCase())) add(findings, "fail", "forbidden_claim", path, content, lower.indexOf(claim.toLowerCase()), factsSource);
  }
  for (const match of content.matchAll(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi)) {
    const contact = match[0].toLowerCase();
    if (!allowedContacts.has(contact)) add(findings, "warn", "unconfirmed_contact", path, content, match.index || 0, factsSource);
  }
  for (const match of content.matchAll(/https?:\/\/[^\s)"'<>]+/gi)) {
    let host = "";
    try { host = new URL(match[0]).hostname.toLowerCase(); } catch { continue; }
    if (host && !allowedContacts.has(host) && !allowedContacts.has(match[0].toLowerCase())) add(findings, "warn", "unconfirmed_domain", path, content, match.index || 0, factsSource);
  }
  for (const match of content.matchAll(/\b\d[\d,]*(?:\+)?\s+(?:users?|downloads?|customers?|companies|organizations)\b|\benterprise adoption\b/gi)) {
    if (!confirmedClaims.some((claim) => match[0].toLowerCase().includes(claim.toLowerCase()) || claim.toLowerCase().includes(match[0].toLowerCase()))) {
      add(findings, "fail", "unconfirmed_quantitative_or_adoption_claim", path, content, match.index || 0, factsSource);
    }
  }
  if (expectedLicense) {
    for (const match of content.matchAll(/\b(MIT|Apache-?2\.0|GPL-?3\.0|BSD-?3-?Clause|MPL-?2\.0)\b/gi)) {
      if (match[0].toLowerCase().replace(/-/g, "") !== expectedLicense.toLowerCase().replace(/-/g, "")) {
        add(findings, "fail", "license_claim_mismatch", path, content, match.index || 0, factsSource);
      }
    }
  }
}

function add(findings: ProjectFactFinding[], severity: "warn" | "fail", ruleId: string, path: string, content: string, index: number, source: string | null): void {
  if (findings.some((finding) => finding.rule_id === ruleId && finding.path === path && finding.line === lineAt(content, index))) return;
  findings.push({ severity, rule_id: ruleId, path, line: lineAt(content, index), matched_text: redactSensitiveContent(lineText(content, index)).content.slice(0, 160), source });
}

function collectAllowedContacts(facts: Record<string, unknown>): Set<string> {
  const contacts = new Set<string>();
  for (const record of [facts, asRecord(facts.brand), ...projectRecords(facts)]) {
    for (const field of ["email", "github", "repository", "repo", "domain", "website", "url", "contact"]) {
      const value = record[field];
      if (typeof value !== "string") continue;
      contacts.add(value.toLowerCase());
      if (value.includes("@")) contacts.add(value.toLowerCase());
      try { contacts.add(new URL(value).hostname.toLowerCase()); } catch { /* non-URL facts are still retained verbatim */ }
    }
  }
  return contacts;
}

function projectRecords(facts: Record<string, unknown>): Record<string, unknown>[] {
  const projects = asRecord(facts.projects);
  return [asRecord(facts.project), ...Object.values(projects).map(asRecord)].filter((value) => Object.keys(value).length > 0);
}

function stringList(...values: unknown[]): string[] {
  return values.flatMap((value) => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim()) : []);
}

function firstString(...values: unknown[]): string | null {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim() || null;
}

function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function empty(status: ProjectFactValidation["status"]): ProjectFactValidation { return { status, fact_file: null, facts_source: null, findings: [], files_checked: 0, files_skipped: 0, warnings: 0, errors: 0 }; }
function isInside(root: string, path: string): boolean { const rel = relative(resolve(root), resolve(path)); return rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !rel.includes(".." + (process.platform === "win32" ? "\\" : "/")); }
function toRepoPath(root: string, path: string): string { return relative(root, path).replace(/\\/g, "/"); }
function isNonContentPath(path: string): boolean { return /(^|\/)(?:node_modules|\.git|\.next|dist|build|coverage|\.patchwarden)(\/|$)|\.(?:png|jpg|jpeg|gif|webp|zip|tgz|pdf|exe|dll)$/i.test(path); }
function lineAt(content: string, index: number): number { return content.slice(0, index).split("\n").length; }
function lineText(content: string, index: number): string { const start = content.lastIndexOf("\n", index) + 1; const end = content.indexOf("\n", index); return content.slice(start, end === -1 ? content.length : end); }
