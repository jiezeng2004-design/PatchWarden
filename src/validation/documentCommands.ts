export interface DocumentCommandEvidence {
  command: string;
  script_name: string;
  source_type: "code_block" | "inline_code" | "shell_line" | "narrative_example";
  classification: "documented_command" | "example";
  line: number;
}

export function extractDocumentCommandEvidence(content: string): DocumentCommandEvidence[] {
  const lines = content.split(/\r?\n/);
  const evidence: DocumentCommandEvidence[] = [];
  let fence: { marker: string; example: boolean } | null = null;
  let previousContext = "";
  const commandPattern = /npm(?:\.cmd)?\s+run\s+([a-zA-Z0-9:_-]+)(?:\s+(?![.,;:]?(?:$|`))[^\r\n`]*)?/i;
  const isExampleContext = (value: string) => /\b(?:example|sample|historical|hypothetical|e\.g\.)\b|示例|例如|假设/i.test(value);
  const isExampleHeading = (value: string) => /^#{1,6}\s+.*(?:example|sample|示例|例子)/i.test(value);

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const fenceMatch = line.match(/^\s*(```+|~~~+)\s*([^\s]*)/);
    if (fenceMatch) {
      if (!fence) fence = { marker: fenceMatch[1][0], example: isExampleHeading(previousContext) || isExampleContext(fenceMatch[2]) };
      else if (fence.marker === fenceMatch[1][0]) fence = null;
      continue;
    }
    if (fence) {
      const match = line.match(commandPattern);
      if (match) evidence.push(commandEvidence(match, "code_block", fence.example ? "example" : "documented_command", index + 1));
      continue;
    }
    let lineWithoutInline = line;
    for (const inline of line.matchAll(/`([^`\r\n]+)`/g)) {
      const command = inline[1].match(commandPattern);
      if (command) evidence.push(commandEvidence(command, "inline_code", isExampleContext(line) ? "example" : "documented_command", index + 1));
      lineWithoutInline = lineWithoutInline.replace(inline[0], " ");
    }
    const explicit = lineWithoutInline.match(/^\s*(?:(?:[-*+]\s+|\d+[.)]\s+|>\s*|\$\s*|PS>\s*)|(?:(?:run|command|命令)\s*[:：]\s*))?(npm(?:\.cmd)?\s+run\s+[a-zA-Z0-9:_-]+(?:\s+[^#\r\n]*)?)\s*(?:#.*)?$/i);
    if (explicit) {
      const command = explicit[1].match(commandPattern);
      if (command) evidence.push(commandEvidence(command, "shell_line", isExampleContext(line) || isExampleHeading(previousContext) ? "example" : "documented_command", index + 1));
    } else {
      const narrative = lineWithoutInline.match(commandPattern);
      if (narrative) evidence.push(commandEvidence(narrative, "narrative_example", "example", index + 1));
    }
    if (line.trim()) previousContext = line.trim();
  }
  return evidence;
}

export function extractActionableNpmScriptNames(content: string): string[] {
  return [...new Set(extractDocumentCommandEvidence(content)
    .filter((entry) => entry.classification === "documented_command")
    .map((entry) => entry.script_name))];
}

function commandEvidence(match: RegExpMatchArray, sourceType: DocumentCommandEvidence["source_type"], classification: DocumentCommandEvidence["classification"], line: number): DocumentCommandEvidence {
  return { command: match[0].trim().replace(/\s+/g, " ").slice(0, 500), script_name: match[1], source_type: sourceType, classification, line };
}
