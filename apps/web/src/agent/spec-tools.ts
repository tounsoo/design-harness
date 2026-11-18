import type { JsonPatch } from "@json-render/core";
import { formatIssues, parseJson, parsePrototype, specIssues, type JsonValue, type ProjectConfig, type Prototype } from "@design-harness/core";
import type { JsonSchema } from "./schema";
import type { AgentHost, ToolOutcome } from "./tools";

/**
 * The agent's edit tools for a spec prototype. They work on the spec as
 * data: write_spec replaces a whole spec file, patch_spec applies RFC 6902
 * JSON Patch operations in json-render's SpecStream form (one JSON object
 * per line, the format json-render's prompt teaches). Before anything is
 * applied, the result is checked against the project's catalog with core's
 * spec validation, and a change with any issue in the file is refused whole
 * with core's words, so the agent cannot write an element, prop or
 * expression the catalog does not have.
 *
 * json-render's core is loaded when the first patch is applied: it bundles
 * zod, which the rest of the app does not need.
 *
 * json-render applies patches leniently, for streaming: `replace` and `add`
 * create what is missing and `remove` of nothing does nothing. An edit is
 * not a stream, so each operation's target is checked first, and an
 * operation that would silently do nothing or something else is refused.
 */

const SPEC_PATH: JsonSchema = {
  type: "string",
  pattern: "^(?!manifest\\.json$)[A-Za-z0-9_-]+(?:/[A-Za-z0-9_.-]+)*\\.json$",
  maxLength: 160,
  description: 'A spec file inside the prototype, such as "pages/booking.json" or "layouts/room-details.json".',
};

export const SPEC_TOOL_SCHEMAS = {
  write_spec: {
    type: "object",
    properties: {
      path: SPEC_PATH,
      spec: { type: "object", description: 'The whole spec: { "root", "elements", and on a page "state" }, as the catalog\'s instructions describe.' },
    },
    required: ["path", "spec"],
    additionalProperties: false,
  },
  patch_spec: {
    type: "object",
    properties: {
      path: SPEC_PATH,
      patches: {
        type: "string",
        minLength: 1,
        maxLength: 100_000,
        description: 'JSON Patch operations, one JSON object per line, as the catalog\'s instructions show: {"op":"replace","path":"/elements/book/props/text","value":"Book now"}. add, remove, replace, move, copy and test; paths are JSON Pointers into the spec.',
      },
    },
    required: ["path", "patches"],
    additionalProperties: false,
  },
} as const satisfies Record<string, JsonSchema>;

export const SPEC_TOOL_DESCRIPTIONS: Readonly<Record<keyof typeof SPEC_TOOL_SCHEMAS, string>> = {
  write_spec:
    "Create a spec file, or replace one whole. Use it for a new page or layout; use patch_spec to change part of one. Core checks the spec against the project's catalog first: one with any issue is not applied, and the issues come back. A new page or layout also needs its entry in the manifest (set_manifest). The change is a new revision at once.",
  patch_spec:
    "Change part of a spec file with JSON Patch operations, one per line, applied in order. Every operation's target must exist (add's parent must): one that does not is refused with the line. Core then checks the result against the project's catalog; a result with any issue is not applied, and the issues come back. The change is a new revision at once, and the canvas shows the spec as the operations stream in.",
};

const refused = (title: string, content: string): ToolOutcome => ({ content, isError: true, changed: false, title });

/** One element per line, as the fixtures are written, so a finding's line is an element's line. */
export function formatSpec(value: JsonValue): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return `${JSON.stringify(value, null, 2)}\n`;
  const record = value as Record<string, JsonValue>;
  const elements = record.elements;
  if (typeof elements !== "object" || elements === null || Array.isArray(elements)) return `${JSON.stringify(value, null, 2)}\n`;
  const lines = ["{"];
  const keys = Object.keys(record);
  keys.forEach((key, index) => {
    const comma = index < keys.length - 1 ? "," : "";
    if (key === "elements") {
      const entries = Object.entries(elements as Record<string, JsonValue>);
      lines.push('  "elements": {');
      entries.forEach(([name, element], at) => lines.push(`    ${JSON.stringify(name)}: ${JSON.stringify(element)}${at < entries.length - 1 ? "," : ""}`));
      lines.push(`  }${comma}`);
    } else {
      const text = JSON.stringify(record[key], null, 2).split("\n");
      lines.push(`  ${JSON.stringify(key)}: ${text[0]}`, ...text.slice(1).map((line) => `  ${line}`));
      lines[lines.length - 1] += comma;
    }
  });
  lines.push("}");
  return `${lines.join("\n")}\n`;
}

function pointerParts(path: string): string[] | null {
  if (path === "") return [];
  if (!path.startsWith("/")) return null;
  return path
    .slice(1)
    .split("/")
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function has(root: unknown, parts: readonly string[]): boolean {
  let current: unknown = root;
  for (const part of parts) {
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(part) || Number(part) >= current.length) return false;
      current = current[Number(part)];
    } else if (typeof current === "object" && current !== null) {
      if (!Object.hasOwn(current, part)) return false;
      current = (current as Record<string, unknown>)[part];
    } else return false;
  }
  return true;
}

/** Why a patch would not do what it says to this value, or null when it will. */
function patchProblem(target: unknown, patch: JsonPatch): string | null {
  const parts = pointerParts(patch.path);
  if (parts === null) return `path ${JSON.stringify(patch.path)} is not a JSON Pointer`;
  if (parts.includes("__proto__")) return `path ${JSON.stringify(patch.path)} names __proto__`;
  const parent = parts.slice(0, -1);
  switch (patch.op) {
    case "add":
      if (parts.length === 0) return "add needs a path inside the spec";
      if (!has(target, parent)) return `add's parent ${JSON.stringify("/" + parent.join("/"))} does not exist`;
      return null;
    case "remove":
    case "replace":
    case "test":
      return parts.length > 0 && has(target, parts) ? null : `${patch.op} needs ${JSON.stringify(patch.path)} to exist, and it does not`;
    case "move":
    case "copy": {
      const from = typeof patch.from === "string" ? pointerParts(patch.from) : null;
      if (!from || !has(target, from)) return `${patch.op} needs "from" to name something that exists`;
      return has(target, parent) ? null : `${patch.op}'s parent ${JSON.stringify("/" + parent.join("/"))} does not exist`;
    }
    default:
      return `"${String((patch as { op?: unknown }).op)}" is not a JSON Patch operation`;
  }
}

/**
 * The prototype a spec change would make, checked: the file's own issues
 * against the catalog, judged as the manifest names it, or as a page when
 * its root is a Page and the manifest does not name it yet.
 */
function checked(config: ProjectConfig, current: Prototype, path: string, text: string): { next: Prototype } | { problems: string } {
  const next: Prototype = { ...current, files: { ...current.files, [path]: text } };
  const named = next.pages.some((page) => page.component.file === path) || next.layouts.some((layout) => layout.component.file === path);
  let judged = next;
  if (!named) {
    const parsed = parseJson(text);
    const value = parsed.ok ? parsed.value : null;
    const root = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, JsonValue>) : null;
    const elements = root?.elements as Record<string, { type?: unknown }> | undefined;
    const isPage = typeof root?.root === "string" && elements?.[root.root]?.type === "Page";
    if (isPage) judged = { ...next, pages: [...next.pages, { id: "new-page", pageType: next.pages[0]?.pageType ?? "page", component: { file: path, export: "default" } }] };
  }
  const problems = specIssues(judged, config).filter((issue) => issue.file === path);
  if (problems.length > 0) return { problems: problems.map((issue) => `${issue.at.file}:${issue.at.line}:${issue.at.column}: ${issue.message}`).join("\n") };
  const valid = parsePrototype(next);
  if (!valid.ok) return { problems: formatIssues(valid.error) };
  return { next };
}

function apply(host: AgentHost, next: Prototype, title: string, done: string): ToolOutcome {
  const { revision } = host.apply(next);
  return { content: `${done} Revision ${revision} is rendering; the checks for it follow this round.`, isError: false, changed: true, title };
}

export function writeSpec(host: AgentHost, path: string, spec: JsonValue): ToolOutcome {
  const current = host.prototype();
  const text = formatSpec(spec);
  if (current.files[path] === text) return { content: `${path} already has exactly this spec; nothing changed.`, isError: false, changed: false, title: `Wrote ${path} (unchanged)` };
  const result = checked(host.config(), current, path, text);
  if ("problems" in result) return refused(`write_spec: ${path} refused`, `The spec does not fit the project's catalog, so nothing was written:\n${result.problems}`);
  const existed = current.files[path] !== undefined;
  return apply(host, result.next, `${existed ? "Rewrote" : "Created"} ${path}`, `${existed ? "Replaced" : "Created"} ${path}.`);
}

export async function patchSpec(host: AgentHost, path: string, patches: string): Promise<ToolOutcome> {
  const { applySpecStreamPatch, parseSpecStreamLine } = await import("@json-render/core");
  const current = host.prototype();
  const text = current.files[path];
  if (text === undefined) return refused(`patch_spec: no ${path}`, `There is no file "${path}". Use write_spec to create it.`);
  const parsed = parseJson(text);
  if (!parsed.ok) return refused(`patch_spec: ${path} does not parse`, `${path} does not parse as JSON (${parsed.message} at line ${parsed.at.line}), so it cannot be patched. Replace it with write_spec.`);
  const target = structuredClone(parsed.value) as Record<string, unknown>;
  const lines = patches.split("\n").map((line) => line.trim());
  let count = 0;
  for (const [index, line] of lines.entries()) {
    if (line === "") continue;
    const patch = parseSpecStreamLine(line);
    if (!patch) return refused(`patch_spec: ${path} not changed`, `Line ${index + 1} is not a JSON Patch operation ({"op", "path", ...}): ${line.slice(0, 200)}. Nothing was applied.`);
    const problem = patchProblem(target, patch);
    if (problem) return refused(`patch_spec: ${path} not changed`, `Line ${index + 1} cannot apply: ${problem}. Nothing was applied.`);
    try {
      applySpecStreamPatch(target, patch);
    } catch (error) {
      return refused(`patch_spec: ${path} not changed`, `Line ${index + 1} failed: ${error instanceof Error ? error.message : String(error)}. Nothing was applied.`);
    }
    count += 1;
  }
  if (count === 0) return refused(`patch_spec: ${path} not changed`, "There were no operations to apply.");
  const next = formatSpec(target as JsonValue);
  if (next === text) return { content: `The operations leave ${path} as it was; nothing changed.`, isError: false, changed: false, title: `Patched ${path} (unchanged)` };
  const result = checked(host.config(), current, path, next);
  if ("problems" in result) return refused(`patch_spec: ${path} refused`, `After the ${count} operation${count === 1 ? "" : "s"}, the spec does not fit the project's catalog, so nothing was applied:\n${result.problems}`);
  return apply(host, result.next, `Patched ${path}`, `Applied ${count} operation${count === 1 ? "" : "s"} to ${path}.`);
}
