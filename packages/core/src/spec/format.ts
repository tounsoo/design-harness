import { isRecord, type JsonValue } from "./json";

/**
 * A spec file's text as the fixtures are written: two-space JSON with one
 * element per line, so a finding's line is an element's line. Every tool
 * that writes a spec file writes it this way, so the same spec is the same
 * text wherever it comes from.
 */
export function formatSpec(value: JsonValue): string {
  if (!isRecord(value) || !isRecord(value.elements)) return `${JSON.stringify(value, null, 2)}\n`;
  const elements = value.elements;
  const lines = ["{"];
  const keys = Object.keys(value);
  keys.forEach((key, index) => {
    const comma = index < keys.length - 1 ? "," : "";
    if (key === "elements") {
      const entries = Object.entries(elements);
      lines.push('  "elements": {');
      entries.forEach(([name, element], at) => lines.push(`    ${JSON.stringify(name)}: ${JSON.stringify(element)}${at < entries.length - 1 ? "," : ""}`));
      lines.push(`  }${comma}`);
    } else {
      const text = JSON.stringify(value[key], null, 2).split("\n");
      lines.push(`  ${JSON.stringify(key)}: ${text[0]}`, ...text.slice(1).map((line) => `  ${line}`));
      lines[lines.length - 1] += comma;
    }
  });
  lines.push("}");
  return `${lines.join("\n")}\n`;
}
