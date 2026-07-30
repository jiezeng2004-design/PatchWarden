import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { SaxesParser, type SaxesTagNS } from "saxes";
import type { ChangedFile } from "../runner/changeCapture.js";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 200;

export interface SvgXmlFinding {
  severity: "warn" | "fail";
  rule_id: string;
  file: string;
  line: number;
  column: number;
  reason: string;
}

export interface SvgXmlValidationReport {
  status: "not_applicable" | "passed" | "warn" | "failed";
  parser: "saxes";
  files_checked: number;
  findings: SvgXmlFinding[];
  errors: number;
  warnings: number;
  browser_cross_check: "runtime_validation";
}

export function validateChangedSvgXml(repoPath: string, changedFiles: ChangedFile[]): SvgXmlValidationReport {
  const findings: SvgXmlFinding[] = [];
  let filesChecked = 0;
  for (const changed of changedFiles.filter((file) => file.change !== "deleted" && /\.(?:svg|xml)$/i.test(file.path)).slice(0, MAX_FILES)) {
    const path = resolve(repoPath, changed.path);
    if (!isInside(repoPath, path)) continue;
    try {
      const metadata = lstatSync(path);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_FILE_BYTES) {
        findings.push(finding("fail", "xml_file_unreadable", changed.path, 1, 1, "File must be a regular XML/SVG file no larger than 2 MiB."));
        continue;
      }
      const content = readFileSync(path, "utf-8");
      filesChecked++;
      validateOne(repoPath, path, changed.path.replace(/\\/g, "/"), content, findings);
    } catch (error) {
      findings.push(finding("fail", "xml_file_unreadable", changed.path, 1, 1, error instanceof Error ? error.message : String(error)));
    }
  }
  const errors = findings.filter((item) => item.severity === "fail").length;
  const warnings = findings.filter((item) => item.severity === "warn").length;
  return {
    status: filesChecked === 0 && findings.length === 0 ? "not_applicable" : errors ? "failed" : warnings ? "warn" : "passed",
    parser: "saxes",
    files_checked: filesChecked,
    findings: findings.slice(0, 100),
    errors,
    warnings,
    browser_cross_check: "runtime_validation",
  };
}

function validateOne(repoPath: string, absolutePath: string, repoRelativePath: string, content: string, findings: SvgXmlFinding[]): void {
  const parser = new SaxesParser({ xmlns: true, position: true });
  let root: SaxesTagNS | null = null;
  let parseFailure: Error | null = null;
  parser.on("error", (error) => { parseFailure = error; });
  parser.on("opentag", (tag) => {
    if (!root) root = tag;
    for (const attr of Object.values(tag.attributes)) {
      if (!["href", "src"].includes(attr.local)) continue;
      const reference = attr.value.trim();
      if (!reference || reference.startsWith("#") || reference.startsWith("data:")) continue;
      if (/^https?:\/\//i.test(reference)) {
        findings.push(finding("warn", "xml_external_resource", repoRelativePath, parser.line, parser.column, `External resource reference requires browser validation: ${reference.slice(0, 120)}`));
        continue;
      }
      const withoutQuery = reference.split(/[?#]/, 1)[0];
      const referencedPath = resolve(dirname(absolutePath), withoutQuery);
      if (!isInside(repoPath, referencedPath) || !existsSync(referencedPath)) {
        findings.push(finding("fail", "xml_referenced_resource_missing", repoRelativePath, parser.line, parser.column, `Referenced resource not found: ${reference.slice(0, 120)}`));
      }
    }
  });
  try {
    parser.write(content).close();
  } catch (error) {
    parseFailure = error instanceof Error ? error : new Error(String(error));
  }
  if (parseFailure) {
    const position = parseFailure.message.match(/(?:^|\s)(\d+):(\d+):/);
    const line = position ? Number(position[1]) : Math.max(1, parser.line);
    const column = position ? Number(position[2]) : Math.max(1, parser.column);
    findings.push(finding("fail", "xml_parse_error", repoRelativePath, line, column, parseFailure.message));
    return;
  }
  const parsedRoot = root as SaxesTagNS | null;
  if (!parsedRoot) {
    findings.push(finding("fail", "xml_root_missing", repoRelativePath, 1, 1, "XML document has no root element."));
    return;
  }
  if (/\.svg$/i.test(repoRelativePath)) {
    if (parsedRoot.local !== "svg") findings.push(finding("fail", "svg_root_invalid", repoRelativePath, 1, 1, "SVG root element must be <svg>."));
    if (parsedRoot.uri !== SVG_NAMESPACE) findings.push(finding("fail", "svg_namespace_invalid", repoRelativePath, 1, 1, `SVG namespace must be ${SVG_NAMESPACE}.`));
    const viewBox = Object.values(parsedRoot.attributes).find((attribute) => attribute.local === "viewBox")?.value;
    if (!viewBox || !validViewBox(viewBox)) findings.push(finding("fail", "svg_viewbox_invalid", repoRelativePath, 1, 1, "SVG viewBox must contain four finite numbers with positive width and height."));
  }
}

function validViewBox(value: string): boolean {
  const values = value.trim().split(/[\s,]+/).map(Number);
  return values.length === 4 && values.every(Number.isFinite) && values[2] > 0 && values[3] > 0;
}

function finding(severity: "warn" | "fail", ruleId: string, file: string, line: number, column: number, reason: string): SvgXmlFinding {
  return { severity, rule_id: ruleId, file: file.replace(/\\/g, "/"), line, column, reason: reason.slice(0, 500) };
}

function isInside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\") && !/^[A-Za-z]:/.test(rel));
}
