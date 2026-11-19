import type { ProjectConfig } from "../config/types";
import type { ElementNode, ExtractionProblem, PageModel, PropValue, PrototypeModel, SourceLocation } from "../extract/model";
import type { Prototype, Scenario } from "../prototype/types";
import type { Literal } from "../rules/types";
import { LAYOUT_TYPE, PAGE_TYPE, SCENARIO_STATE, TEXT_PROP } from "./catalog";
import { expandPage, type ExpandedElement, type ExpandedPage } from "./expand";
import { isRecord, type JsonValue } from "./json";
import { isExpression, keysOf, locateIn, readSpecs, type SpecDoc, type SpecIssue } from "./read";

/**
 * A spec prototype's page model: the same `PrototypeModel` the TSX extractor
 * builds, so every rule runs on it unchanged. There is no code to evaluate:
 * each page is expanded first (every layout instance drawn in place with its
 * parameters, expand.ts), each element is data, and a value an element reads
 * is resolved from the spec where the spec says it:
 *
 * - from the page's `state`, when nothing in the page writes that path (a
 *   bound prop or a setState, pushState or removeState action);
 * - from the scenarios: `/scenario/state` is one of the flow states the
 *   page's scenarios show, `/scenario/id` one of their ids;
 * - per item, when a `repeat` reads a list nothing writes: each item is
 *   expanded exactly, as the extractor does for a list written in the source.
 *
 * Anything else (a bound value, a path the page writes) is dynamic, and a
 * rule that depends on it reports that it cannot tell, as for TSX; so is a
 * parameter given such a value. An element with a `visible` condition still
 * counts: rules read every state at once. An element a layout draws is where
 * the layout writes it, with `via` naming the page's use, so a finding about
 * it points at both. Validation and expansion issues become extraction
 * problems, which the always-on `extract` rule reports.
 */

type Scope = {
  readonly page: {
    readonly id: string;
    readonly expanded: ExpandedPage;
    readonly state: { readonly [key: string]: JsonValue };
    readonly scenarioStates: readonly string[];
    readonly scenarioIds: readonly string[];
    readonly writes: readonly string[];
  };
  /** The current repeat item, when it is known; `unknown` inside a repeat over a list that can change. */
  readonly item: { readonly known: true; readonly value: JsonValue; readonly index: number } | { readonly known: false } | null;
  readonly repeated: boolean;
  readonly conditional: boolean;
};

type Resolved = { readonly kind: "values"; readonly values: readonly JsonValue[] } | { readonly kind: "dynamic"; readonly reason: string };

const dynamic = (reason: string): Resolved => ({ kind: "dynamic", reason });

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** RFC 6901 lookup in a JSON value; undefined when the path is not there. */
function lookup(root: JsonValue | undefined, path: string): JsonValue | undefined {
  if (path === "" || path === "/") return root;
  let current: JsonValue | undefined = root;
  for (const raw of path.replace(/^\//, "").split("/")) {
    const part = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) current = /^\d+$/.test(part) ? current[Number(part)] : undefined;
    else if (isRecord(current)) current = Object.hasOwn(current, part) ? current[part] : undefined;
    else return undefined;
  }
  return current;
}

function isLiteral(value: JsonValue): value is Literal {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

/** Where an expanded element is written, with the layout uses that draw it. */
export function elementAt(element: ExpandedElement, ...path: (string | number)[]): SourceLocation {
  const at = locateIn(element.doc.file, element.doc.positions, ["elements", element.source, ...path]);
  return element.via.length > 0 ? { ...at, via: element.via } : at;
}

/** Every state path an expanded page can change at run time: what its parts bind, and what its actions write. */
export function writesOf(page: ExpandedPage): string[] {
  const out: string[] = [];
  const visit = (value: JsonValue | undefined) => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (isRecord(value)) {
      if (typeof value.$bindState === "string") out.push(value.$bindState);
      // A bound item field writes into the list it repeats over, which the repeat's path names.
      if (typeof value.$bindItem === "string") out.push("*item");
      Object.values(value).forEach(visit);
    }
  };
  for (const element of page.elements.values()) {
    visit(element.props);
    for (const bindings of Object.values(element.on ?? {})) for (const binding of bindings) if (typeof binding.params.statePath === "string") out.push(binding.params.statePath);
  }
  return out;
}

export class SpecModeler {
  readonly problems: ExtractionProblem[] = [];
  private readonly reported = new Set<string>();

  private problem(message: string, at: SourceLocation): void {
    const key = JSON.stringify([at, message]);
    if (this.reported.has(key)) return;
    this.reported.add(key);
    this.problems.push({ message, at });
  }

  at(doc: SpecDoc, ...path: (string | number)[]): SourceLocation {
    return locateIn(doc.file, doc.positions, path);
  }

  /** A value as the page will show it: literals it can be, or why it cannot be told. */
  resolve(value: JsonValue | undefined, scope: Scope, where: SourceLocation): Resolved {
    if (value === undefined) return { kind: "values", values: [] };
    if (!isExpression(value)) return { kind: "values", values: [value] };
    if (typeof value.$state === "string") return this.read(value.$state, scope, where);
    if (typeof value.$bindState === "string") return dynamic(`bound to state ${value.$bindState}, which the person changes`);
    if (typeof value.$bindItem === "string") return dynamic(`bound to the item's ${value.$bindItem}, which the person changes`);
    if (typeof value.$item === "string") {
      if (scope.item === null) {
        this.problem(`${where.file}: reads { "$item": ${JSON.stringify(value.$item)} } outside a repeat, so it reads nothing.`, where);
        return dynamic("read from a repeat item outside any repeat");
      }
      if (!scope.item.known) return dynamic(`read from each item of a list the page changes`);
      const found = value.$item === "" ? scope.item.value : lookup(scope.item.value, `/${value.$item}`);
      return found === undefined ? { kind: "values", values: [null] } : { kind: "values", values: [found] };
    }
    if (value.$index === true) {
      if (scope.item === null || !scope.item.known) return dynamic("the index of an item in a list");
      return { kind: "values", values: [scope.item.index] };
    }
    if (typeof value.$template === "string") {
      let out = "";
      let rest = value.$template;
      for (let match = /\$\{([^}]*)\}/.exec(rest); match; match = /\$\{([^}]*)\}/.exec(rest)) {
        out += rest.slice(0, match.index);
        rest = rest.slice(match.index + match[0].length);
        const ref = match[1] ?? "";
        let piece: Resolved;
        if (ref.startsWith("/")) piece = this.read(ref, scope, where);
        else if (scope.item?.known && lookup(scope.item.value, `/${ref}`) !== undefined) piece = { kind: "values", values: [lookup(scope.item.value, `/${ref}`) as JsonValue] };
        else if (scope.item && !scope.item.known) piece = dynamic("read from each item of a list the page changes");
        else piece = this.read(`/${ref}`, scope, where);
        if (piece.kind === "dynamic") return piece;
        if (piece.values.length !== 1) return dynamic(`a template whose \${${ref}} is one of several values`);
        const one = piece.values[0];
        out += one === null || one === undefined ? "" : typeof one === "object" ? JSON.stringify(one) : String(one);
      }
      return { kind: "values", values: [out + rest] };
    }
    if ("$cond" in value) {
      const then = this.resolve(value.$then, scope, where);
      const otherwise = this.resolve(value.$else, scope, where);
      if (then.kind === "dynamic") return then;
      if (otherwise.kind === "dynamic") return otherwise;
      return { kind: "values", values: [...then.values, ...otherwise.values] };
    }
    return dynamic("computed at run time");
  }

  private read(path: string, scope: Scope, where: SourceLocation): Resolved {
    const { page } = scope;
    if (path === `/${SCENARIO_STATE}/state`) return page.scenarioStates.length > 0 ? { kind: "values", values: page.scenarioStates } : dynamic("the scenario's flow state");
    if (path === `/${SCENARIO_STATE}/id`) return page.scenarioIds.length > 0 ? { kind: "values", values: page.scenarioIds } : dynamic("the scenario's id");
    if (path === `/${SCENARIO_STATE}` || path.startsWith(`/${SCENARIO_STATE}/`)) return dynamic(`read from ${path}`);
    if (page.writes.some((written) => written === "*item" || overlaps(written, path))) return dynamic(`read from state ${path}, which the page changes at run time`);
    const found = lookup(page.state, path);
    if (found === undefined) {
      this.problem(`${where.file}: reads state ${path}, which the state of page "${page.id}" does not have, so it shows nothing there.`, where);
      return { kind: "values", values: [null] };
    }
    return { kind: "values", values: [found] };
  }

  private propValue(resolved: Resolved): PropValue {
    if (resolved.kind === "dynamic") return { kind: "dynamic", reason: resolved.reason };
    const distinct: JsonValue[] = [];
    for (const value of resolved.values) if (!distinct.some((seen) => JSON.stringify(seen) === JSON.stringify(value))) distinct.push(value);
    if (distinct.length === 0) return { kind: "literal", value: null };
    if (!distinct.every(isLiteral)) return { kind: "dynamic", reason: "a list or an object" };
    if (distinct.length === 1) return { kind: "literal", value: distinct[0] as Literal };
    return { kind: "choice", values: distinct as Literal[] };
  }

  /** One element as it renders on a page, with everything under it; a repeat over a known list expands per item. */
  node(key: string, scope: Scope): ElementNode[] {
    const element = scope.page.expanded.elements.get(key);
    if (!element) return [];
    if (element.visible === false) return [];
    const at = elementAt(element);
    // Every instance of one layout element shares its origin, as every render of one JSX expression does.
    const origin = `${element.doc.file}#${element.source}`;
    const conditional = scope.conditional || (element.visible !== undefined && element.visible !== true);
    if (element.layout !== undefined) return [this.layoutNode(element, at, origin, { ...scope, conditional })];
    const props: Record<string, PropValue> = {};
    for (const name of Object.keys(element.props).sort(compare)) {
      if (name === TEXT_PROP) continue;
      props[name] = this.propValue(this.resolve(element.props[name], scope, elementAt(element, "props", name)));
    }
    const text = this.propValue(this.resolve(element.props[TEXT_PROP], scope, elementAt(element, "props", TEXT_PROP)));
    const children = this.childrenOf(element, { ...scope, conditional });
    return [this.make("library", element.type, at, origin, props, text, children, scope, conditional, { key })];
  }

  private make(kind: ElementNode["kind"], name: string, at: SourceLocation, origin: string, props: Readonly<Record<string, PropValue>>, text: PropValue, children: readonly ElementNode[], scope: Pick<Scope, "repeated">, conditional: boolean, extra: Partial<ElementNode> = {}): ElementNode {
    const own = text.kind === "literal" && text.value !== null ? String(text.value) : "";
    const dynamicText = text.kind !== "literal";
    return {
      kind,
      name,
      at,
      origin,
      props,
      text: (own + children.map((child) => child.text).join("")).replace(/\s+/g, " ").trim(),
      textDynamic: dynamicText || children.some((child) => child.textDynamic),
      conditional,
      repeated: scope.repeated,
      ...extra,
      children,
    };
  }

  private childrenOf(element: ExpandedElement, scope: Scope): ElementNode[] {
    const children = element.children;
    if (!element.repeat) return children.flatMap((child) => this.node(child, scope));
    const { statePath } = element.repeat;
    const where = elementAt(element, "repeat");
    const list = typeof statePath === "string" ? this.resolve({ $state: statePath }, scope, where) : this.resolve({ $item: statePath.$item }, scope, where);
    const items = list.kind === "values" && list.values.length === 1 ? list.values[0] : undefined;
    if (!Array.isArray(items)) {
      if (list.kind === "values" && list.values.length === 1 && list.values[0] !== null) this.problem(`${where.file}: element "${element.source}" repeats over ${typeof statePath === "string" ? statePath : `the item's ${statePath.$item}`}, which is not a list.`, where);
      // A list the page can change: its items render any number of times.
      return children.flatMap((child) => this.node(child, { ...scope, item: { known: false }, repeated: true }));
    }
    return items.flatMap((item, index) => children.flatMap((child) => this.node(child, { ...scope, item: { known: true, value: item, index } })));
  }

  private layoutNode(element: ExpandedElement, at: SourceLocation, origin: string, scope: Scope): ElementNode {
    const id = element.layout ?? "";
    const base = { kind: "component" as const, name: id, at, origin, props: { id: { kind: "literal" as const, value: id } }, conditional: scope.conditional, repeated: scope.repeated, layout: id, key: element.key };
    if (element.recursive) {
      return { ...base, kind: "unresolved", text: "", textDynamic: true, reason: `layout "${id}" draws itself, so how deep it goes cannot be known`, children: [] };
    }
    const children = element.children.flatMap((child) => this.node(child, scope));
    return { ...base, text: children.map((child) => child.text).join("").replace(/\s+/g, " ").trim(), textDynamic: children.some((child) => child.textDynamic), children };
  }

  /** A page's tree: the page node, its slots in the page type's order as Slot nodes, and anything it puts outside them. */
  page(expanded: ExpandedPage, pageType: string, slotOrder: readonly string[], scenarios: readonly Scenario[]): PageModel | null {
    const root = expanded.elements.get(expanded.root);
    if (!root || root.type !== PAGE_TYPE) return null;
    const mine = scenarios.filter((scenario) => scenario.page === expanded.id);
    const scope: Scope = {
      page: {
        id: expanded.id,
        expanded,
        state: expanded.state,
        scenarioStates: [...new Set(mine.map((scenario) => scenario.state))].sort(compare),
        scenarioIds: mine.map((scenario) => scenario.id).sort(compare),
        writes: writesOf(expanded),
      },
      item: null,
      repeated: false,
      conditional: false,
    };
    const { doc } = expanded;
    const rank = (slot: string) => (slotOrder.includes(slot) ? slotOrder.indexOf(slot) : slotOrder.length);
    const slots = Object.keys(root.slots ?? {}).sort((a, b) => rank(a) - rank(b) || compare(a, b));
    const children: ElementNode[] = slots.map((slot) => {
      const nodes = (root.slots?.[slot] ?? []).flatMap((key) => this.node(key, scope));
      return this.make("kit", "Slot", this.at(doc, "elements", doc.root, "slots", slot), `${doc.file}#${doc.root}/slots/${slot}`, { name: { kind: "literal", value: slot } }, { kind: "literal", value: null }, nodes, scope, false, { key: `${expanded.root}/slots/${slot}` });
    });
    children.push(...root.children.flatMap((key) => this.node(key, scope)));
    const node = this.make("component", PAGE_TYPE, this.at(doc, "elements", doc.root), `${doc.file}#${doc.root}`, {}, { kind: "literal", value: null }, children, scope, false, { page: expanded.id, key: expanded.root });
    return { id: expanded.id, pageType, root: node };
  }

  /**
   * Every element of a file as written: from the root, then any element
   * nothing lists, each a tree of its own. Layouts are not drawn in, and a
   * value read from a parameter or state is unknown here, as it is in source.
   */
  source(doc: SpecDoc): ElementNode[] {
    const listed = new Set<string>();
    for (const element of doc.elements.values()) {
      for (const child of keysOf(element.children)) listed.add(child);
      for (const list of Object.values(element.slots ?? {})) for (const child of keysOf(list)) listed.add(child);
    }
    const scope = { repeated: false };
    const tree = (key: string): ElementNode[] => {
      const element = doc.elements.get(key);
      if (!element) return [];
      const at = this.at(doc, "elements", key);
      const origin = `${doc.file}#${key}`;
      const literal = (value: JsonValue | undefined): PropValue => (value !== undefined && !isExpression(value) && isLiteral(value) ? { kind: "literal", value } : { kind: "dynamic", reason: "read at run time" });
      const props: Record<string, PropValue> = {};
      for (const name of Object.keys(element.props).sort(compare)) if (name !== TEXT_PROP) props[name] = literal(element.props[name]);
      const text = element.props[TEXT_PROP] === undefined ? ({ kind: "literal", value: null } as const) : literal(element.props[TEXT_PROP]);
      const conditional = element.visible !== undefined && element.visible !== true;
      const slotNodes = Object.keys(element.slots ?? {})
        .sort(compare)
        .map((slot) => this.make("kit", "Slot", this.at(doc, "elements", key, "slots", slot), `${doc.file}#${key}/slots/${slot}`, { name: { kind: "literal", value: slot } }, { kind: "literal", value: null }, keysOf(element.slots?.[slot] ?? []).flatMap(tree), scope, false));
      if (element.type === LAYOUT_TYPE) {
        const id = typeof element.props.id === "string" ? element.props.id : "";
        return [this.make("component", id, at, origin, { id: { kind: "literal", value: id } }, { kind: "literal", value: null }, slotNodes, scope, conditional, { layout: id })];
      }
      const children = [...slotNodes, ...keysOf(element.children).flatMap(tree)];
      return [this.make(element.type === PAGE_TYPE ? "kit" : "library", element.type, at, origin, props, text, children, scope, conditional)];
    };
    const roots = [doc.root, ...[...doc.elements.keys()].filter((key) => key !== doc.root && !listed.has(key)).sort(compare)];
    return roots.flatMap(tree);
  }
}

/**
 * The page model of a spec prototype, for core's rules: each manifest page's
 * tree with its layout instances expanded, every element written in every
 * spec file, and what could not be read. Pure: the same prototype and config
 * give the same model.
 */
export function specModel(prototype: Prototype, config: ProjectConfig): PrototypeModel {
  const read = readSpecs(prototype, config);
  const modeler = new SpecModeler();
  const pageTypes = new Map(config.inventories.pageTypes.map((type) => [type.id, type]));
  const pages: PageModel[] = [];
  const expansion: SpecIssue[] = [];
  for (const page of [...prototype.pages].sort((a, b) => compare(a.id, b.id))) {
    const doc = read.docs.get(page.component.file);
    if (!doc || doc.role !== "page" || doc.elements.get(doc.root)?.type !== PAGE_TYPE) continue;
    const expanded = expandPage(page, read, prototype);
    expansion.push(...expanded.issues);
    if (!expanded.page) continue;
    const model = modeler.page(expanded.page, page.pageType, pageTypes.get(page.pageType)?.slots ?? [], prototype.scenarios);
    if (model) pages.push(model);
  }
  const source = [...read.docs.values()].flatMap((doc) => modeler.source(doc));
  const seen = new Set<string>();
  const problems: ExtractionProblem[] = [];
  for (const problem of [...read.issues, ...expansion, ...modeler.problems]) {
    const key = JSON.stringify([problem.at, problem.message]);
    if (seen.has(key)) continue;
    seen.add(key);
    problems.push({ message: problem.message, ...(problem.at ? { at: problem.at } : {}) });
  }
  return { pages, source, loads: [], ambient: [], problems };
}

/** Every problem with a spec prototype's files, with where each is: what the extract rule reports for it, and what the agent's spec tools refuse. */
export function specIssues(prototype: Prototype, config: ProjectConfig): SpecIssue[] {
  return specModel(prototype, config).problems.map((problem) => {
    const at = problem.at ?? { file: "manifest.json", line: 1, column: 1 };
    return { file: at.file, message: problem.message, at };
  });
}
