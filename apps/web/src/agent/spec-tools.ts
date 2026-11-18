import type { JsonPatch } from "@json-render/core";
import { LAYOUT_TYPE, PAGE_TYPE, formatIssues, parseJson, parsePrototype, specIssues, specLayouts, type JsonValue, type ProjectConfig, type Prototype } from "@design-harness/core";
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
 *
 * Three tools work on layouts: list_layouts reads them with their
 * parameters (core's `specLayouts`), insert_layout draws a new instance,
 * and set_layout_params changes one. Both edits go through the same check.
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
  list_layouts: { type: "object", properties: {}, additionalProperties: false },
  insert_layout: {
    type: "object",
    properties: {
      path: SPEC_PATH,
      into: {
        type: "object",
        properties: {
          element: { type: "string", minLength: 1, maxLength: 120, description: "The key of the element the instance goes in: a Page, or a part that takes children." },
          slot: { type: "string", minLength: 1, maxLength: 120, description: "On a Page, the slot it goes in, such as \"body\"." },
          index: { type: "integer", minimum: 0, description: "Where in that list; the end when left out." },
        },
        required: ["element"],
        additionalProperties: false,
      },
      key: { type: "string", pattern: "^[A-Za-z0-9_-]+$", maxLength: 80, description: "The new element's key, unique in the file." },
      layout: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", description: "The layout's id, as list_layouts shows it." },
      params: { type: "object", description: "A value for each parameter but its slots, by name: a literal of its type, or an expression that reads the page." },
      slots: { type: "object", additionalProperties: { type: "array", items: { type: "string" } }, description: "For each slot parameter, the keys of elements of this file that fill it." },
    },
    required: ["path", "into", "key", "layout"],
    additionalProperties: false,
  },
  set_layout_params: {
    type: "object",
    properties: {
      path: SPEC_PATH,
      key: { type: "string", minLength: 1, maxLength: 120, description: "The instance's key: a Layout element of this file." },
      set: { type: "object", description: "Parameters to give a new value, by name." },
      remove: { type: "array", items: { type: "string" }, description: "Parameters to take off, so an optional one falls back to its default." },
      slots: { type: "object", additionalProperties: { type: "array", items: { type: "string" } }, description: "Slots to fill anew, each with the keys of elements of this file; an empty list empties it." },
    },
    required: ["path", "key"],
    additionalProperties: false,
  },
} as const satisfies Record<string, JsonSchema>;

export const SPEC_TOOL_DESCRIPTIONS: Readonly<Record<keyof typeof SPEC_TOOL_SCHEMAS, string>> = {
  write_spec:
    "Create a spec file, or replace one whole. Use it for a new page or layout; use patch_spec to change part of one. Core checks the spec against the project's catalog first: one with any issue is not applied, and the issues come back. A new page or layout also needs its entry in the manifest (set_manifest). The change is a new revision at once.",
  patch_spec:
    "Change part of a spec file with JSON Patch operations, one per line, applied in order. Every operation's target must exist (add's parent must): one that does not is refused with the line. Core then checks the result against the project's catalog; a result with any issue is not applied, and the issues come back. The change is a new revision at once, and the canvas shows the spec as the operations stream in.",
  list_layouts:
    "List the prototype's layouts: each one's id, file, whether the inventory has it, its parameters (name, type, required or not, default, example, description) and where the prototype draws it. Call it before drawing or changing an instance.",
  insert_layout:
    "Draw a new instance of a layout in a spec file: a Layout element with the layout's id, a value for its parameters and its slots filled, put in a Page's slot or a part's children. Core checks the file first, with the layout's parameters; a change with any issue is not applied, and the issues come back. The change is a new revision at once.",
  set_layout_params:
    "Change an instance's parameters: give some new values, take some off, and fill its slots anew. Core checks the file first, with the layout's parameters; a change with any issue is not applied, and the issues come back. The change is a new revision at once.",
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
    const isPage = typeof root?.root === "string" && elements?.[root.root]?.type === PAGE_TYPE;
    // A new layout is judged as one, under an id from its file name, until set_manifest registers it.
    const id = (path.split("/").pop() ?? "layout").replace(/\.json$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "new-layout";
    if (isPage) judged = { ...next, pages: [...next.pages, { id: "new-page", pageType: next.pages[0]?.pageType ?? "page", component: { file: path, export: "default" } }] };
    else if (root) judged = { ...next, layouts: [...next.layouts, { id: next.layouts.some((layout) => layout.id === id) ? `${id}-new` : id, component: { file: path, export: "default" } }] };
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

/** The prototype's layouts as the agent reads them: core's summary, as JSON. */
export function listLayouts(host: AgentHost): ToolOutcome {
  const layouts = specLayouts(host.prototype(), host.config());
  const content =
    layouts.length === 0
      ? "This prototype has no layouts in its manifest. A layout is a spec file registered in the manifest's layouts and in the project's inventory."
      : JSON.stringify(
          layouts.map((layout) => ({
            id: layout.id,
            file: layout.file,
            inventoried: layout.inventoried,
            params: Object.fromEntries(layout.params.map(({ name, type, words, required, ...rest }) => [name, { type, is: words, required, ...rest }])),
            drawnAt: layout.uses.map((use) => `${use.file}:${use.line} (element "${use.key}")`),
          })),
          null,
          1,
        );
  return { content, isError: false, changed: false, title: `Listed ${layouts.length} ${layouts.length === 1 ? "layout" : "layouts"}` };
}

type SpecObject = { root?: unknown; elements?: Record<string, Record<string, unknown>>; [key: string]: unknown };

/** A spec file as an object to change, or why it cannot be. */
function specObject(host: AgentHost, path: string, tool: string): { spec: SpecObject; text: string } | ToolOutcome {
  const text = host.prototype().files[path];
  if (text === undefined) return refused(`${tool}: no ${path}`, `There is no file "${path}".`);
  const parsed = parseJson(text);
  if (!parsed.ok) return refused(`${tool}: ${path} does not parse`, `${path} does not parse as JSON (${parsed.message} at line ${parsed.at.line}). Replace it with write_spec.`);
  const spec = structuredClone(parsed.value) as SpecObject;
  if (typeof spec !== "object" || spec === null || Array.isArray(spec) || typeof spec.elements !== "object" || spec.elements === null) return refused(`${tool}: ${path} is not a spec`, `${path} has no "elements".`);
  return { spec, text };
}

function commit(host: AgentHost, path: string, before: string, spec: SpecObject, tool: string, title: string, done: string): ToolOutcome {
  const next = formatSpec(spec as JsonValue);
  if (next === before) return { content: `That leaves ${path} as it was; nothing changed.`, isError: false, changed: false, title: `${title} (unchanged)` };
  const result = checked(host.config(), host.prototype(), path, next);
  if ("problems" in result) return refused(`${tool}: ${path} refused`, `The change does not fit the project's catalog or the layout's parameters, so nothing was applied:\n${result.problems}`);
  return apply(host, result.next, title, done);
}

export function insertLayout(host: AgentHost, input: { path: string; into: { element: string; slot?: string; index?: number }; key: string; layout: string; params?: Record<string, JsonValue>; slots?: Record<string, string[]> }): ToolOutcome {
  const opened = specObject(host, input.path, "insert_layout");
  if ("isError" in opened) return opened;
  const { spec, text } = opened;
  const elements = spec.elements as Record<string, Record<string, unknown>>;
  if (Object.hasOwn(elements, input.key)) return refused(`insert_layout: ${input.key} exists`, `${input.path} already has an element "${input.key}". Give the instance a key of its own.`);
  if (Object.hasOwn(input.params ?? {}, "id")) return refused("insert_layout: input refused", 'params has "id"; the layout\'s id goes in "layout".');
  const parent = elements[input.into.element];
  if (!parent || typeof parent !== "object") return refused(`insert_layout: no ${input.into.element}`, `${input.path} has no element "${input.into.element}".`);
  let list: unknown[];
  if (parent.type === PAGE_TYPE) {
    if (input.into.slot === undefined) return refused("insert_layout: no slot", `"${input.into.element}" is a Page: say which of its slots the instance goes in with into.slot.`);
    const slots = (parent.slots ??= {}) as Record<string, unknown[]>;
    list = slots[input.into.slot] ??= [];
  } else {
    if (input.into.slot !== undefined) return refused("insert_layout: not a Page", `"${input.into.element}" is a ${String(parent.type)}, not a Page; leave out into.slot to put the instance in its children.`);
    list = (parent.children ??= []) as unknown[];
  }
  if (!Array.isArray(list)) return refused("insert_layout: not a list", `The list the instance would go in is not a list of keys.`);
  const at = input.into.index === undefined ? list.length : Math.min(input.into.index, list.length);
  list.splice(at, 0, input.key);
  elements[input.key] = { type: LAYOUT_TYPE, props: { id: input.layout, ...input.params }, ...(input.slots && Object.keys(input.slots).length > 0 ? { slots: input.slots } : {}), children: [] };
  return commit(host, input.path, text, spec, "insert_layout", `Drew ${input.layout} in ${input.path}`, `Drew an instance of layout "${input.layout}" as element "${input.key}" in ${input.path}.`);
}

export function setLayoutParams(host: AgentHost, input: { path: string; key: string; set?: Record<string, JsonValue>; remove?: string[]; slots?: Record<string, string[]> }): ToolOutcome {
  const opened = specObject(host, input.path, "set_layout_params");
  if ("isError" in opened) return opened;
  const { spec, text } = opened;
  const element = (spec.elements as Record<string, Record<string, unknown>>)[input.key];
  if (!element || element.type !== LAYOUT_TYPE) return refused(`set_layout_params: no instance ${input.key}`, `${input.path} has no Layout element "${input.key}"${element ? `; it is a ${String(element.type)}` : ""}.`);
  if (Object.hasOwn(input.set ?? {}, "id") || (input.remove ?? []).includes("id")) return refused("set_layout_params: input refused", 'The layout an instance draws is its "id", which this tool does not change; draw a new instance with insert_layout instead.');
  const props = (element.props ??= {}) as Record<string, unknown>;
  for (const name of input.remove ?? []) {
    if (!Object.hasOwn(props, name)) return refused("set_layout_params: nothing to remove", `"${input.key}" gives no "${name}", so it cannot be taken off.`);
    delete props[name];
  }
  Object.assign(props, input.set ?? {});
  if (input.slots) {
    const slots = (element.slots ??= {}) as Record<string, unknown>;
    for (const [name, keys] of Object.entries(input.slots)) {
      if (keys.length === 0) delete slots[name];
      else slots[name] = keys;
    }
    if (Object.keys(slots).length === 0) delete element.slots;
  }
  const what = [...Object.keys(input.set ?? {}).map((name) => `set ${name}`), ...(input.remove ?? []).map((name) => `took off ${name}`), ...Object.keys(input.slots ?? {}).map((name) => `filled slot ${name}`)];
  return commit(host, input.path, text, spec, "set_layout_params", `Changed ${input.key}'s parameters in ${input.path}`, `Instance "${input.key}" in ${input.path}: ${what.join(", ") || "no change"}.`);
}
