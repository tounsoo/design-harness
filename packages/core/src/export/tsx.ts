import type { ProjectConfig, PropSchema } from "../config/types";
import { PAGE_KIT } from "../extract/evaluator";
import type { Prototype } from "../prototype/types";
import { LAYOUT_TYPE, SCENARIO_STATE, TEXT_PROP, type CatalogComponent, type SpecCatalog } from "../spec/catalog";
import { isRecord, type JsonValue } from "../spec/json";
import { LAYOUT_ID_PROP, TEMPLATE_PARAM, type LayoutParam, type LayoutParams, type ListItem } from "../spec/params";
import { isExpression, keysOf, readSpecs, type ChildRef, type SpecDoc, type SpecElement } from "../spec/read";
import { camel, fresh, isIdentifier, pascal, singular } from "./names";

/**
 * A spec prototype as React: the TSX a person would write for the same
 * pages, one file per page and per layout, which core reads back as a TSX
 * prototype with the same manifest. It is written from what core read of
 * the specs, so an element the catalog refused is not in it, and every
 * value is written where the spec says it:
 *
 * - a page's state becomes data: a constant for what nothing changes, and
 *   `useState` for what a bound prop or an action writes;
 * - `/scenario/state` and `/scenario/id` are the page's `state` and
 *   `scenario` props (PageProps), as for any TSX page;
 * - a layout becomes a component whose props are its parameters: a binding
 *   is a value and its `on<Name>Change` callback, a slot is a ReactNode;
 *   what a layout reads of its page's state is a prop too;
 * - `visible` is `&&`, `$cond` is `?:`, `repeat` is `.map`, `$template` is
 *   text and expressions, `$scopedId` is `useId()`, and setState, pushState
 *   and removeState are the state's setter in an `onClick`;
 * - a parameter a layout reads in a condition or a template is its prop
 *   there too: `{ "$param": "tone", "eq": "quiet" }` is `tone === "quiet"`,
 *   and `${$param:verb}` is `{verb}`.
 *
 * Pure: the same prototype and config give the same files.
 */

export type TsxExport = {
  /** The TSX prototype: the same manifest, each spec file as a `.tsx` file. */
  readonly prototype: Prototype;
  /** What the export could not carry over, in words, for the project's README. */
  readonly notes: readonly string[];
};

type StateRef = { readonly value: string; readonly setter?: string };

/** What a layout needs from where it is drawn beyond its parameters: page state it reads or writes, and the scenario. */
type Needs = { readonly state: Map<string, { write: boolean }>; readonly scenario: Set<"state" | "id">; anyBindItem: boolean };

type LayoutInfo = {
  readonly id: string;
  readonly doc: SpecDoc;
  readonly component: string;
  readonly file: string;
  readonly needs: Needs;
  /** Parameter name → prop name; a binding's callback is `callbacks`. */
  readonly props: Map<string, string>;
  readonly callbacks: Map<string, string>;
  /** State key → the props carrying it. */
  readonly stateProps: Map<string, { value: string; setter?: string }>;
  readonly scenarioProps: { state?: string; id?: string };
};

type Item = { readonly name: string; readonly index: string; readonly key?: string; readonly list: string | null };

type FileContext = {
  readonly kind: "page" | "layout";
  readonly doc: SpecDoc;
  readonly file: string;
  readonly layout?: LayoutInfo;
  readonly taken: Set<string>;
  readonly react: Set<string>;
  readonly reactTypes: Set<string>;
  readonly kit: Set<string>;
  readonly library: Set<string>;
  readonly layouts: Map<string, string>;
  readonly state: Map<string, StateRef>;
  readonly scenario: { state?: string; id?: string };
  readonly scoped: Map<string, string>;
  readonly next: string;
};

const INDENT = "  ";
const OPERATORS: Readonly<Record<string, string>> = { eq: "===", neq: "!==", gt: ">", gte: ">=", lt: "<", lte: "<=" };

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const unescape = (segment: string) => segment.replace(/~1/g, "/").replace(/~0/g, "~");
const segments = (path: string) => (path === "/" || path === "" ? [] : path.replace(/^\//, "").split("/").map(unescape));

function access(segment: string): string {
  if (/^\d+$/.test(segment)) return `[${segment}]`;
  return isIdentifier(segment) ? `.${segment}` : `[${JSON.stringify(segment)}]`;
}

/** A JSON value as a JavaScript literal, on one line. */
function literal(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(literal).join(", ")}]`;
  if (isRecord(value)) {
    const entries = Object.keys(value).map((key) => `${isIdentifier(key) ? key : JSON.stringify(key)}: ${literal(value[key] as JsonValue)}`);
    return entries.length === 0 ? "{}" : `{ ${entries.join(", ")} }`;
  }
  return JSON.stringify(value);
}

/** A JSON value as a literal, broken over lines when it is long. */
function block(value: JsonValue, indent: string): string {
  const one = literal(value);
  if (one.length + indent.length <= 100) return one;
  const inner = indent + INDENT;
  if (Array.isArray(value)) return `[\n${value.map((item) => `${inner}${block(item, inner)},`).join("\n")}\n${indent}]`;
  if (isRecord(value)) return `{\n${Object.keys(value).map((key) => `${inner}${isIdentifier(key) ? key : JSON.stringify(key)}: ${block(value[key] as JsonValue, inner)},`).join("\n")}\n${indent}}`;
  return one;
}

/** The TypeScript type of a JSON value, for a prop that carries page state. */
function jsonType(value: JsonValue | undefined): string {
  if (value === undefined || value === null) return "unknown";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (Array.isArray(value)) return value.length === 0 ? "readonly unknown[]" : `readonly ${wrapUnion(jsonType(value[0]))}[]`;
  if (!isRecord(value)) return "unknown";
  return `{ ${Object.keys(value).map((key) => `readonly ${isIdentifier(key) ? key : JSON.stringify(key)}: ${jsonType(value[key])}`).join("; ")} }`;
}

const wrapUnion = (type: string) => (type.includes("|") ? `(${type})` : type);

function itemType(item: ListItem): string {
  if (item === "option") return "{ readonly value: string; readonly label: string }";
  if (typeof item === "string") return item === "text" ? "string" : item;
  return `{ ${Object.keys(item.record).map((field) => `readonly ${isIdentifier(field) ? field : JSON.stringify(field)}: ${item.record[field] === "text" ? "string" : item.record[field]}`).join("; ")} }`;
}

function schemaType(schema: PropSchema | undefined): string {
  if (!schema) return "string";
  if (schema.type === "enum") return schema.values.map((value) => JSON.stringify(value)).join(" | ");
  if (schema.type === "options") return "readonly { readonly value: string; readonly label: string }[]";
  return schema.type;
}

function paramType(param: LayoutParam): string {
  switch (param.type) {
    case "text":
      return "string";
    case "number":
    case "boolean":
      return param.type;
    case "enum":
      return param.values.map((value) => JSON.stringify(value)).join(" | ");
    case "list":
      return `readonly ${wrapUnion(itemType(param.of))}[]`;
    case "slot":
      return "ReactNode";
    case "binding":
      return "string";
  }
}

/** A text that can be written as JSX text as it is: no braces, angle brackets, entities, line breaks or space at either end. */
function plainText(text: string): boolean {
  return text.length > 0 && !/[{}<>&\n\r]/.test(text) && text.trim() === text;
}

/** A string as a JSX attribute: `name="text"` when it can be, `name={"text"}` otherwise. */
function stringAttribute(name: string, text: string): string {
  return /["&\\\n\r]/.test(text) ? `${name}={${JSON.stringify(text)}}` : `${name}="${text}"`;
}

/** A piece of a template: text, or an expression; `absent` when it may be undefined, which a template shows as "" and a template literal as "undefined". */
type TemplatePart = { readonly text: string } | { readonly expr: string; readonly absent?: true };

function templateLiteral(parts: readonly TemplatePart[]): string {
  return `\`${parts.map((part) => ("expr" in part ? `\${${part.absent ? `${part.expr} ?? ""` : part.expr}}` : part.text.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${"))).join("")}\``;
}

/** Every value under an element that a walk should read: its props, condition, repeat and actions. */
function valuesOf(element: SpecElement): JsonValue[] {
  const repeat = element.repeat && "statePath" in element.repeat && typeof element.repeat.statePath === "string" ? [{ $state: element.repeat.statePath } as JsonValue] : [];
  const actions = Object.values(element.on ?? {}).flatMap((bindings) => bindings.map((binding) => binding.params as JsonValue));
  return [element.props as JsonValue, ...(element.visible === undefined ? [] : [element.visible]), ...repeat, ...actions];
}

class TsxWriter {
  readonly notes: string[] = [];
  private readonly layoutInfo = new Map<string, LayoutInfo>();
  private readonly needsOf = new Map<string, Needs>();

  constructor(
    private readonly prototype: Prototype,
    private readonly catalog: SpecCatalog,
    private readonly docs: ReadonlyMap<string, SpecDoc>,
    private readonly params: ReadonlyMap<string, LayoutParams>,
    private readonly names: ReadonlyMap<string, string>,
  ) {}

  outputFile(file: string): string {
    return file.replace(/\.json$/, "") + ".tsx";
  }

  // ---- what each file reads and writes ---------------------------------------

  /** The parents of a doc's elements, to tell whether one is inside a repeat. */
  private inRepeat(doc: SpecDoc): Set<string> {
    const parent = new Map<string, string>();
    for (const element of doc.elements.values()) for (const child of [...keysOf(element.children), ...Object.values(element.slots ?? {}).flatMap(keysOf)]) parent.set(child, element.key);
    const inside = new Set<string>();
    for (const key of doc.elements.keys()) {
      for (let up = parent.get(key); up !== undefined; up = parent.get(up)) {
        if (doc.elements.get(up)?.repeat) {
          inside.add(key);
          break;
        }
      }
    }
    return inside;
  }

  /** What a doc's own elements read and write of the page's state and scenario; Layout instances' needs are added by `needs`. */
  private ownNeeds(doc: SpecDoc): Needs {
    const needs: Needs = { state: new Map(), scenario: new Set(), anyBindItem: false };
    const repeated = this.inRepeat(doc);
    const use = (path: string, write: boolean) => {
      const [top] = segments(path);
      if (top === undefined) return;
      if (top === SCENARIO_STATE) {
        const [, which] = segments(path);
        if (which === "state" || which === "id") needs.scenario.add(which);
        return;
      }
      const seen = needs.state.get(top);
      needs.state.set(top, { write: (seen?.write ?? false) || write });
    };
    const walk = (value: JsonValue | undefined, item: boolean) => {
      if (Array.isArray(value)) value.forEach((inner) => walk(inner, item));
      else if (isRecord(value)) {
        if (typeof value.$state === "string") use(value.$state, false);
        if (typeof value.$bindState === "string") use(value.$bindState, true);
        if (typeof value.statePath === "string") use(value.statePath, false);
        if (typeof value.$bindItem === "string") needs.anyBindItem = true;
        if (typeof value.$template === "string") {
          for (const match of value.$template.matchAll(/\$\{([^}]*)\}/g)) {
            const ref = match[1] ?? "";
            // A layout's parameter (`${$param:name}`) is a prop, not page state.
            if (ref.startsWith("$")) continue;
            if (ref.startsWith("/")) use(ref, false);
            else if (!item) use(`/${ref}`, false);
          }
        }
        for (const inner of Object.values(value)) walk(inner, item);
      }
    };
    for (const element of doc.elements.values()) {
      if (element.type === LAYOUT_TYPE) {
        // A Layout element's own values are given to its parameters; what they read is read here.
        walk(element.props as JsonValue, repeated.has(element.key));
        if (element.visible !== undefined) walk(element.visible, repeated.has(element.key));
        continue;
      }
      for (const value of valuesOf(element)) walk(value, repeated.has(element.key));
      for (const bindings of Object.values(element.on ?? {})) for (const binding of bindings) if (typeof binding.params.statePath === "string") use(binding.params.statePath, true);
    }
    return needs;
  }

  /** What a layout needs from where it is drawn, its nested layouts' needs included. */
  needs(id: string, chain: readonly string[] = []): Needs {
    const known = this.needsOf.get(id);
    if (known) return known;
    const entry = this.prototype.layouts.find((layout) => layout.id === id);
    const doc = entry ? this.docs.get(entry.component.file) : undefined;
    if (!doc || chain.includes(id)) return { state: new Map(), scenario: new Set(), anyBindItem: false };
    const needs = this.ownNeeds(doc);
    for (const inner of this.instancesIn(doc)) {
      const more = this.needs(inner, [...chain, id]);
      for (const [key, use] of more.state) needs.state.set(key, { write: (needs.state.get(key)?.write ?? false) || use.write });
      for (const which of more.scenario) needs.scenario.add(which);
      needs.anyBindItem ||= more.anyBindItem;
    }
    if (chain.length === 0) this.needsOf.set(id, needs);
    return needs;
  }

  private instancesIn(doc: SpecDoc): string[] {
    return [...doc.elements.values()].flatMap((element) => (element.type === LAYOUT_TYPE && typeof element.props[LAYOUT_ID_PROP] === "string" ? [element.props[LAYOUT_ID_PROP] as string] : []));
  }

  layout(id: string): LayoutInfo | undefined {
    const known = this.layoutInfo.get(id);
    if (known) return known;
    const entry = this.prototype.layouts.find((layout) => layout.id === id);
    const doc = entry ? this.docs.get(entry.component.file) : undefined;
    if (!entry || !doc) return undefined;
    const taken = new Set<string>(["key", "children"]);
    const params = this.params.get(id) ?? {};
    const props = new Map<string, string>();
    const callbacks = new Map<string, string>();
    for (const name of Object.keys(params).sort(compare)) props.set(name, fresh(camel(name), taken));
    for (const name of Object.keys(params).sort(compare)) if (params[name]?.type === "binding") callbacks.set(name, fresh(`on${pascal(name)}Change`, taken));
    const needs = this.needs(id);
    const stateProps = new Map<string, { value: string; setter?: string }>();
    for (const key of [...needs.state.keys()].sort(compare)) {
      const value = fresh(camel(key), taken);
      stateProps.set(key, { value, ...(needs.state.get(key)?.write ? { setter: fresh(`on${pascal(key)}Change`, taken) } : {}) });
    }
    const scenarioProps = { ...(needs.scenario.has("state") ? { state: fresh("state", taken) } : {}), ...(needs.scenario.has("id") ? { id: fresh("scenario", taken) } : {}) };
    const info: LayoutInfo = { id, doc, component: this.names.get(entry.component.file) ?? pascal(id), file: this.outputFile(entry.component.file), needs, props, callbacks, stateProps, scenarioProps };
    this.layoutInfo.set(id, info);
    return info;
  }

  // ---- values ----------------------------------------------------------------

  private readPath(ctx: FileContext, path: string): string {
    const parts = segments(path);
    const [top] = parts;
    if (top === undefined) return "undefined";
    if (top === SCENARIO_STATE) {
      if (parts[1] === "state" && ctx.scenario.state) return ctx.scenario.state + parts.slice(2).map(access).join("");
      if (parts[1] === "id" && ctx.scenario.id) return ctx.scenario.id + parts.slice(2).map(access).join("");
      return "undefined";
    }
    const ref = ctx.state.get(top);
    return ref ? ref.value + parts.slice(1).map(access).join("") : "undefined";
  }

  private readItem(items: readonly Item[], field: string): string {
    const item = items.at(-1);
    if (!item) return "undefined";
    return item.name + segments(field === "" ? "" : `/${field}`).map(access).join("");
  }

  /** The statement that writes `valueExpr` at a state path, through its setter; null when nothing can write it here. */
  private write(ctx: FileContext, path: string, valueExpr: string): string | null {
    const parts = segments(path);
    const [top] = parts;
    const ref = top === undefined ? undefined : ctx.state.get(top);
    if (!ref?.setter) return null;
    const nested = (base: string, rest: readonly string[], depth: number): string => {
      const [segment, ...more] = rest;
      if (segment === undefined) return valueExpr;
      if (/^\d+$/.test(segment)) {
        const entry = depth === 0 ? "entry" : `entry${depth + 1}`;
        const at = depth === 0 ? "at" : `at${depth + 1}`;
        return `${base}.map((${entry}, ${at}) => (${at} === ${segment} ? ${nested(entry, more, depth + 1)} : ${entry}))`;
      }
      return `{ ...${base}, ${isIdentifier(segment) ? segment : JSON.stringify(segment)}: ${nested(base + access(segment), more, depth + 1)} }`;
    };
    return `${ref.setter}(${nested(ref.value, parts.slice(1), 0)})`;
  }

  /** A spec value as a JavaScript expression. */
  expr(ctx: FileContext, value: JsonValue | undefined, items: readonly Item[]): string {
    if (value === undefined) return "undefined";
    if (!isExpression(value)) return literal(value);
    if (typeof value.$state === "string") return this.readPath(ctx, value.$state);
    if (typeof value.$bindState === "string") return this.readPath(ctx, value.$bindState);
    if (typeof value.$item === "string") return this.readItem(items, value.$item);
    if (typeof value.$bindItem === "string") return this.readItem(items, value.$bindItem);
    if (value.$index === true) return items.at(-1)?.index ?? "0";
    if (typeof value.$param === "string") return ctx.layout?.props.get(value.$param) ?? "undefined";
    if (typeof value.$scopedId === "string") return this.scopedId(ctx, value.$scopedId, items);
    if (typeof value.$template === "string") return templateLiteral(this.templateParts(ctx, value.$template, items));
    if ("$cond" in value) return `${group(this.condition(ctx, value.$cond as JsonValue, items, false), "?")} ? ${this.expr(ctx, value.$then, items)} : ${this.expr(ctx, value.$else, items)}`;
    return "undefined";
  }

  private scopedId(ctx: FileContext, name: string, items: readonly Item[]): string {
    if (ctx.kind === "page") return JSON.stringify(name);
    let id = ctx.scoped.get(name);
    if (!id) {
      id = fresh(camel(`${name}-id`), ctx.taken);
      ctx.scoped.set(name, id);
      ctx.react.add("useId");
    }
    const keyed = items.length === 1 && items[0]?.key !== undefined ? items[0] : undefined;
    return keyed ? templateLiteral([{ expr: id }, { text: "-" }, { expr: `${keyed.name}${access(keyed.key as string)}` }]) : id;
  }

  private templateParts(ctx: FileContext, template: string, items: readonly Item[]): TemplatePart[] {
    const parts: TemplatePart[] = [];
    let rest = template;
    for (let match = /\$\{([^}]*)\}/.exec(rest); match; match = /\$\{([^}]*)\}/.exec(rest)) {
      if (match.index > 0) parts.push({ text: rest.slice(0, match.index) });
      const ref = match[1] ?? "";
      parts.push(ref.startsWith(TEMPLATE_PARAM) ? this.paramPart(ctx, ref.slice(TEMPLATE_PARAM.length)) : { expr: ref.startsWith("/") ? this.readPath(ctx, ref) : items.length > 0 ? this.readItem(items, ref) : this.readPath(ctx, `/${ref}`) });
      rest = rest.slice(match.index + match[0].length);
    }
    if (rest.length > 0) parts.push({ text: rest });
    return parts;
  }

  /** A layout's parameter as a template puts it in: its prop, which may be absent when it is optional with no default. */
  private paramPart(ctx: FileContext, name: string): TemplatePart {
    const prop = ctx.layout?.props.get(name);
    if (prop === undefined) return { text: "" };
    const param = ctx.layout ? this.params.get(ctx.layout.id)?.[name] : undefined;
    return param && !param.required && !("default" in param && param.default !== undefined) ? { expr: prop, absent: true } : { expr: prop };
  }

  /** A layout's parameter read in a condition: its prop. */
  private paramRef(ctx: FileContext, name: string): string {
    return ctx.layout?.props.get(name) ?? "undefined";
  }

  /**
   * A visibility condition as an expression. `boolean` makes a bare value
   * a boolean (`!!x`), as JSX's `&&` needs, so a 0 never renders; a
   * ternary's test needs no such thing.
   */
  condition(ctx: FileContext, condition: JsonValue, items: readonly Item[], boolean = true): string {
    if (typeof condition === "boolean") return String(condition);
    const join = (list: readonly JsonValue[], operator: "&&" | "||") =>
      list.length === 1 ? this.condition(ctx, list[0] as JsonValue, items, boolean) : list.map((item) => group(this.condition(ctx, item, items, true), operator)).join(` ${operator} `);
    if (Array.isArray(condition)) return join(condition, "&&");
    if (!isRecord(condition)) return "false";
    if (Array.isArray(condition.$and)) return join(condition.$and, "&&");
    if (Array.isArray(condition.$or)) return join(condition.$or, "||");
    const source = typeof condition.$state === "string" ? this.readPath(ctx, condition.$state) : typeof condition.$item === "string" ? this.readItem(items, condition.$item) : condition.$index === true ? (items.at(-1)?.index ?? "0") : typeof condition.$param === "string" ? this.paramRef(ctx, condition.$param) : "undefined";
    const operator = Object.keys(OPERATORS).find((name) => name in condition);
    const negate = condition.not === true;
    // A boolean parameter is already true or false (or absent, which renders nothing), so it needs no `!!`.
    const bool = typeof condition.$param === "string" && ctx.layout !== undefined && this.params.get(ctx.layout.id)?.[condition.$param]?.type === "boolean";
    if (!operator) return negate ? `!${source}` : boolean && !bool ? `!!${source}` : source;
    const operand = condition[operator] as JsonValue;
    const right = isRecord(operand) && typeof operand.$state === "string" ? this.readPath(ctx, operand.$state) : isRecord(operand) && typeof operand.$param === "string" ? this.paramRef(ctx, operand.$param) : literal(operand);
    const test = `${source} ${OPERATORS[operator]} ${right}`;
    return negate ? `!(${test})` : test;
  }

  // ---- JSX -------------------------------------------------------------------

  /** JSX children for a text value: plain text where it can be, expressions in braces otherwise. */
  private textChildren(ctx: FileContext, value: JsonValue | undefined, items: readonly Item[], inline: boolean): string {
    if (value === undefined || value === null) return "";
    // Text on the line of its tags keeps its spaces; on a line of its own, JSX trims them.
    const plain = (text: string, inner: boolean) => (inline || inner ? text.trim() !== "" && plainText(text.trim()) : plainText(text));
    if (typeof value === "string") return plain(value, false) ? value : `{${JSON.stringify(value)}}`;
    if (typeof value === "number" || typeof value === "boolean") return `{${String(value)}}`;
    if (isRecord(value) && typeof value.$template === "string") {
      const parts = this.templateParts(ctx, value.$template, items);
      // Text between two expressions keeps its spaces on one line; at either end it would be trimmed, so it is written as a string there.
      return parts
        .map((part, index) => {
          if ("expr" in part) return `{${part.expr}}`;
          return plain(part.text, index > 0 && index < parts.length - 1) ? part.text : `{${JSON.stringify(part.text)}}`;
        })
        .join("");
    }
    return `{${this.expr(ctx, value, items)}}`;
  }

  /** One prop as a JSX attribute. */
  private attribute(ctx: FileContext, name: string, value: JsonValue, items: readonly Item[]): string {
    if (typeof value === "string") return stringAttribute(name, value);
    if (value === true) return name;
    return `${name}={${this.expr(ctx, value, items)}}`;
  }

  /** A callback that writes a bound value, or null when nothing can write it here. */
  private binder(ctx: FileContext, value: { readonly [key: string]: JsonValue }, items: readonly Item[]): string | null {
    if (typeof value.$bindState === "string") {
      const parts = segments(value.$bindState);
      const ref = parts[0] === undefined ? undefined : ctx.state.get(parts[0]);
      if (parts.length === 1 && ref?.setter) return ref.setter;
      const statement = this.write(ctx, value.$bindState, ctx.next);
      return statement ? `(${ctx.next}) => ${statement}` : null;
    }
    if (typeof value.$bindItem === "string") {
      const item = items.at(-1);
      if (!item?.list) return null;
      const field = segments(`/${value.$bindItem}`);
      if (field.length !== 1) return null;
      const statement = this.write(ctx, item.list, `${this.readPath(ctx, item.list)}.map((entry, at) => (at === ${item.index} ? { ...entry, ${isIdentifier(field[0] as string) ? field[0] : JSON.stringify(field[0])}: ${ctx.next} } : entry))`);
      return statement ? `(${ctx.next}) => ${statement}` : null;
    }
    return null;
  }

  private actions(ctx: FileContext, element: SpecElement, items: readonly Item[]): string | null {
    const bindings = element.on?.press ?? [];
    const statements: string[] = [];
    for (const binding of bindings) {
      const path = typeof binding.params.statePath === "string" ? binding.params.statePath : "";
      const current = this.readPath(ctx, path);
      const value = this.expr(ctx, binding.params.value, items);
      const next = binding.action === "setState" ? value : binding.action === "pushState" ? `[...${current}, ${value}]` : `${current}.filter((_, at) => at !== ${this.expr(ctx, binding.params.index, items)})`;
      const statement = this.write(ctx, path, next);
      if (statement) statements.push(statement);
    }
    if (statements.length === 0) return null;
    return statements.length === 1 ? `() => ${statements[0]}` : `() => { ${statements.join("; ")}; }`;
  }

  /** An element as JSX lines, with `extra` attributes first (a repeat's key). Wrapped in its condition when it has one, as a child expression. */
  element(ctx: FileContext, key: string, items: readonly Item[], extra: readonly string[] = [], withCondition = true): string[] {
    const element = ctx.doc.elements.get(key);
    if (!element) return [];
    const lines = element.type === LAYOUT_TYPE ? this.instance(ctx, element, items, extra) : this.part(ctx, element, items, extra);
    if (!withCondition || element.visible === undefined || element.visible === true) return lines;
    const test = group(this.condition(ctx, element.visible, items), "&&");
    if (lines.length === 1) return [`{${test} && ${lines[0]}}`];
    return [`{${test} && (`, ...lines.map((line) => INDENT + line), ")}"];
  }

  /** Children of an element: its elements, a layout's slot parameters where it places them, and a repeat's items. */
  private children(ctx: FileContext, element: SpecElement, list: readonly ChildRef[], items: readonly Item[]): string[] {
    const render = (inner: readonly Item[], extra: readonly string[] = []) =>
      list.flatMap((child) => (typeof child === "string" ? this.element(ctx, child, inner, extra) : [`{${ctx.layout?.props.get(child.param) ?? "undefined"}}`]));
    const repeat = element.repeat;
    if (!repeat) return render(items);
    let listExpr: string;
    let listPath: string | null = null;
    let base: string;
    if ("param" in repeat) {
      listExpr = ctx.layout?.props.get(repeat.param) ?? "[]";
      base = repeat.param;
    } else if (typeof repeat.statePath === "string") {
      listExpr = this.readPath(ctx, repeat.statePath);
      listPath = repeat.statePath;
      base = segments(repeat.statePath).at(-1) ?? "items";
    } else {
      listExpr = this.readItem(items, repeat.statePath.$item);
      base = segments(`/${repeat.statePath.$item}`).at(-1) ?? "items";
    }
    const name = fresh(singular(base), ctx.taken);
    const index = fresh(items.length === 0 ? "index" : `index${items.length + 1}`, ctx.taken);
    const item: Item = { name, index, list: listPath, ...(repeat.key !== undefined ? { key: repeat.key } : {}) };
    const inner = [...items, item];
    const keyExpr = repeat.key !== undefined ? `${name}${access(repeat.key)}` : index;
    const childKeys = list.filter((child): child is string => typeof child === "string");
    let body: string[];
    if (childKeys.length === 1 && list.length === 1) body = this.element(ctx, childKeys[0] as string, inner, [`key={${keyExpr}}`]);
    else {
      ctx.react.add("Fragment");
      body = [`<Fragment key={${keyExpr}}>`, ...render(inner).map((line) => INDENT + line), "</Fragment>"];
    }
    const usesIndex = body.some((line) => new RegExp(`\\b${index}\\b`).test(line)) || repeat.key === undefined;
    const params = usesIndex ? `(${name}, ${index})` : `(${name})`;
    if (body.length === 1) return [`{${listExpr}.map(${params} => ${(body[0] as string).replace(/^\{(.*)\}$/, "$1")})}`];
    const unwrapped = body[0]?.startsWith("{") ? [(body[0] as string).slice(1), ...body.slice(1, -1), (body.at(-1) as string).slice(0, -1)] : body;
    return [`{${listExpr}.map(${params} => (`, ...unwrapped.map((line) => INDENT + line), "))}"];
  }

  /** A library part. */
  private part(ctx: FileContext, element: SpecElement, items: readonly Item[], extra: readonly string[]): string[] {
    const component = this.catalog.components[element.type] as CatalogComponent;
    ctx.library.add(element.type.split(".")[0] as string);
    const attributes = [...extra];
    for (const name of Object.keys(element.props).sort(compare)) {
      if (name === TEXT_PROP || (component.content === "options" && name === "options")) continue;
      const value = element.props[name] as JsonValue;
      const schema = component.props[name];
      const bind = schema && "bind" in schema ? schema.bind : undefined;
      if (isRecord(value) && typeof value.$param === "string" && ctx.layout && this.params.get(ctx.layout.id)?.[value.$param]?.type === "binding") {
        attributes.push(`${name}={${ctx.layout.props.get(value.$param)}}`);
        if (bind) attributes.push(`${bind}={${ctx.layout.callbacks.get(value.$param)}}`);
        continue;
      }
      attributes.push(this.attribute(ctx, name, value, items));
      if (bind && isRecord(value)) {
        const callback = this.binder(ctx, value, items);
        if (callback) attributes.push(`${bind}={${callback}}`);
      }
    }
    const press = this.actions(ctx, element, items);
    if (press) attributes.push(`onClick={${press}}`);
    const body: string[] = [];
    if (component.content === "options" && element.props.options !== undefined) body.push(...this.options(ctx, element.props.options, items));
    body.push(...this.children(ctx, element, element.children, items));
    const text = this.textChildren(ctx, element.props[TEXT_PROP], items, body.length === 0);
    return this.tag(element.type, attributes, text, body);
  }

  private options(ctx: FileContext, value: JsonValue, items: readonly Item[]): string[] {
    if (Array.isArray(value)) return value.map((option) => (isRecord(option) ? `<option value=${JSON.stringify(String(option.value))}>${plainText(String(option.label)) ? String(option.label) : `{${JSON.stringify(String(option.label))}}`}</option>` : ""));
    const from = isRecord(value) ? (typeof value.$param === "string" ? value.$param : typeof value.$state === "string" ? segments(value.$state).at(-1) : undefined) : undefined;
    const name = fresh(from ? singular(from) : "option", ctx.taken);
    return [`{${this.expr(ctx, value, items)}.map((${name}) => (`, `${INDENT}<option key={${name}.value} value={${name}.value}>`, `${INDENT}${INDENT}{${name}.label}`, `${INDENT}</option>`, "))}"];
  }

  /** A Layout instance: the layout's component, with its parameters as props. */
  private instance(ctx: FileContext, element: SpecElement, items: readonly Item[], extra: readonly string[]): string[] {
    const id = element.props[LAYOUT_ID_PROP] as string;
    const info = this.layout(id);
    if (!info) return [];
    if (info.id !== ctx.layout?.id) ctx.layouts.set(info.component, info.file);
    const params = this.params.get(id) ?? {};
    const attributes = [...extra];
    const slotProps: string[] = [];
    for (const name of Object.keys(params).sort(compare)) {
      const param = params[name] as LayoutParam;
      const prop = info.props.get(name) as string;
      if (param.type === "slot") {
        const keys = keysOf(element.slots?.[name] ?? []);
        const passed = (element.slots?.[name] ?? []).filter((child) => typeof child !== "string");
        const lines = [...keys.flatMap((key) => this.element(ctx, key, items)), ...passed.map((child) => `{${ctx.layout?.props.get((child as { param: string }).param) ?? "undefined"}}`)];
        if (lines.length === 0) continue;
        const single = keys.length === 1 && passed.length === 0 && !(lines[0] as string).startsWith("{");
        slotProps.push(...(single && lines.length === 1 ? [`${prop}={${lines[0]}}`] : single ? [`${prop}={`, ...lines.map((line) => INDENT + line), "}"] : [`${prop}={`, `${INDENT}<>`, ...lines.map((line) => INDENT + INDENT + line), `${INDENT}</>`, "}"]));
        continue;
      }
      const value = element.props[name];
      if (value === undefined) continue;
      if (param.type === "binding") {
        const callback = info.callbacks.get(name) as string;
        if (isRecord(value) && typeof value.$param === "string" && ctx.layout) {
          attributes.push(`${prop}={${ctx.layout.props.get(value.$param)}}`, `${callback}={${ctx.layout.callbacks.get(value.$param)}}`);
          continue;
        }
        attributes.push(`${prop}={${this.expr(ctx, value, items)}}`);
        const binder = isRecord(value) ? this.binder(ctx, value, items) : null;
        if (binder) attributes.push(`${callback}={${binder}}`);
        continue;
      }
      attributes.push(this.attribute(ctx, prop, value, items));
    }
    for (const [key, carried] of [...info.stateProps.entries()].sort(([a], [b]) => compare(a, b))) {
      const ref = ctx.state.get(key);
      attributes.push(`${carried.value}={${ref?.value ?? "undefined"}}`);
      if (carried.setter && ref?.setter) attributes.push(`${carried.setter}={${ref.setter}}`);
    }
    if (info.scenarioProps.state) attributes.push(`${info.scenarioProps.state}={${ctx.scenario.state ?? "undefined"}}`);
    if (info.scenarioProps.id) attributes.push(`${info.scenarioProps.id}={${ctx.scenario.id ?? "undefined"}}`);
    const component = info.id === ctx.layout?.id ? ctx.layout.component : info.component;
    if (slotProps.length === 0) return this.tag(component, attributes, "", []);
    return [`<${component}${attributes.length > 0 ? ` ${attributes.join(" ")}` : ""}`, ...slotProps.map((line) => INDENT + line), "/>"];
  }

  /** An element's tag: self-closing when it holds nothing, on one line when it holds only text. */
  private tag(name: string, attributes: readonly string[], text: string, body: readonly string[]): string[] {
    const open = attributes.length > 0 ? `<${name} ${attributes.join(" ")}` : `<${name}`;
    const long = open.length > 100 && attributes.length > 1;
    const head = long ? [`<${name}`, ...attributes.map((attribute) => INDENT + attribute)] : [open];
    if (text === "" && body.length === 0) return long ? [...head, "/>"] : [`${open} />`];
    // Text alone stays on the line of its tags, where JSX keeps its spaces.
    if (body.length === 0) return long ? [...head.slice(0, -1), `${head.at(-1)}>${text}</${name}>`] : [`${open}>${text}</${name}>`];
    return [...head.slice(0, -1), `${head.at(-1)}>`, ...(text ? [INDENT + text] : []), ...body.map((line) => INDENT + line), `</${name}>`];
  }

  /** The type of what a page's actions push onto an empty list at a top-level key, for its useState. */
  private pushedType(doc: SpecDoc, key: string): string {
    for (const element of doc.elements.values()) {
      for (const binding of element.on?.press ?? []) {
        if (binding.action === "pushState" && binding.params.statePath === `/${key}` && binding.params.value !== undefined && !isExpression(binding.params.value)) return jsonType(binding.params.value);
      }
    }
    return "unknown";
  }

  // ---- files -----------------------------------------------------------------

  context(kind: "page" | "layout", doc: SpecDoc, layout?: LayoutInfo): FileContext {
    const taken = new Set<string>([...this.names.values(), ...(layout ? [...layout.props.values(), ...layout.callbacks.values(), ...[...layout.stateProps.values()].flatMap((prop) => [prop.value, ...(prop.setter ? [prop.setter] : [])])] : [])]);
    const ctx: FileContext = { kind, doc, file: this.outputFile(doc.file), ...(layout ? { layout } : {}), taken, react: new Set(), reactTypes: new Set(), kit: new Set(), library: new Set(), layouts: new Map(), state: new Map(), scenario: {}, scoped: new Map(), next: fresh("next", taken) };
    if (layout) {
      for (const [key, prop] of layout.stateProps) ctx.state.set(key, prop);
      Object.assign(ctx.scenario, layout.scenarioProps.state ? { state: layout.scenarioProps.state } : {}, layout.scenarioProps.id ? { id: layout.scenarioProps.id } : {});
    }
    return ctx;
  }

  /** Elements a file holds that nothing lists: kept, as JSX nothing renders, so the export checks as the spec does. */
  private orphans(ctx: FileContext): string[] {
    const listed = new Set<string>([ctx.doc.root]);
    for (const element of ctx.doc.elements.values()) for (const child of [...keysOf(element.children), ...Object.values(element.slots ?? {}).flatMap(keysOf)]) listed.add(child);
    const lines: string[] = [];
    for (const key of [...ctx.doc.elements.keys()].sort(compare)) {
      if (listed.has(key)) continue;
      const name = fresh(camel(`not-drawn-${key}`), ctx.taken);
      const jsx = this.element(ctx, key, [], [], false);
      if (jsx.length === 0) continue;
      this.notes.push(`${ctx.doc.file}: element "${key}" is in the spec but nothing draws it; ${ctx.file} keeps it as \`${name}\`, which nothing renders.`);
      lines.push(...(jsx.length === 1 ? [`const ${name} = ${jsx[0]};`] : [`const ${name} = (`, ...jsx.map((line) => INDENT + line), ");"]));
    }
    return lines;
  }

  private imports(ctx: FileContext, library: string): string[] {
    const lines: string[] = [];
    const react = [...ctx.react].sort(compare);
    const types = [...ctx.reactTypes].sort(compare).map((name) => `type ${name}`);
    if (react.length > 0 || types.length > 0) lines.push(`import { ${[...react, ...types].join(", ")} } from "react";`);
    if (ctx.kit.size > 0) lines.push(`import { ${[...ctx.kit].sort(compare).join(", ")} } from "${PAGE_KIT}";`);
    if (ctx.library.size > 0) lines.push(`import { ${[...ctx.library].sort(compare).join(", ")} } from "${library}";`);
    for (const [component, file] of [...ctx.layouts.entries()].sort(([a], [b]) => compare(a, b))) lines.push(`import ${component} from "${relative(ctx.file, file)}";`);
    return lines;
  }

  page(id: string, doc: SpecDoc, slotOrder: readonly string[], library: string): string {
    const component = this.names.get(doc.file) ?? pascal(`${id}-page`);
    const ctx = this.context("page", doc);
    // What the page and every layout it draws read and write of its state.
    const needs = this.ownNeeds(doc);
    for (const inner of this.instancesIn(doc)) {
      const more = this.needs(inner);
      for (const [key, use] of more.state) needs.state.set(key, { write: (needs.state.get(key)?.write ?? false) || use.write });
      for (const which of more.scenario) needs.scenario.add(which);
      needs.anyBindItem ||= more.anyBindItem;
    }
    if (needs.scenario.has("id")) ctx.scenario.id = fresh("scenario", ctx.taken);
    if (needs.scenario.has("state")) ctx.scenario.state = fresh("state", ctx.taken);
    const data: string[] = [];
    const hooks: string[] = [];
    const stateOf = doc.state ?? {};
    for (const key of [...needs.state.keys()].sort(compare)) {
      const value = Object.hasOwn(stateOf, key) ? stateOf[key] : undefined;
      // A bound item field writes into its list, and core then reads every state path as one the page changes.
      const written = (needs.state.get(key)?.write ?? false) || needs.anyBindItem;
      const name = fresh(camel(key), ctx.taken);
      if (written) {
        const setter = fresh(`set${pascal(key)}`, ctx.taken);
        ctx.react.add("useState");
        const typed = value === undefined ? "<string | undefined>(undefined)" : Array.isArray(value) && value.length === 0 ? `<${wrapUnion(this.pushedType(doc, key))}[]>([])` : `(${block(value, INDENT)})`;
        hooks.push(`const [${name}, ${setter}] = useState${typed};`);
        ctx.state.set(key, { value: name, setter });
      } else {
        if (value !== undefined) data.push(`const ${name} = ${block(value, "")};`);
        ctx.state.set(key, { value: value === undefined ? "undefined" : name });
      }
    }
    const root = doc.elements.get(doc.root) as SpecElement;
    const rank = (slot: string) => (slotOrder.includes(slot) ? slotOrder.indexOf(slot) : slotOrder.length);
    const body: string[] = [];
    for (const slot of Object.keys(root.slots ?? {}).sort((a, b) => rank(a) - rank(b) || compare(a, b))) {
      ctx.kit.add("Slot");
      const inner = keysOf(root.slots?.[slot] ?? []).flatMap((key) => this.element(ctx, key, []));
      body.push(...(inner.length === 0 ? [`<Slot name=${JSON.stringify(slot)} />`] : [`<Slot name=${JSON.stringify(slot)}>`, ...inner.map((line) => INDENT + line), "</Slot>"]));
    }
    body.push(...keysOf(root.children).flatMap((key) => this.element(ctx, key, [])));
    const orphans = this.orphans(ctx);
    const props = [ctx.scenario.id ? (ctx.scenario.id === "scenario" ? "scenario" : `scenario: ${ctx.scenario.id}`) : null, ctx.scenario.state ? (ctx.scenario.state === "state" ? "state" : `state: ${ctx.scenario.state}`) : null].filter(Boolean);
    if (props.length > 0) ctx.kit.add("type PageProps");
    const signature = props.length > 0 ? `{ ${props.join(", ")} }: PageProps` : "";
    const lines = [
      ...this.imports(ctx, library),
      "",
      ...(data.length > 0 ? [...data.flatMap((line) => [line, ""])] : []),
      `/** The ${id} page, written from ${doc.file}. */`,
      `export default function ${component}(${signature}) {`,
      ...[...hooks, ...orphans].map((line) => indentLines(line, INDENT)),
      `${INDENT}return (`,
      `${INDENT}${INDENT}<>`,
      ...body.map((line) => INDENT.repeat(3) + line),
      `${INDENT}${INDENT}</>`,
      `${INDENT});`,
      "}",
    ];
    return `${lines.join("\n")}\n`;
  }

  layoutFile(info: LayoutInfo, library: string): string {
    const ctx = this.context("layout", info.doc, info);
    const params = this.params.get(info.id) ?? {};
    const body = this.element(ctx, info.doc.root, [], [], false);
    const rootElement = info.doc.elements.get(info.doc.root);
    const shown = rootElement?.visible === undefined || rootElement.visible === true ? null : group(this.condition(ctx, rootElement.visible, []), "?");
    const orphans = this.orphans(ctx);
    // The binding's value has the type of the prop it binds.
    const bindingType = (name: string): string => {
      for (const element of info.doc.elements.values()) {
        for (const [prop, value] of Object.entries(element.props)) {
          if (isRecord(value) && value.$param === name && element.type !== LAYOUT_TYPE) return schemaType(this.catalog.components[element.type]?.props[prop]);
        }
      }
      return "string";
    };
    const members: string[] = [];
    const destructured: string[] = [];
    for (const name of Object.keys(params).sort(compare)) {
      const param = params[name] as LayoutParam;
      const prop = info.props.get(name) as string;
      const type = param.type === "binding" ? bindingType(name) : paramType(param);
      if (param.type === "slot") ctx.reactTypes.add("ReactNode");
      if (param.description) members.push(`/** ${param.description.replace(/\*\//g, "* /")} */`);
      members.push(`readonly ${prop}${param.required ? "" : "?"}: ${type};`);
      const fallback = "default" in param && param.default !== undefined ? ` = ${literal(param.default)}` : "";
      destructured.push(`${prop}${fallback}`);
      if (param.type === "binding") {
        const callback = info.callbacks.get(name) as string;
        members.push(`/** Called with the new value when the person changes ${prop}. */`, `readonly ${callback}${param.required ? "" : "?"}: (value: ${type}) => void;`);
        destructured.push(callback);
      }
    }
    for (const [key, carried] of [...info.stateProps.entries()].sort(([a], [b]) => compare(a, b))) {
      const pageState = this.prototype.pages.map((page) => this.docs.get(page.component.file)?.state?.[key]).find((value) => value !== undefined);
      members.push(`/** The drawing page's state at /${key}. */`, `readonly ${carried.value}: ${jsonType(pageState)};`);
      destructured.push(carried.value);
      if (carried.setter) {
        members.push(`readonly ${carried.setter}: (value: ${jsonType(pageState)}) => void;`);
        destructured.push(carried.setter);
      }
    }
    if (info.scenarioProps.state) {
      members.push("/** The scenario's flow state. */", `readonly ${info.scenarioProps.state}: string;`);
      destructured.push(info.scenarioProps.state);
    }
    if (info.scenarioProps.id) {
      members.push("/** The scenario's id. */", `readonly ${info.scenarioProps.id}: string;`);
      destructured.push(info.scenarioProps.id);
    }
    const typeName = `${info.component}Props`;
    const hooks = [...ctx.scoped.values()].map((name) => `const ${name} = useId();`);
    const returned =
      body.length === 0
        ? ["return null;"]
        : shown === null
          ? body.length === 1
            ? [`return ${body[0]};`]
            : ["return (", ...body.map((line) => INDENT + line), ");"]
          : [`return ${shown} ? (`, ...body.map((line) => INDENT + line), ") : null;"];
    const lines = [
      ...this.imports(ctx, library),
      "",
      ...(members.length > 0 ? [`type ${typeName} = {`, ...members.map((line) => INDENT + line), "};", ""] : []),
      `/** The ${info.id} layout, written from ${info.doc.file}: its props are the layout's parameters. */`,
      `export default function ${info.component}(${members.length > 0 ? `{ ${destructured.join(", ")} }: ${typeName}` : ""}) {`,
      ...[...hooks, ...orphans].map((line) => indentLines(line, INDENT)),
      ...returned.map((line) => INDENT + line),
      "}",
    ];
    return `${lines.join("\n")}\n`;
  }
}

/** A condition as an operand of `operator`: in parentheses when it holds an operator that would bind it otherwise, or would read ambiguously. */
function group(text: string, operator: "&&" | "||" | "?"): string {
  const loose = operator === "&&" ? /\|\||\?/ : operator === "||" ? /&&|\?/ : /&&|\|\||\?/;
  return loose.test(text) ? `(${text})` : text;
}

function indentLines(text: string, indent: string): string {
  return text
    .split("\n")
    .map((line) => (line ? indent + line : line))
    .join("\n");
}

/** The import path from one file to another, without its extension. */
export function relative(from: string, to: string): string {
  const fromParts = from.split("/").slice(0, -1);
  const toParts = to.replace(/\.tsx?$/, "").split("/");
  let common = 0;
  while (common < fromParts.length && common < toParts.length - 1 && fromParts[common] === toParts[common]) common += 1;
  const up = fromParts.length - common;
  const rest = toParts.slice(common).join("/");
  return up === 0 ? `./${rest}` : `${"../".repeat(up)}${rest}`;
}

/**
 * A spec prototype written as React: one TSX file per page and per layout
 * at the spec file's path with `.tsx`, and the manifest unchanged but for
 * those paths. Refused for a TSX prototype, which needs no writing, and
 * when the project has no catalog to read the specs with.
 */
export function specToTsx(prototype: Prototype, config: ProjectConfig): { ok: true; value: TsxExport } | { ok: false; error: string } {
  if (prototype.format !== "spec") return { ok: false, error: "This prototype is already TSX." };
  const read = readSpecs(prototype, config);
  if (!read.catalog) return { ok: false, error: "The project's library has no part descriptions, so its specs cannot be read." };
  const names = new Map<string, string>();
  const taken = new Set<string>();
  for (const page of [...prototype.pages].sort((a, b) => compare(a.id, b.id))) if (!names.has(page.component.file)) names.set(page.component.file, fresh(pascal(`${page.id}-page`), taken));
  for (const layout of [...prototype.layouts].sort((a, b) => compare(a.id, b.id))) if (!names.has(layout.component.file)) names.set(layout.component.file, fresh(pascal(layout.id), taken));
  const writer = new TsxWriter(prototype, read.catalog, read.docs, read.layouts, names);
  const files: Record<string, string> = {};
  const library = config.library.package;
  for (const page of [...prototype.pages].sort((a, b) => compare(a.id, b.id))) {
    const doc = read.docs.get(page.component.file);
    if (!doc || doc.role !== "page" || !doc.elements.has(doc.root)) {
      writer.notes.push(`Page "${page.id}": ${page.component.file} could not be read, so it was not written.`);
      continue;
    }
    const slots = config.inventories.pageTypes.find((type) => type.id === page.pageType)?.slots ?? [];
    files[writer.outputFile(page.component.file)] = writer.page(page.id, doc, slots, library);
  }
  for (const layout of [...prototype.layouts].sort((a, b) => compare(a.id, b.id))) {
    const info = writer.layout(layout.id);
    if (!info || !info.doc.elements.has(info.doc.root)) {
      writer.notes.push(`Layout "${layout.id}": ${layout.component.file} could not be read, so it was not written.`);
      continue;
    }
    files[info.file] = writer.layoutFile(info, library);
  }
  for (const file of Object.keys(prototype.files).sort(compare)) {
    if (!read.docs.has(file) || read.docs.get(file)?.role === "unused") writer.notes.push(`${file} is not a page or layout of the manifest, so it was not written.`);
  }
  if (read.issues.length > 0) writer.notes.push(`Core refused ${read.issues.length} part${read.issues.length === 1 ? "" : "s"} of the specs (its extract rule's findings); what it refused is not in the export.`);
  const swap = (file: string) => writer.outputFile(file);
  const tsx: Prototype = {
    format: "tsx",
    files,
    pages: prototype.pages.map((page) => ({ ...page, component: { file: swap(page.component.file), export: "default" } })),
    layouts: prototype.layouts.map((layout) => ({ ...layout, component: { file: swap(layout.component.file), export: "default" } })),
    scenarios: prototype.scenarios,
    flow: prototype.flow,
  };
  return { ok: true, value: { prototype: tsx, notes: writer.notes } };
}
