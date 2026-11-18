import type { PropSchema, ProjectConfig } from "../config/types";
import type { SourceLocation } from "../extract/model";
import type { Prototype } from "../prototype/types";
import { LAYOUT_TYPE, PAGE_TYPE, SCENARIO_STATE, SPEC_ACTIONS, specCatalog, type CatalogComponent, type SpecCatalog } from "./catalog";
import { isRecord, parseJson, pointer, type JsonValue, type Position } from "./json";
import { LAYOUT_ID_PROP, PARAM_STATE, checkParamValue, isScopedIdName, paramMismatch, readParams, type LayoutParams } from "./params";

/**
 * Reading a spec prototype's files: each JSON file parsed with positions,
 * and every element checked against the catalog the config generates. What
 * fails is an issue, with the file and line it is about, and the element is
 * left out of what renders and of the page model, as a part the registry
 * does not have would render nothing. The shape is json-render's flat spec
 * (`root`, `elements` of `{ type, props, children }`, optional `state`), with
 * the subset of its expressions that keeps a spec data: no `$computed`
 * functions, no watchers, no custom actions. A layout file may also declare
 * `params`, and read them with `{ "$param": name }` (params.ts); a Layout
 * element sets them. Two expressions are core's own and never reach
 * json-render: `$param`, and `$scopedId`, an element id unique per instance.
 * Core expands both before anything renders (expand.ts).
 */

export type SpecIssue = { readonly file: string; readonly message: string; readonly at: SourceLocation };

export type Binding = { readonly action: (typeof SPEC_ACTIONS)[number]; readonly params: { readonly [key: string]: JsonValue } };

/** An entry of `children` or of a slot: an element's key, or, in a layout, `{ "$param": name }` for a slot parameter's elements. */
export type ChildRef = string | { readonly param: string };

/** A repeat over a list in state or in the item, or, in a layout, over a list parameter. */
export type SpecRepeat = { readonly statePath: string | { readonly $item: string }; readonly key?: string } | { readonly param: string; readonly key?: string };

export type SpecElement = {
  readonly key: string;
  readonly type: string;
  readonly props: { readonly [key: string]: JsonValue };
  readonly children: readonly ChildRef[];
  /** Named slots: a Page's, and a Layout instance's slot parameters. */
  readonly slots: { readonly [slot: string]: readonly ChildRef[] } | undefined;
  readonly visible: JsonValue | undefined;
  readonly repeat: SpecRepeat | undefined;
  readonly on: { readonly [event: string]: readonly Binding[] } | undefined;
};

/** The element keys a list of child references names, parameters left out. */
export function keysOf(list: readonly ChildRef[]): string[] {
  return list.filter((child): child is string => typeof child === "string");
}

export type SpecDoc = {
  readonly file: string;
  readonly root: string;
  /** The elements that passed validation, by key. An element that did not, and everything under it, is left out. */
  readonly elements: ReadonlyMap<string, SpecElement>;
  readonly state: { readonly [key: string]: JsonValue } | undefined;
  /** A layout's parameters, the ones that passed; none on a page. */
  readonly params: LayoutParams;
  readonly positions: ReadonlyMap<string, Position>;
  /** What the manifest makes this file. */
  readonly role: "page" | "layout" | "unused";
};

export type ReadSpecs = {
  readonly catalog: SpecCatalog | null;
  readonly docs: ReadonlyMap<string, SpecDoc>;
  /** Each manifest layout's parameters, by layout id: what an instance of it may set. */
  readonly layouts: ReadonlyMap<string, LayoutParams>;
  readonly issues: readonly SpecIssue[];
};

/** What checking one element needs beyond the catalog: the manifest, its file's parameters, and every layout's. */
type ReadContext = {
  readonly catalog: SpecCatalog;
  readonly prototype: Prototype;
  /** The parameters of the layout file being read; null in a page or an unused file. */
  readonly params: LayoutParams | null;
  readonly layouts: ReadonlyMap<string, LayoutParams>;
};

const ELEMENT_FIELDS = ["type", "props", "children", "slots", "visible", "repeat", "on"];
const OPERATORS = ["eq", "neq", "gt", "gte", "lt", "lte"];

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const quote = (items: readonly string[]) => items.map((item) => `"${item}"`).join(", ");

/** Where a JSON Pointer is in a file: the value's own position, or its nearest parent's. */
export function locateIn(file: string, positions: ReadonlyMap<string, Position>, path: readonly (string | number)[]): SourceLocation {
  for (let length = path.length; length >= 0; length -= 1) {
    const found = positions.get(pointer(path.slice(0, length)));
    if (found) return { file, line: found.line, column: found.column };
  }
  return { file, line: 1, column: 1 };
}

/** True for `{ "$...": ... }`: a json-render expression rather than a literal. */
export function isExpression(value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } {
  return isRecord(value) && Object.keys(value).some((key) => key.startsWith("$"));
}

/** Reads and validates every file of a spec prototype against the config's catalog. Pure and deterministic. */
export function readSpecs(prototype: Prototype, config: ProjectConfig): ReadSpecs {
  const catalog = specCatalog(config);
  const issues: SpecIssue[] = [];
  const docs = new Map<string, SpecDoc>();
  const roles = new Map<string, "page" | "layout">();
  for (const page of prototype.pages) roles.set(page.component.file, "page");
  for (const layout of prototype.layouts) {
    if (roles.get(layout.component.file) === "page") issues.push({ file: layout.component.file, message: `${layout.component.file} is both a page and layout "${layout.id}" in the manifest. A spec file is one or the other.`, at: { file: layout.component.file, line: 1, column: 1 } });
    else roles.set(layout.component.file, "layout");
  }
  for (const entry of [...prototype.pages.map((page) => ({ what: `page "${page.id}"`, ref: page.component })), ...prototype.layouts.map((layout) => ({ what: `layout "${layout.id}"`, ref: layout.component }))]) {
    const at = { file: entry.ref.file, line: 1, column: 1 };
    if (prototype.files[entry.ref.file] === undefined) issues.push({ file: entry.ref.file, message: `The manifest's ${entry.what} names ${entry.ref.file}, which is not a file in the prototype.`, at });
    if (entry.ref.export !== "default") issues.push({ file: entry.ref.file, message: `The manifest's ${entry.what} names export "${entry.ref.export}" of ${entry.ref.file}; a spec file is one spec, named "default".`, at });
  }
  if (!catalog) {
    issues.push({ file: "manifest.json", message: `The project's library (${config.library.package}) has no part descriptions (library.parts), so no catalog can be made and a spec prototype cannot be checked.`, at: { file: "manifest.json", line: 1, column: 1 } });
    return { catalog, docs, layouts: new Map(), issues };
  }
  // Every file is parsed first, and every layout's parameters read, so an instance in any file is checked against its layout's.
  const parsedFiles = new Map<string, { value: JsonValue; positions: ReadonlyMap<string, Position> }>();
  for (const file of Object.keys(prototype.files).sort(compare)) {
    if (!file.endsWith(".json")) {
      issues.push({ file, message: `${file} is not a JSON spec. A spec prototype holds only JSON spec files; it runs no code.`, at: { file, line: 1, column: 1 } });
      continue;
    }
    const parsed = parseJson(prototype.files[file] ?? "");
    if (!parsed.ok) {
      issues.push({ file, message: `${file} does not parse as JSON: it ${parsed.message}.`, at: { file, ...parsed.at } });
      continue;
    }
    parsedFiles.set(file, { value: parsed.value, positions: parsed.positions });
  }
  const paramsOf = new Map<string, LayoutParams>();
  for (const [file, parsed] of parsedFiles) {
    if (roles.get(file) !== "layout" || !isRecord(parsed.value) || parsed.value.params === undefined) continue;
    paramsOf.set(file, readParams(parsed.value.params, (message, ...path) => issues.push({ file, message: `${file}: ${message}`, at: locateIn(file, parsed.positions, path) })));
  }
  const layouts = new Map<string, LayoutParams>();
  for (const layout of prototype.layouts) layouts.set(layout.id, paramsOf.get(layout.component.file) ?? {});
  for (const [file, parsed] of parsedFiles) {
    const role = roles.get(file) ?? "unused";
    const doc = readDoc(file, parsed.value, parsed.positions, role, { catalog, prototype, params: role === "layout" ? (paramsOf.get(file) ?? {}) : null, layouts }, issues);
    if (doc) docs.set(file, doc);
  }
  return { catalog, docs, layouts, issues };
}

function readDoc(file: string, value: JsonValue, positions: ReadonlyMap<string, Position>, role: SpecDoc["role"], context: ReadContext, issues: SpecIssue[]): SpecDoc | null {
  const at = (...path: (string | number)[]) => locateIn(file, positions, path);
  const issue = (message: string, ...path: (string | number)[]) => issues.push({ file, message: `${file}: ${message}`, at: at(...path) });
  if (!isRecord(value)) {
    issue(`a spec is an object with "root" and "elements", not ${Array.isArray(value) ? "an array" : JSON.stringify(value)}.`);
    return null;
  }
  for (const key of Object.keys(value).sort(compare)) if (!["root", "elements", "state", "params"].includes(key)) issue(`has the field "${key}"; a spec has only "root", "elements", on a page "state", and on a layout "params".`, key);
  if (value.params !== undefined && role !== "layout") issue(`has "params", which only a layout has; a page gives values to the layouts it draws.`, "params");
  const root = value.root;
  const elementsValue = value.elements;
  if (typeof root !== "string" || root.length === 0) issue(`"root" must name the root element's key.`, "root");
  if (!isRecord(elementsValue)) {
    issue(`"elements" must be an object of elements by key.`, "elements");
    return null;
  }
  let state: { readonly [key: string]: JsonValue } | undefined;
  if (value.state !== undefined) {
    if (role !== "page") issue(`only a page spec has "state"; a layout reads the state of the page it is drawn on.`, "state");
    else if (!isRecord(value.state)) issue(`"state" must be an object.`, "state");
    else if (SCENARIO_STATE in value.state) issue(`"state" has "${SCENARIO_STATE}", which the harness sets for each scenario ({ id, state }); use another name.`, "state", SCENARIO_STATE);
    else if (PARAM_STATE in value.state) issue(`"state" has "${PARAM_STATE}", where the harness keeps the lists a page gives its layouts; use another name.`, "state", PARAM_STATE);
    else state = value.state;
  }

  const raw = new Map<string, SpecElement>();
  for (const key of Object.keys(elementsValue).sort(compare)) {
    // An instance's elements are keyed under its own key with "/", so a key of a file never holds one.
    if (key.includes("/") || key.length === 0) {
      issue(`has an element keyed ${JSON.stringify(key)}; a key is not empty and holds no "/", which core uses to key what a layout draws.`, "elements", key);
      continue;
    }
    const element = readElement(key, elementsValue[key] as JsonValue, context, (message, ...path) => issue(`element "${key}" ${message}`, "elements", key, ...path));
    if (element) raw.set(key, element);
  }
  if (typeof root === "string" && root.length > 0 && !(root in elementsValue)) issue(`"root" names "${root}", which is not an element.`, "root");

  // A slot parameter is placed once: the elements a page passes in are drawn once, where the layout lists the slot.
  if (context.params) {
    const placed = new Map<string, number>();
    for (const element of raw.values()) for (const list of [element.children, ...Object.values(element.slots ?? {})]) for (const child of list) if (typeof child !== "string") placed.set(child.param, (placed.get(child.param) ?? 0) + 1);
    for (const name of Object.keys(context.params).sort(compare)) {
      if (context.params[name]?.type !== "slot") continue;
      const count = placed.get(name) ?? 0;
      if (count === 0) issue(`declares slot "${name}" but places it nowhere: list { "$param": "${name}" } in the children of the element that holds it.`, "params", name);
      else if (count > 1) issue(`places slot "${name}" ${count} times; the elements a page passes in are drawn once, so list it once.`, "params", name);
    }
  }

  // Who refers to whom: each key once, from one parent, never the root, never a key that does not exist.
  const parent = new Map<string, string>();
  // From the root down first, so an element listed twice belongs to the parent the page reaches it through.
  const order: string[] = [];
  const queued = new Set<string>();
  const queue = typeof root === "string" ? [root] : [];
  while (queue.length > 0) {
    const key = queue.shift() as string;
    const element = raw.get(key);
    if (queued.has(key) || !element) continue;
    queued.add(key);
    order.push(key);
    queue.push(...Object.keys(element.slots ?? {}).sort(compare).flatMap((slot) => keysOf(element.slots?.[slot] ?? [])), ...keysOf(element.children));
  }
  for (const key of raw.keys()) if (!queued.has(key)) order.push(key);
  for (const element of order.map((key) => raw.get(key) as SpecElement)) {
    const refs: { list: readonly ChildRef[]; path: (string | number)[] }[] = [{ list: element.children, path: ["children"] }, ...Object.entries(element.slots ?? {}).map(([slot, list]) => ({ list, path: ["slots", slot] }))];
    for (const { list, path } of refs) {
      list.forEach((child, index) => {
        if (typeof child !== "string") return;
        const where = ["elements", element.key, ...path, index];
        if (!(child in elementsValue)) issue(`element "${element.key}" lists "${child}", which is not an element.`, ...where);
        else if (child === root) issue(`element "${element.key}" lists the root, "${child}", as a child.`, ...where);
        else if (parent.get(child) === element.key) issue(`element "${element.key}" lists "${child}" twice. An element is drawn once; give the copy a key of its own.`, ...where);
        else if (parent.has(child)) issue(`element "${element.key}" lists "${child}", which "${parent.get(child)}" already lists. An element has one parent; give the copy a key of its own.`, ...where);
        else parent.set(child, element.key);
      });
    }
  }
  // An element under itself would render forever.
  const looping = new Set<string>();
  for (const key of raw.keys()) {
    const seen = new Set<string>([key]);
    for (let up = parent.get(key); up !== undefined; up = parent.get(up)) {
      if (seen.has(up)) {
        if (up === key) issue(`element "${key}" is inside itself, so it would render forever.`, "elements", key);
        looping.add(key);
        break;
      }
      seen.add(up);
    }
  }
  // Where a Page may be: the root of a page spec, and nowhere else.
  for (const element of raw.values()) {
    if (element.type === PAGE_TYPE && (role !== "page" || element.key !== root)) issue(`element "${element.key}" is a Page, which only the root of a page spec can be.`, "elements", element.key, "type");
  }
  if (role === "page" && typeof root === "string" && raw.get(root) !== undefined && raw.get(root)?.type !== PAGE_TYPE) issue(`the root of a page spec is a Page, whose slots hold the page; "${root}" is a ${raw.get(root)?.type}.`, "elements", root, "type");

  // Leave out an element that failed, a misplaced Page, and everything only they reach; keep only the references that stand.
  const out = (key: string) => !raw.has(key) || looping.has(key) || (raw.get(key)?.type === PAGE_TYPE && key !== root);
  const kept = new Map<string, SpecElement>();
  for (const element of raw.values()) {
    let dropped = out(element.key);
    for (let up = parent.get(element.key); up !== undefined && !dropped; up = parent.get(up)) dropped = out(up);
    if (dropped) continue;
    const stands = (list: readonly ChildRef[]) => list.filter((child) => typeof child !== "string" || (parent.get(child) === element.key && !out(child)));
    kept.set(element.key, { ...element, children: stands(element.children), slots: element.slots ? Object.fromEntries(Object.entries(element.slots).map(([slot, list]) => [slot, stands(list)])) : undefined });
  }
  return { file, root: typeof root === "string" ? root : "", elements: kept, state, params: context.params ?? {}, positions, role };
}

type Report = (message: string, ...path: (string | number)[]) => void;

/**
 * One element, checked against the catalog. What renders is what passes: a
 * prop, a binding or a field that fails is reported and left off the
 * element; an element whose type, children, repeat or condition fails is
 * reported and left out, with everything under it, as json-render would draw
 * nothing for a type the registry lacks or a condition it cannot read.
 */
function readElement(key: string, value: JsonValue, context: ReadContext, report: Report): SpecElement | null {
  const { catalog } = context;
  if (!isRecord(value)) {
    report(`is not an object with "type", "props" and "children".`);
    return null;
  }
  let ok = true;
  const fail: Report = (message, ...path) => {
    ok = false;
    report(message, ...path);
  };
  for (const field of Object.keys(value).sort(compare)) {
    if (field === "watch") report(`has "watch", which runs actions when state changes; a spec here may not.`, field);
    else if (!ELEMENT_FIELDS.includes(field)) report(`has the field "${field}"; an element has only ${quote(ELEMENT_FIELDS)}.`, field);
  }
  const type = value.type;
  const component = typeof type === "string" ? catalog.components[type] : undefined;
  if (typeof type !== "string") {
    report(`has no "type".`);
    return null;
  }
  if (!component) {
    const parts = Object.keys(catalog.components).filter((name) => name !== PAGE_TYPE && name !== LAYOUT_TYPE);
    const roots = [...new Set(parts.map((name) => name.split(".")[0] as string))];
    const why = catalog.left.find((item) => item.component === type);
    report(why ? `is a ${type}, which the catalog leaves out: ${why.why}.` : `is a ${type}, which is not in the catalog. The catalog has the parts of the inventoried components (${roots.join(", ")}), Page and Layout.`, "type");
    return null;
  }
  const rawProps = value.props === undefined ? {} : value.props;
  let props: { readonly [key: string]: JsonValue } = {};
  if (!isRecord(rawProps)) report(`has "props" that is not an object.`, "props");
  else props = component.kind === "layout" ? checkInstance(rawProps, context, report, fail) : checkProps(type, component, rawProps, report, context);

  /** A list of element keys; in a layout, `{ "$param": name }` of a slot parameter may stand in it. */
  const keys = (list: JsonValue | undefined, ...path: (string | number)[]): ChildRef[] => {
    if (list === undefined) return [];
    if (!Array.isArray(list)) {
      fail(`has ${path.join(".")} that is not a list of element keys.`, ...path);
      return [];
    }
    const out: ChildRef[] = [];
    list.forEach((item, index) => {
      if (typeof item === "string") out.push(item);
      else if (isRecord(item) && Object.keys(item).length === 1 && "$param" in item) {
        const name = item.$param;
        const param = typeof name === "string" ? context.params?.[name] : undefined;
        if (!context.params) fail(`lists { "$param": ${JSON.stringify(name)} }, but only a layout has parameters.`, ...path, index);
        else if (!param) fail(`lists { "$param": ${JSON.stringify(name)} }, which is not a parameter of this layout${Object.keys(context.params).length > 0 ? ` (${quote(Object.keys(context.params))})` : ""}.`, ...path, index);
        else if (param.type !== "slot") fail(`lists parameter "${String(name)}" among its children, but "${String(name)}" is a ${param.type}, not a slot.`, ...path, index);
        else out.push({ param: name as string });
      } else fail(`has ${path.join(".")} that is not a list of element keys.`, ...path);
    });
    return out;
  };
  const children = keys(value.children, "children");
  if (children.length > 0 && component.kind !== "page" && component.content !== "children") fail(`has children, but a ${type} takes ${component.content === "options" ? "its options as data" : component.kind === "layout" ? 'none: a layout\'s slot parameters are filled in its "slots"' : "none"}.`, "children");
  let slots: Record<string, ChildRef[]> | undefined;
  if (value.slots !== undefined) {
    if (component.kind !== "page" && component.kind !== "layout") fail(`has named slots, which only a Page and a Layout have. Use "children".`, "slots");
    else if (!isRecord(value.slots)) fail(`has "slots" that is not an object of slot names.`, "slots");
    else slots = Object.fromEntries(Object.keys(value.slots).map((slot) => [slot, keys((value.slots as Record<string, JsonValue>)[slot], "slots", slot)]));
  }
  if (component.kind === "layout") {
    const id = typeof rawProps === "object" && rawProps !== null && !Array.isArray(rawProps) ? (rawProps as Record<string, JsonValue>)[LAYOUT_ID_PROP] : undefined;
    const params = typeof id === "string" ? context.layouts.get(id) : undefined;
    if (params) {
      for (const slot of Object.keys(slots ?? {}).sort(compare)) {
        if (params[slot]?.type !== "slot") fail(`fills slot "${slot}", which layout "${String(id)}" does not have${slotNames(params).length > 0 ? `; its slots are ${quote(slotNames(params))}` : "; it has no slots"}.`, "slots", slot);
      }
      for (const name of slotNames(params)) if (params[name]?.required && (slots?.[name] ?? []).length === 0) report(`has nothing in slot "${name}", which layout "${String(id)}" needs.`, "slots");
    }
  } else if (component.kind === "page") {
    for (const [slot, list] of Object.entries(slots ?? {})) if (list.some((child) => typeof child !== "string")) fail(`fills slot "${slot}" with a parameter; a Page's slots hold element keys.`, "slots", slot);
  }
  if (value.visible !== undefined) checkCondition(value.visible, fail, ["visible"]);
  let repeat: SpecElement["repeat"];
  if (value.repeat !== undefined) {
    const r = value.repeat;
    const statePath = isRecord(r) ? r.statePath : undefined;
    const pathOk = (typeof statePath === "string" && statePath.startsWith("/")) || (isRecord(statePath) && Object.keys(statePath).length === 1 && typeof statePath.$item === "string");
    const param = isRecord(r) ? r.param : undefined;
    const keyOk = isRecord(r) && (r.key === undefined || typeof r.key === "string");
    if (isRecord(r) && param !== undefined && keyOk && Object.keys(r).every((field) => field === "param" || field === "key")) {
      const declared = typeof param === "string" ? context.params?.[param] : undefined;
      if (!context.params) fail(`repeats over parameter ${JSON.stringify(param)}, but only a layout has parameters.`, "repeat", "param");
      else if (!declared) fail(`repeats over ${JSON.stringify(param)}, which is not a parameter of this layout${Object.keys(context.params).length > 0 ? ` (${quote(Object.keys(context.params))})` : ""}.`, "repeat", "param");
      else if (declared.type !== "list") fail(`repeats over parameter "${String(param)}", which is a ${declared.type}, not a list.`, "repeat", "param");
      else if (component.content !== "children") fail(`repeats its children, but a ${type} takes none.`, "repeat");
      else repeat = { param: param as string, ...(typeof r.key === "string" ? { key: r.key } : {}) };
    } else if (!isRecord(r) || !pathOk || !keyOk || Object.keys(r).some((field) => field !== "statePath" && field !== "key")) {
      fail(`has a "repeat" that is not { "statePath": "/path" or { "$item": "field" }, "key"?: "field" }${context.params ? ' or, in a layout, { "param": "name", "key"?: "field" }' : ""}.`, "repeat");
    } else if (component.content !== "children") fail(`repeats its children, but a ${type} takes none.`, "repeat");
    else repeat = { statePath: statePath as string | { $item: string }, ...(typeof r.key === "string" ? { key: r.key } : {}) };
  }
  let on: Record<string, Binding[]> | undefined;
  if (value.on !== undefined) {
    if (!isRecord(value.on)) report(`has "on" that is not an object of events.`, "on");
    else {
      on = {};
      for (const event of Object.keys(value.on).sort(compare)) {
        if (!(component.events as readonly string[]).includes(event)) {
          report(`binds the event "${event}", which a ${type} does not have${component.events.length > 0 ? `; it has ${quote(component.events)}` : ""}.`, "on", event);
          continue;
        }
        const bindings = readBindings(event, value.on[event] as JsonValue, report);
        if (bindings.length > 0) on[event] = bindings;
      }
      if (Object.keys(on).length === 0) on = undefined;
    }
  }
  if (!ok) return null;
  return { key, type, props, children, slots, visible: value.visible, repeat, on };
}

function readBindings(event: string, raw: JsonValue, report: Report): Binding[] {
  const list = Array.isArray(raw) ? raw : [raw];
  const bindings: Binding[] = [];
  list.forEach((binding, index) => {
    const path = ["on", event, ...(Array.isArray(raw) ? [index] : [])];
    if (!isRecord(binding) || typeof binding.action !== "string" || Object.keys(binding).some((field) => field !== "action" && field !== "params")) {
      report(`binds ${event} to something that is not { "action", "params" }.`, ...path);
      return;
    }
    if (!(SPEC_ACTIONS as readonly string[]).includes(binding.action)) {
      report(`binds ${event} to the action "${binding.action}"; a spec here may use only ${quote(SPEC_ACTIONS)}, which change the page's own state.`, ...path, "action");
      return;
    }
    const params = binding.params === undefined ? {} : binding.params;
    const statePath = isRecord(params) ? params.statePath : undefined;
    if (!isRecord(params) || typeof statePath !== "string" || !statePath.startsWith("/")) {
      report(`binds ${event} to ${binding.action} without a "statePath" such as "/form/name".`, ...path, "params");
      return;
    }
    if (statePath === `/${SCENARIO_STATE}` || statePath.startsWith(`/${SCENARIO_STATE}/`)) {
      report(`binds ${event} to ${binding.action} on ${statePath}, which the harness sets for each scenario.`, ...path, "params", "statePath");
      return;
    }
    bindings.push({ action: binding.action as Binding["action"], params });
  });
  return bindings;
}

const slotNames = (params: LayoutParams) => Object.keys(params).filter((name) => params[name]?.type === "slot").sort(compare);

function keep(kept: Record<string, JsonValue>, name: string, value: JsonValue): void {
  Object.defineProperty(kept, name, { value, enumerable: true, writable: true, configurable: true });
}

/** The props that pass, in key order; each one that does not is reported and left off. */
function checkProps(type: string, component: CatalogComponent, props: { readonly [key: string]: JsonValue }, report: Report, context: ReadContext): { readonly [key: string]: JsonValue } {
  const names = Object.keys(component.props);
  const kept: Record<string, JsonValue> = {};
  for (const name of Object.keys(props).sort(compare)) {
    const schema = component.props[name];
    if (!schema) {
      report(`sets "${name}", which a ${type} does not take. ${names.length > 0 ? `It takes ${quote(names)}.` : "It takes no props."}`, "props", name);
      continue;
    }
    let ok = true;
    checkValue(type, name, schema, props[name] as JsonValue, (message, ...path) => {
      ok = false;
      report(message, ...path);
    }, ["props", name], context.params);
    if (ok) keep(kept, name, props[name] as JsonValue);
  }
  for (const [name, schema] of Object.entries(component.props)) if (schema.required && props[name] === undefined) report(`has no "${name}", which a ${type} needs.`, "props");
  return kept;
}

/**
 * A Layout element's props: `id`, which names a layout of the manifest, and
 * a value for each of that layout's parameters but its slots. An unknown
 * layout leaves the instance out; a value that fails is reported and left
 * off, as a part's prop is; a required parameter with no value is reported.
 */
function checkInstance(props: { readonly [key: string]: JsonValue }, context: ReadContext, report: Report, fail: Report): { readonly [key: string]: JsonValue } {
  const id = props[LAYOUT_ID_PROP];
  if (typeof id !== "string") {
    fail(`has no "${LAYOUT_ID_PROP}" naming the layout it draws.`, "props");
    return {};
  }
  const params = context.layouts.get(id);
  if (!context.prototype.layouts.some((layout) => layout.id === id) || !params) {
    fail(`draws layout "${id}", which is not a layout of the manifest (${quote(context.prototype.layouts.map((layout) => layout.id)) || "none"}).`, "props", LAYOUT_ID_PROP);
    return {};
  }
  const kept: Record<string, JsonValue> = { [LAYOUT_ID_PROP]: id };
  const settable = Object.keys(params).filter((name) => params[name]?.type !== "slot").sort(compare);
  for (const name of Object.keys(props).sort(compare)) {
    if (name === LAYOUT_ID_PROP) continue;
    const param = params[name];
    if (!param) {
      report(`sets "${name}", which layout "${id}" does not take. ${settable.length > 0 ? `It takes ${quote(settable)}.` : "It takes no parameters."}`, "props", name);
      continue;
    }
    let ok = true;
    const failParam: Report = (message, ...path) => {
      ok = false;
      report(message, ...path);
    };
    checkParamValue(name, param, props[name] as JsonValue, { outer: context.params, condition: (condition, path) => checkCondition(condition, failParam, path) }, failParam, ["props", name]);
    if (ok) keep(kept, name, props[name] as JsonValue);
  }
  for (const name of settable) if (params[name]?.required && props[name] === undefined) report(`has no "${name}", which layout "${id}" needs.`, "props");
  return kept;
}

function describeSchema(schema: PropSchema): string {
  switch (schema.type) {
    case "enum":
      return `one of ${schema.values.map((value) => JSON.stringify(value)).join(", ")}`;
    case "options":
      return 'a list of { "value", "label" } strings';
    default:
      return `a ${schema.type}`;
  }
}

function checkValue(type: string, name: string, schema: PropSchema, value: JsonValue, fail: Report, path: (string | number)[], params: LayoutParams | null): void {
  if (isExpression(value)) {
    const keys = Object.keys(value).sort(compare);
    const only = (...allowed: string[]) => keys.length === allowed.length && allowed.every((key) => keys.includes(key));
    if (only("$param")) {
      const ref = value.$param;
      const param = typeof ref === "string" ? params?.[ref] : undefined;
      if (!params) fail(`sets ${name} with { "$param": ${JSON.stringify(ref)} }, but only a layout has parameters.`, ...path);
      else if (!param) fail(`sets ${name} with { "$param": ${JSON.stringify(ref)} }, which is not a parameter of this layout${Object.keys(params).length > 0 ? ` (${quote(Object.keys(params))})` : ""}.`, ...path);
      else {
        const why = paramMismatch(param, schema);
        if (why) fail(`sets ${name} with parameter "${String(ref)}", but ${why}.`, ...path);
      }
      return;
    }
    if (only("$scopedId")) {
      if (!isScopedIdName(value.$scopedId)) fail(`sets ${name} with { "$scopedId": ${JSON.stringify(value.$scopedId)} }; give a name such as "field".`, ...path);
      else if (schema.type !== "string") fail(`sets ${name} with $scopedId, which makes an id; ${name} is ${describeSchema(schema)}.`, ...path);
      return;
    }
    if (only("$state") || only("$item") || only("$bindItem")) {
      const ref = value.$state ?? value.$item ?? value.$bindItem;
      if (typeof ref !== "string" || ("$state" in value && !ref.startsWith("/"))) fail(`reads ${keys[0]} with ${JSON.stringify(ref)}; give a path such as "/room/name"${"$state" in value ? "" : ' or a field such as "name"'}.`, ...path);
      if ("$bindItem" in value && !("bind" in schema && schema.bind)) fail(`binds ${name} with $bindItem, but a ${type} cannot report a new ${name}.`, ...path);
      return;
    }
    if (only("$index")) {
      if (value.$index !== true) fail(`reads $index with ${JSON.stringify(value.$index)}; write { "$index": true }.`, ...path);
      return;
    }
    if (only("$bindState")) {
      if (!("bind" in schema && schema.bind)) fail(`binds ${name} to state, but a ${type} cannot report a new ${name}: only a prop with a change callback can be bound.`, ...path);
      else if (typeof value.$bindState !== "string" || !value.$bindState.startsWith("/")) fail(`binds ${name} with ${JSON.stringify(value.$bindState)}; give a path such as "/form/name".`, ...path);
      else if (value.$bindState === `/${SCENARIO_STATE}` || value.$bindState.startsWith(`/${SCENARIO_STATE}/`)) fail(`binds ${name} to ${value.$bindState}, which the harness sets for each scenario.`, ...path);
      return;
    }
    if (only("$template")) {
      if (schema.type !== "string") fail(`sets ${name} with $template, which makes a string; ${name} is ${describeSchema(schema)}.`, ...path);
      else if (typeof value.$template !== "string") fail(`has a $template that is not a string.`, ...path);
      return;
    }
    if (only("$cond", "$else", "$then")) {
      checkCondition(value.$cond as JsonValue, fail, [...path, "$cond"]);
      checkValue(type, name, schema, value.$then as JsonValue, fail, [...path, "$then"], params);
      checkValue(type, name, schema, value.$else as JsonValue, fail, [...path, "$else"], params);
      return;
    }
    if (keys.includes("$computed")) {
      fail(`sets ${name} with $computed, which calls a function; a spec here registers none, so it stays data.`, ...path);
      return;
    }
    fail(`sets ${name} with ${JSON.stringify(value).slice(0, 80)}, which is not an expression a spec here may use ($state, $item, $index, $bindState, $template, $cond, $scopedId${params ? ", $param" : ""}).`, ...path);
    return;
  }
  const bad = () => fail(`sets ${name} to ${JSON.stringify(value).slice(0, 80)}; a ${type}'s ${name} is ${describeSchema(schema)}.`, ...path);
  switch (schema.type) {
    case "string":
      if (typeof value !== "string") bad();
      return;
    case "number":
      if (typeof value !== "number") bad();
      return;
    case "boolean":
      if (typeof value !== "boolean") bad();
      return;
    case "enum":
      if (typeof value !== "string" || !schema.values.includes(value)) bad();
      return;
    case "options":
      if (!Array.isArray(value) || !value.every((item) => isRecord(item) && typeof item.value === "string" && typeof item.label === "string" && Object.keys(item).length === 2)) bad();
      return;
  }
}

/** json-render's visibility conditions, strictly: one source and at most one operator per condition. */
function checkCondition(condition: JsonValue, fail: Report, path: (string | number)[]): void {
  if (typeof condition === "boolean") return;
  if (Array.isArray(condition)) {
    condition.forEach((item, index) => checkCondition(item, fail, [...path, index]));
    return;
  }
  if (!isRecord(condition)) {
    fail(`has a condition ${JSON.stringify(condition)}; write true, false, { "$state": "/path", "eq": value } or a list of them.`, ...path);
    return;
  }
  for (const joiner of ["$and", "$or"]) {
    if (joiner in condition) {
      const list = condition[joiner];
      if (Object.keys(condition).length !== 1 || !Array.isArray(list)) fail(`has a ${joiner} condition that is not { "${joiner}": [conditions] }.`, ...path);
      else list.forEach((item, index) => checkCondition(item, fail, [...path, joiner, index]));
      return;
    }
  }
  const sources = ["$state", "$item", "$index"].filter((key) => key in condition);
  const operators = OPERATORS.filter((key) => key in condition);
  const extra = Object.keys(condition).filter((key) => !["$state", "$item", "$index", "not", ...OPERATORS].includes(key));
  const sourceOk = sources.length === 1 && (sources[0] === "$index" ? condition.$index === true : typeof condition[sources[0] as string] === "string");
  const operand = operators[0] === undefined ? undefined : condition[operators[0]];
  const operandOk = operand === undefined || !isRecord(operand) || (Object.keys(operand).length === 1 && typeof operand.$state === "string");
  if (!sourceOk || operators.length > 1 || extra.length > 0 || (condition.not !== undefined && condition.not !== true) || !operandOk) {
    fail(`has a condition ${JSON.stringify(condition).slice(0, 80)} that is not one of json-render's: one of $state, $item or $index, at most one of ${OPERATORS.join(", ")}, and "not": true.`, ...path);
  }
}
