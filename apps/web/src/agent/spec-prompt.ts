import { SPEC_ACTIONS, specCatalog, type CatalogComponent, type ProjectConfig, type PropSchema, type SpecCatalog } from "@design-harness/core";

/**
 * The spec mode's catalog instructions, written here from core's catalog.
 * They teach only what core accepts: the flat spec, the expressions and
 * actions core reads, layouts with parameters (core's own format, which
 * json-render never sees), and each component with its props. json-render's
 * `catalog.prompt()`, which the trial used, was 25,576 characters for Nook
 * and taught watchers, `$computed`, `validateForm` and JSONL-only replies,
 * which core refuses or the app does not want; this replaces it.
 *
 * Pure: the same config gives the same bytes, so the prompt stays a cached
 * prefix until a proposal changes the catalog. The prototype's own layouts
 * are not in it, since they change as the agent works: list_layouts reads
 * them.
 */

function type(schema: PropSchema): string {
  switch (schema.type) {
    case "enum":
      return schema.values.map((value) => JSON.stringify(value)).join(" | ");
    case "options":
      return '[{ "value", "label" }]';
    default:
      return schema.type;
  }
}

function line(name: string, component: CatalogComponent): string {
  const props = Object.entries(component.props).map(([prop, schema]) => `${prop}${schema.required ? "" : "?"}: ${type(schema)}${"bind" in schema && schema.bind ? " (bindable)" : ""}`);
  const extras = [component.slots.length > 0 && component.kind === "part" ? "children" : null, component.events.length > 0 ? `on: ${component.events.join(", ")}` : null].filter(Boolean);
  // The catalog's own description, less what the line already says: the part's name and package, and how it takes text and options.
  const said = component.kind === "part" ? component.description.slice(component.description.indexOf(" from ")).replace(/^ from [^ ]+?\.(\s|$)/, "").replace(/It takes text in its text prop and child elements\.\s*/, "").replace(/Its options are data: a list of \{ value, label \}\.\s*/, "").trim() : "";
  return `- ${name} { ${props.join(", ")} }${extras.length > 0 ? ` ${extras.join("; ")}` : ""}${said ? `. ${said}` : ""}`;
}

/** The instructions for a catalog, exactly. */
export function catalogInstructions(catalog: SpecCatalog): string {
  const parts = Object.entries(catalog.components).filter(([, component]) => component.kind === "part");
  const page = catalog.components.Page;
  const layout = catalog.components.Layout;
  return `THE SPEC FORMAT
A spec file is one JSON object: { "root": "<key>", "elements": { "<key>": { "type", "props", "children" } } }, with "state" on a page and "params" on a layout. Element keys are unique in a file and hold no "/". "children" lists keys; each element has one parent and is listed once.
- A page's root is a Page. ${page?.description ?? ""} Its "slots" hold the page, one list of keys per slot; its "children" stay empty.
- A part's own text goes in its "text" prop. A Field.Select's choices go in its "options" prop as [{ "value", "label" }].
- A value is a literal, or one of these, and nothing else:
  { "$state": "/room/name" } reads the page's state. /scenario/state is the scenario's flow state and /scenario/id its id; the harness sets them, so never write /scenario, and never use /params.
  { "$item": "name" } (or "" for the item itself) and { "$index": true } read the item inside a repeat.
  { "$template": "\${/room/seats} seats, \${name}" } makes text: \${/path} reads state, \${field} the item.
  { "$cond": <condition>, "$then": <value>, "$else": <value> } picks one of two values.
  { "$bindState": "/form/name" } on a bindable prop: the part writes its value there.
  { "$scopedId": "field" } is an element id unique to its layout instance (and per item inside a repeat with a "key"); give an id and the htmlFor that names it the same one.
- "visible": <condition> shows an element only while it holds: { "$state": "/scenario/state", "eq": "booked" }; one of $state, $item or $index, at most one of eq, neq, gt, gte, lt, lte, and "not": true; { "$and": [...] } and { "$or": [...] } join them.
- "repeat": { "statePath": "/rooms", "key": "id" } draws an element's children once per item of a list.
- "on": { "press": { "action": ${SPEC_ACTIONS.map((action) => `"${action}"`).join(" | ")}, "params": { "statePath": "/path", ... } } } only on a part with on: press.
- Never write $computed, $bindItem, watch, validateForm, another action, style or className: the checks refuse them.

LAYOUTS
A page's body holds only layout instances. A layout is a spec file of its own, registered in the manifest's layouts and in the project's inventory, which declares typed parameters, so a page draws it as often as it needs with different data.
- Declare them in "params": { "label": { "type": "text", "description": "...", "example": "How long?" } }. Types: "text", "number", "boolean", "enum" (with "values": [...]), "list" (with "of": "text" | "number" | "boolean" | "option" | { "record": { "field": "text" } }), "binding" (where a bindable part writes its value), and "slot" (child elements the page passes in). A parameter is required unless it has a "default" or "required": false.
- Read one with { "$param": "label" } as a prop's value, with "repeat": { "param": "rooms", "key": "id" } for a list, and with { "$param": "hint" } as an entry of "children" for a slot, placed once. A layout reads only its parameters and the page's state; it has no state of its own.
- Draw one on a page: ${layout?.description ?? ""} For example { "type": "Layout", "props": { "id": "select-question", "label": "How long?", "choices": { "$state": "/durations" }, "answer": { "$bindState": "/duration" } }, "slots": { "hint": ["hint-text"] }, "children": [] }. A value for a parameter is a literal of its type or an expression that reads the page; a binding is { "$bindState": "/path" }.
- Each instance's elements and ids are its own: core keys them under the instance's key, so two instances never collide. A finding inside an instance names the layout's element and the page's use of it.
- list_layouts lists the prototype's layouts with their parameters and uses; insert_layout draws a new instance; set_layout_params changes an instance's parameters and slots.
- A layout the inventory lacks is an inventory change: draft a proposal with { "op": "add-layout", "id": "<id>" }, a rule that governs it, and examples whose files hold the layout's spec, its manifest entry and a page that draws it: one that passes, and one its rule flags.

COMPONENTS (${parts.length})
Props marked ? are optional. "children" means a part takes child elements as well as text.
${parts.map(([name, component]) => line(name, component)).join("\n")}${catalog.left.length > 0 ? `\nLeft out, which a spec cannot draw: ${catalog.left.map((item) => `${item.component} (${item.why})`).join("; ")}.` : ""}`;
}

/** The spec mode's catalog instructions for a project; throws when its library has no part descriptions. */
export function specCatalogPrompt(config: ProjectConfig): string {
  const catalog = specCatalog(config);
  if (!catalog) throw new Error(`the project's library (${config.library.package}) has no part descriptions, so there is no catalog to write specs from`);
  return catalogInstructions(catalog);
}
