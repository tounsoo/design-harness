import type { LayoutUse, SourceLocation } from "../prototype/model";
import type { PageEntry, Prototype } from "../prototype/types";
import { LAYOUT_TYPE } from "./catalog";
import { isRecord, pointer, type JsonValue } from "./json";
import { LAYOUT_ID_PROP, PARAM_STATE, TEMPLATE_PARAM } from "./params";
import { isExpression, locateIn, type ChildRef, type ReadSpecs, type SpecDoc, type SpecElement, type SpecIssue } from "./read";

/**
 * Layout instances expanded: one page as one tree of elements, every
 * instance drawn in place with its parameters substituted. Core does this
 * before anything else reads a page, so the page model the rules check and
 * the spec a frame draws are the same expanded tree, and neither ever sees
 * a parameter.
 *
 * Expansion is deterministic and depends only on the files' content, never
 * on the order keys come in:
 *
 * - an element a layout draws is keyed `<instance>/<key>`, where the
 *   instance is the key of the Layout element that draws it (nested
 *   instances join with "/"), so two instances never collide;
 * - `{ "$scopedId": "name" }` is `<instance>/name`: an element id unique per
 *   instance, and per item, through the repeat's key, inside one keyed repeat;
 * - a literal list a page gives for a repeat is kept in the page's state at
 *   `/params/<instance>/<param>`, which json-render's repeat reads;
 * - a condition that reads a parameter (`visible`, or a `$cond`) becomes
 *   json-render's own: the value given put in as its source or operand, and
 *   a condition of literals alone worked out to true or false, so an
 *   element shown never is left out;
 * - `${$param:name}` in a `$template` becomes what was given: literal text,
 *   `${/path}` for state, `${field}` for an item, a page's own template, or,
 *   for a `$cond`, a `$cond` of two templates.
 *
 * A given value json-render has no way to read there (an `$index` in a
 * template, a `$template` in a condition) is an issue where the layout reads
 * it, so the extract rule fails rather than anything passing on a guess.
 *
 * Each expanded element keeps where it is written and the layout uses that
 * draw it (`via`), so a finding inside an instance points both at the
 * layout's element and at the page's use of it.
 */

/** A repeat as json-render draws it: over a list in state or in the item. */
export type ExpandedRepeat = { readonly statePath: string | { readonly $item: string }; readonly key?: string };

export type ExpandedElement = {
  /** Its key in the expanded page: its key in its file, under its instance's. */
  readonly key: string;
  readonly type: string;
  readonly props: { readonly [key: string]: JsonValue };
  readonly children: readonly string[];
  /** A Page's slots. */
  readonly slots?: { readonly [slot: string]: readonly string[] };
  readonly visible: JsonValue | undefined;
  readonly repeat: ExpandedRepeat | undefined;
  readonly on: SpecElement["on"];
  /** The file it is written in, and its key there. */
  readonly doc: SpecDoc;
  readonly source: string;
  /** Where the layouts that draw it are used, nearest first; empty for what a page writes itself. */
  readonly via: readonly LayoutUse[];
  /** On a Layout element: the layout it draws, whose root, expanded, is its one child. */
  readonly layout?: string;
  /** On a Layout element whose layout draws itself, so nothing is drawn. */
  readonly recursive?: true;
};

export type ExpandedPage = {
  readonly id: string;
  readonly doc: SpecDoc;
  readonly root: string;
  /** Every element the page draws, by expanded key, in the order expansion reached them. */
  readonly elements: ReadonlyMap<string, ExpandedElement>;
  /** The page's state, and `params` with the literal lists its instances repeat over. */
  readonly state: { readonly [key: string]: JsonValue };
};

/** What one instance was given: its layout, its parameters' values in its user's terms, and the elements for its slots. */
type Instance = {
  readonly id: string;
  readonly values: Readonly<Record<string, JsonValue>>;
  readonly slots: Readonly<Record<string, readonly Placed[]>>;
};

/** Where expansion is: the file, the instance it draws (none on the page), and what is above. */
type Frame = {
  readonly doc: SpecDoc;
  /** The expanded key of the instance this frame draws; empty on the page. */
  readonly prefix: string;
  readonly instance: Instance | null;
  readonly via: readonly LayoutUse[];
  /** The layouts being drawn, outermost first, so a layout that draws itself stops. */
  readonly chain: readonly string[];
  /** How many repeats of this frame's layout are above: a value from outside the layout must not read an item there. */
  readonly repeatsInLayout: number;
  /** The key field of every repeat above, from the page down (undefined where a repeat has none). */
  readonly repeats: readonly (string | undefined)[];
};

/** An element a user of a layout passes into one of its slots, expanded where the layout places it. */
type Placed = { readonly frame: Frame; readonly key: string };

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** True when a value reads the repeat item it is drawn in: `$item`, `$index`, `$bindItem`, or a template field without "/" (a parameter's aside). */
export function readsItem(value: JsonValue | undefined): boolean {
  if (Array.isArray(value)) return value.some(readsItem);
  if (!isRecord(value)) return false;
  if ("$item" in value || "$index" in value || "$bindItem" in value) return true;
  if (typeof value.$template === "string" && /\$\{(?!\/|\$param:)[^}]*\}/.test(value.$template)) return true;
  return Object.values(value).some(readsItem);
}

/** True when a condition reads a parameter anywhere in it. */
function conditionReadsParam(condition: JsonValue | undefined): boolean {
  if (Array.isArray(condition)) return condition.some(conditionReadsParam);
  if (!isRecord(condition)) return false;
  return "$param" in condition || Object.values(condition).some(conditionReadsParam);
}

const FLIPPED: Readonly<Record<string, string>> = { eq: "eq", neq: "neq", gt: "lt", gte: "lte", lt: "gt", lte: "gte" };

/** A comparison of two known values, as json-render makes it: strict equality, and order between numbers only. */
function compareLiterals(left: JsonValue | undefined, operator: string | undefined, right: JsonValue | undefined): boolean {
  if (operator === undefined) return Boolean(left);
  if (operator === "eq") return left === right;
  if (operator === "neq") return left !== right;
  if (typeof left !== "number" || typeof right !== "number") return false;
  return operator === "gt" ? left > right : operator === "gte" ? left >= right : operator === "lt" ? left < right : left <= right;
}

/** One side of a condition, once a parameter is put in: a value known now, a reference json-render reads, or what neither can be. */
type Side = { readonly known: JsonValue | undefined } | { readonly reads: { readonly [key: string]: JsonValue } } | null;

function sideOf(value: JsonValue | undefined): Side {
  if (value === undefined || !isExpression(value)) return { known: value };
  const keys = Object.keys(value);
  if (keys.length !== 1) return null;
  if (typeof value.$state === "string" || typeof value.$item === "string" || value.$index === true) return { reads: value };
  return null;
}

/** A piece of a template: text as written, or a parameter's value to put in. */
type Piece = string | { readonly name: string; readonly value: JsonValue | undefined };

class Expander {
  readonly issues: SpecIssue[] = [];
  readonly elements = new Map<string, ExpandedElement>();
  readonly params: Record<string, Record<string, JsonValue>> = {};
  private readonly reported = new Set<string>();

  constructor(
    private readonly prototype: Prototype,
    private readonly read: ReadSpecs,
  ) {}

  at(frame: Frame, key: string, ...path: (string | number)[]): SourceLocation {
    const at = locateIn(frame.doc.file, frame.doc.positions, ["elements", key, ...path]);
    return frame.via.length > 0 ? { ...at, via: frame.via } : at;
  }

  issue(message: string, at: SourceLocation): void {
    const id = JSON.stringify([message, at]);
    if (this.reported.has(id)) return;
    this.reported.add(id);
    this.issues.push({ file: at.file, message, at });
  }

  layoutDoc(id: string): SpecDoc | undefined {
    const entry = this.prototype.layouts.find((layout) => layout.id === id);
    const doc = entry ? this.read.docs.get(entry.component.file) : undefined;
    return doc?.role === "layout" ? doc : undefined;
  }

  /** `{ "$scopedId": name }` as the id it is in this instance, per item inside one keyed repeat. */
  scopedId(frame: Frame, name: string, key: string, path: (string | number)[]): JsonValue {
    const base = frame.prefix ? `${frame.prefix}/${name}` : name;
    if (frame.repeats.length === 0) return base;
    const [only] = frame.repeats;
    if (frame.repeats.length === 1 && only !== undefined) return { $template: `${base}/\${${only}}` };
    this.issue(
      `${frame.doc.file}: element "${key}" sets { "$scopedId": "${name}" } inside ${frame.repeats.length === 1 ? "a repeat with no key" : `${frame.repeats.length} repeats`}, so the id would repeat on the page. It is unique per item only inside one repeat that names its "key".`,
      this.at(frame, key, ...path),
    );
    return base;
  }

  /** A value with this frame's parameters put in and its scoped ids made, or undefined when it reads a parameter nobody gave. */
  substitute(value: JsonValue, frame: Frame, key: string, path: (string | number)[]): JsonValue | undefined {
    if (Array.isArray(value)) return value.map((item, index) => this.substitute(item, frame, key, [...path, index]) ?? null);
    if (!isRecord(value)) return value;
    const keys = Object.keys(value);
    if (keys.length === 1 && typeof value.$param === "string") return this.given(value.$param, frame, key, path);
    if (keys.length === 1 && typeof value.$scopedId === "string") return this.scopedId(frame, value.$scopedId, key, path);
    if (keys.length === 1 && typeof value.$template === "string" && value.$template.includes(`\${${TEMPLATE_PARAM}`)) return this.template(value.$template, frame, key, [...path, "$template"]);
    if (keys.length === 3 && "$cond" in value && "$then" in value && "$else" in value && conditionReadsParam(value.$cond)) {
      const condition = this.condition(value.$cond as JsonValue, frame, key, [...path, "$cond"]);
      const then = this.substitute(value.$then as JsonValue, frame, key, [...path, "$then"]);
      const otherwise = this.substitute(value.$else as JsonValue, frame, key, [...path, "$else"]);
      if (condition === true) return then;
      if (condition === false) return otherwise;
      // A condition json-render cannot read was reported; both values stay, so every rule still sees both.
      return { $cond: condition ?? true, $then: then ?? null, $else: otherwise ?? null };
    }
    const out: Record<string, JsonValue> = {};
    for (const field of keys) {
      const next = this.substitute(value[field] as JsonValue, frame, key, [...path, field]);
      if (next !== undefined) out[field] = next;
    }
    return out;
  }

  /** What the instance was given for a parameter, refused where the layout repeats if it reads the item where it is used. */
  private given(name: string, frame: Frame, key: string, path: (string | number)[]): JsonValue | undefined {
    const given = frame.instance?.values[name];
    if (given !== undefined && frame.repeatsInLayout > 0 && readsItem(given)) {
      this.issue(
        `${frame.doc.file}: element "${key}" reads parameter "${name}" inside a repeat of layout "${frame.instance?.id}", but the value it was given reads the repeat item where it is used, so here it would read the layout's item instead. Give the value from page state, or move the repeat out of the layout.`,
        this.at(frame, key, ...path),
      );
    }
    return given;
  }

  /**
   * A condition with its parameters put in, as json-render reads it: true or
   * false where it no longer reads anything that changes, or null when a
   * value given cannot stand in it, which is reported where it is read.
   */
  condition(condition: JsonValue, frame: Frame, key: string, path: (string | number)[]): JsonValue | null {
    if (!conditionReadsParam(condition)) return condition;
    const every = (list: readonly JsonValue[], at: (string | number)[]) => list.map((item, index) => this.condition(item, frame, key, [...at, index]));
    if (Array.isArray(condition) || (isRecord(condition) && Array.isArray(condition.$and))) {
      const list = Array.isArray(condition) ? every(condition, path) : every(condition.$and as JsonValue[], [...path, "$and"]);
      if (list.includes(null)) return null;
      if (list.includes(false)) return false;
      const rest = list.filter((item) => item !== true) as JsonValue[];
      // A list holds single conditions only; a joined one stays joined.
      return rest.length === 0 ? true : Array.isArray(condition) && rest.every((item) => isRecord(item) && !("$and" in item) && !("$or" in item)) ? rest : { $and: rest };
    }
    if (isRecord(condition) && Array.isArray(condition.$or)) {
      const list = every(condition.$or as JsonValue[], [...path, "$or"]);
      if (list.includes(null)) return null;
      if (list.includes(true)) return true;
      const rest = list.filter((item) => item !== false) as JsonValue[];
      return rest.length === 0 ? false : { $or: rest };
    }
    if (!isRecord(condition)) return condition;
    const operator = Object.keys(FLIPPED).find((name) => name in condition);
    const operand = operator === undefined ? undefined : condition[operator];
    const not = condition.not === true;
    const refuse = (name: string, value: JsonValue | undefined, why: string, at: (string | number)[]): null => {
      this.issue(`${frame.doc.file}: element "${key}" reads parameter "${name}" in a condition, but it was given ${value === undefined ? "no value" : JSON.stringify(value).slice(0, 80)}, ${why}.`, this.at(frame, key, ...at));
      return null;
    };
    let source: Side;
    if (typeof condition.$param === "string") {
      const value = this.given(condition.$param, frame, key, [...path, "$param"]);
      source = sideOf(value);
      if (source === null) return refuse(condition.$param, value, 'which a condition cannot read: give a literal, { "$state": "/path" }, { "$item": "field" } or { "$index": true }', [...path, "$param"]);
    } else {
      const ref = ["$state", "$item", "$index"].find((name) => name in condition) as string;
      source = { reads: { [ref]: condition[ref] as JsonValue } };
    }
    let other: Side = operator === undefined ? { known: undefined } : sideOf(operand);
    if (operator !== undefined && isRecord(operand) && typeof operand.$param === "string") {
      const value = this.given(operand.$param, frame, key, [...path, operator]);
      other = sideOf(value);
      if (other === null || ("reads" in other && typeof other.reads.$state !== "string")) return refuse(operand.$param, value, 'which a condition cannot compare with: give a literal or { "$state": "/path" }', [...path, operator]);
      if ("known" in other && other.known === undefined) return refuse(operand.$param, value, "so there is nothing to compare with", [...path, operator]);
    }
    if (other === null) return null;
    const flag = not ? { not: true } : {};
    if ("reads" in source) return { ...source.reads, ...(operator === undefined ? {} : { [operator]: "reads" in other ? other.reads : (other.known as JsonValue) }), ...flag };
    if ("known" in other) return compareLiterals(source.known, operator, other.known) !== not;
    // A known value compared with state: the state is the source, and the comparison turns round.
    const name = typeof condition.$param === "string" ? condition.$param : "";
    if (source.known === undefined) return refuse(name, undefined, "so there is nothing to compare the state with", [...path, "$param"]);
    return { ...other.reads, [FLIPPED[operator as string] as string]: source.known, ...flag };
  }

  /** A `$template` with each `${$param:name}` put in, as a template json-render reads, or a `$cond` of templates for a value given as one. */
  template(template: string, frame: Frame, key: string, path: (string | number)[]): JsonValue {
    const pieces: Piece[] = [];
    let rest = template;
    for (let match = /\$\{([^}]*)\}/.exec(rest); match; match = /\$\{([^}]*)\}/.exec(rest)) {
      const ref = match[1] ?? "";
      pieces.push(rest.slice(0, match.index));
      if (ref.startsWith(TEMPLATE_PARAM)) {
        const name = ref.slice(TEMPLATE_PARAM.length);
        pieces.push({ name, value: this.given(name, frame, key, path) });
      } else pieces.push(match[0]);
      rest = rest.slice(match.index + match[0].length);
    }
    pieces.push(rest);
    return this.joined(pieces, frame, key, path);
  }

  private joined(pieces: readonly Piece[], frame: Frame, key: string, path: (string | number)[]): JsonValue {
    let out = "";
    for (const [index, piece] of pieces.entries()) {
      if (typeof piece === "string") {
        out += piece;
        continue;
      }
      const { name, value } = piece;
      const refuse = (why: string) => this.issue(`${frame.doc.file}: element "${key}" reads parameter "${name}" in a $template, but it was given ${JSON.stringify(value).slice(0, 80)}, ${why}.`, this.at(frame, key, ...path));
      if (value === undefined || value === null) continue;
      if (!isRecord(value) && !Array.isArray(value)) {
        const text = String(value);
        if (text.includes("${")) refuse('which holds "${", so json-render would read it as a reference');
        else out += text;
      } else if (isRecord(value) && Object.keys(value).length === 1 && typeof value.$state === "string") out += `\${${value.$state}}`;
      else if (isRecord(value) && Object.keys(value).length === 1 && typeof value.$item === "string" && value.$item !== "" && !value.$item.includes("}")) out += `\${${value.$item}}`;
      else if (isRecord(value) && Object.keys(value).length === 1 && typeof value.$template === "string") out += value.$template;
      else if (isRecord(value) && Object.keys(value).length === 3 && "$cond" in value && "$then" in value && "$else" in value) {
        // A value chosen by a condition: the template is drawn once for each, under the same condition.
        const branch = (chosen: JsonValue | undefined) => this.joined([out, { name, value: chosen }, ...pieces.slice(index + 1)], frame, key, path);
        return { $cond: value.$cond as JsonValue, $then: branch(value.$then), $else: branch(value.$else) };
      } else refuse('which a template cannot put in: give text, a number, { "$state": "/path" }, { "$item": "field" }, a $template or a $cond of them');
    }
    return { $template: out };
  }

  /** An element's `visible` with its parameters put in: undefined when it always shows, so a condition that cannot be read leaves the element shown and reported. */
  private visible(visible: JsonValue | undefined, frame: Frame, key: string): JsonValue | undefined {
    if (visible === undefined || !conditionReadsParam(visible)) return visible;
    const condition = this.condition(visible, frame, key, ["visible"]);
    return condition === null || condition === true ? undefined : condition;
  }

  /** Expands element `key` of the frame's file, and returns its expanded key, or null when it draws nothing. */
  expand(frame: Frame, key: string): string | null {
    const element = frame.doc.elements.get(key);
    if (!element) return null;
    const out = frame.prefix ? `${frame.prefix}/${key}` : key;
    if (this.elements.has(out)) return null;
    if (element.type === LAYOUT_TYPE) return this.instance(frame, element, out);

    const props: Record<string, JsonValue> = {};
    for (const name of Object.keys(element.props).sort(compare)) {
      const value = this.substitute(element.props[name] as JsonValue, frame, key, ["props", name]);
      if (value !== undefined) props[name] = value;
    }
    const repeat = element.repeat ? this.repeat(frame, element) : undefined;
    const inner: Frame = element.repeat ? { ...frame, repeatsInLayout: frame.repeatsInLayout + (frame.instance ? 1 : 0), repeats: [...frame.repeats, element.repeat.key] } : frame;
    // Claimed before the children, so what they reach is keyed under an element that exists.
    const placeholder: ExpandedElement = { key: out, type: element.type, props, children: [], visible: this.visible(element.visible, frame, key), repeat, on: element.on, doc: frame.doc, source: key, via: frame.via };
    this.elements.set(out, placeholder);
    const children = this.list(inner, element.children, key);
    const slots = element.slots ? Object.fromEntries(Object.keys(element.slots).sort(compare).map((slot) => [slot, this.list(inner, element.slots?.[slot] ?? [], key)])) : undefined;
    this.elements.set(out, { ...placeholder, children, ...(slots ? { slots } : {}) });
    return out;
  }

  /** The expanded keys of a list of children: elements of this file, and a slot parameter's elements where the layout places them. */
  private list(frame: Frame, list: readonly ChildRef[], key: string): string[] {
    const out: string[] = [];
    for (const child of list) {
      if (typeof child === "string") {
        const expanded = this.expand(frame, child);
        if (expanded !== null) out.push(expanded);
        continue;
      }
      const placed = frame.instance?.slots[child.param] ?? [];
      const at = locateIn(frame.doc.file, frame.doc.positions, ["elements", key]);
      for (const item of placed) {
        if (frame.repeatsInLayout > 0 && this.subtreeReadsItem(item.frame.doc, item.key)) {
          this.issue(
            `${item.frame.doc.file}: element "${item.key}" is passed into slot "${child.param}" of layout "${frame.instance?.id}", which places it inside a repeat of the layout, but it reads a repeat item, so there it would read the layout's item.`,
            this.at(item.frame, item.key),
          );
        }
        const use: LayoutUse = { layout: frame.instance?.id ?? "", file: frame.doc.file, line: at.line, column: at.column, slot: child.param };
        const expanded = this.expand({ ...item.frame, via: [use, ...item.frame.via], repeats: frame.repeats }, item.key);
        if (expanded !== null) out.push(expanded);
      }
    }
    return out;
  }

  /** True when an element, or one under it outside a repeat of its own, reads the item of a repeat above it. */
  private subtreeReadsItem(doc: SpecDoc, key: string, seen: Set<string> = new Set()): boolean {
    const element = doc.elements.get(key);
    if (!element || seen.has(key)) return false;
    seen.add(key);
    if (readsItem(element.props as JsonValue) || readsItem(element.visible) || (element.repeat && "statePath" in element.repeat && typeof element.repeat.statePath !== "string")) return true;
    if (element.repeat) return false;
    const below = [...element.children, ...Object.values(element.slots ?? {}).flat()];
    return below.some((child) => typeof child === "string" && this.subtreeReadsItem(doc, child, seen));
  }

  private repeat(frame: Frame, element: SpecElement): ExpandedRepeat | undefined {
    const repeat = element.repeat;
    if (!repeat) return undefined;
    const keyed = repeat.key !== undefined ? { key: repeat.key } : {};
    if ("statePath" in repeat) return { statePath: repeat.statePath, ...keyed };
    const given = frame.instance?.values[repeat.param];
    if (isRecord(given) && typeof given.$state === "string") return { statePath: given.$state, ...keyed };
    if (isRecord(given) && typeof given.$item === "string") {
      if (frame.repeatsInLayout > 0) this.issue(`${frame.doc.file}: element "${element.key}" repeats over parameter "${repeat.param}" inside a repeat of layout "${frame.instance?.id}", but the value it was given reads the repeat item where it is used, so here it would read the layout's item instead.`, this.at(frame, element.key, "repeat"));
      return { statePath: { $item: given.$item }, ...keyed };
    }
    // A literal list (or none given): kept in the page's state under the instance, where json-render's repeat reads it.
    const list = Array.isArray(given) ? given : [];
    (this.params[frame.prefix] ??= {})[repeat.param] = list;
    return { statePath: pointer([PARAM_STATE, frame.prefix, repeat.param]), ...keyed };
  }

  private instance(frame: Frame, element: SpecElement, out: string): string {
    const id = typeof element.props[LAYOUT_ID_PROP] === "string" ? (element.props[LAYOUT_ID_PROP] as string) : "";
    const doc = this.layoutDoc(id);
    const base: ExpandedElement = { key: out, type: LAYOUT_TYPE, props: { [LAYOUT_ID_PROP]: id }, children: [], visible: this.visible(element.visible, frame, element.key), repeat: undefined, on: undefined, doc: frame.doc, source: element.key, via: frame.via, layout: id };
    if (frame.chain.includes(id)) {
      this.elements.set(out, { ...base, recursive: true });
      return out;
    }
    this.elements.set(out, base);
    // A layout the manifest lacks, or whose file did not read, is reported where the file or the manifest is.
    if (!doc) return out;
    const values: Record<string, JsonValue> = {};
    for (const name of Object.keys(element.props).sort(compare)) {
      if (name === LAYOUT_ID_PROP) continue;
      const value = this.substitute(element.props[name] as JsonValue, frame, element.key, ["props", name]);
      if (value !== undefined) values[name] = value;
    }
    for (const [name, param] of Object.entries(doc.params)) if (values[name] === undefined && "default" in param && param.default !== undefined) values[name] = param.default;
    const slots: Record<string, Placed[]> = {};
    for (const name of Object.keys(doc.params).sort(compare)) {
      if (doc.params[name]?.type !== "slot") continue;
      slots[name] = (element.slots?.[name] ?? []).flatMap((child): Placed[] => (typeof child === "string" ? [{ frame, key: child }] : [...(frame.instance?.slots[child.param] ?? [])]));
    }
    const at = locateIn(frame.doc.file, frame.doc.positions, ["elements", element.key]);
    const inner: Frame = {
      doc,
      prefix: out,
      instance: { id, values, slots },
      via: [{ layout: id, file: frame.doc.file, line: at.line, column: at.column }, ...frame.via],
      chain: [...frame.chain, id],
      repeatsInLayout: 0,
      repeats: frame.repeats,
    };
    const root = this.expand(inner, doc.root);
    this.elements.set(out, { ...base, children: root === null ? [] : [root] });
    return out;
  }
}

/**
 * One manifest page with every layout instance it draws expanded, and what
 * expansion found wrong, each issue where it is and where the layout is
 * used. Null when the page's file did not read. Pure and deterministic.
 */
export function expandPage(page: PageEntry, read: ReadSpecs, prototype: Prototype): { readonly page: ExpandedPage | null; readonly issues: readonly SpecIssue[] } {
  const doc = read.docs.get(page.component.file);
  if (!doc || !doc.elements.has(doc.root)) return { page: null, issues: [] };
  const expander = new Expander(prototype, read);
  const root = expander.expand({ doc, prefix: "", instance: null, via: [], chain: [], repeatsInLayout: 0, repeats: [] }, doc.root);
  if (root === null) return { page: null, issues: expander.issues };
  const params = Object.keys(expander.params).length > 0 ? { [PARAM_STATE]: Object.fromEntries(Object.keys(expander.params).sort(compare).map((key) => [key, expander.params[key] as JsonValue])) } : {};
  return { page: { id: page.id, doc, root, elements: expander.elements, state: { ...(doc.state ?? {}), ...params } }, issues: expander.issues };
}
