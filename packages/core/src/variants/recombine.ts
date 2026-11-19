import type { ProjectConfig } from "../config/types";
import type { Prototype } from "../prototype/types";
import { PAGE_TYPE, SCENARIO_STATE } from "../spec/catalog";
import { formatSpec } from "../spec/format";
import { isRecord, parseJson, type JsonValue } from "../spec/json";
import type { Result } from "../validate";
import { withPageSpec } from "./variants";

/**
 * Recombination: one page put together slot by slot from several complete
 * page specs, such as the body from variant B and the actions from variant
 * C. It is a pure function over specs: the same sources and picks give the
 * same text, whatever order the sources, the picks or the keys inside each
 * file come in.
 *
 * Each slot of the page type takes the elements its source lists in that
 * slot, with everything under them (children, and a Layout instance's
 * slots). What the sources share is made unique the way layout instances
 * are kept apart, by naming each source:
 *
 * - an element key that more than one source brings is `<key>-<source>` in
 *   each of them, and every reference to it follows;
 * - a literal element id (`id`, `htmlFor` and the ARIA id references) that
 *   more than one source brings is `<id>-<source>` in each of them, so a
 *   label still names its own field (a layout's `$scopedId` is already
 *   unique per instance, and instance keys are now unique);
 * - a top-level state key the sources give different values is
 *   `<key>-<source>` in each source that reads it, and every `$state`,
 *   `$bindState`, `statePath` and `${/path}` of that source follows; keys
 *   with the same value are shared.
 *
 * When every slot comes from one source the result is that source, every
 * element and all of its state, in core's canonical order. Otherwise the
 * page's root is "page", elements outside every slot are left out (the
 * page-structure rule fails them anyway), and state no chosen element reads
 * is kept only when its sources agree on it.
 */

export type Rename = { readonly kind: "element" | "id" | "state"; readonly source: string; readonly from: string; readonly to: string };

export type Recombination = {
  /** The page's new file, formatted as core formats specs. */
  readonly spec: string;
  /** The prototype with that file in the page's place. */
  readonly prototype: Prototype;
  /** Slot to source, in the page type's slot order. */
  readonly slots: Readonly<Record<string, string>>;
  readonly renamed: readonly Rename[];
  /** The key of the page's root in the result. */
  readonly root: string;
  /**
   * Source to every element key it brings, and the key that element has in
   * the result: the same key, unless `renamed` names it. Each source used
   * also lists its own root, which is the result's root. An element a
   * source holds but no slot picked from it reaches is not listed.
   */
  readonly keys: Readonly<Record<string, Readonly<Record<string, string>>>>;
};

type Element = { [field: string]: JsonValue };
type Source = { readonly name: string; readonly root: string; readonly rootElement: Element; readonly elements: Readonly<Record<string, Element>>; readonly state: Readonly<Record<string, JsonValue>> };

const ID_PROPS = ["id", "htmlFor", "aria-labelledby", "aria-describedby", "aria-controls"];
const PATH_KEYS = ["$state", "$bindState", "statePath"];
const FIELD_ORDER = ["type", "props", "children", "slots", "visible", "repeat", "on"];

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function canonical(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort(compare).map((key) => `${JSON.stringify(key)}:${canonical(value[key] as JsonValue)}`).join(",")}}`;
  return JSON.stringify(value);
}

function sortedRecord(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortedRecord);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort(compare).map((key) => [key, sortedRecord(value[key] as JsonValue)]));
}

/** The top-level key of a state path, unescaped, or null for a path that is not one. */
function topKey(path: string): string | null {
  if (!path.startsWith("/")) return null;
  const first = path.slice(1).split("/")[0] ?? "";
  return first.replace(/~1/g, "/").replace(/~0/g, "~");
}

const escape = (key: string) => key.replace(/~/g, "~0").replace(/\//g, "~1");

function renamePath(path: string, renames: ReadonlyMap<string, string>): string {
  const key = topKey(path);
  const to = key === null ? undefined : renames.get(key);
  if (to === undefined || key === null) return path;
  return `/${escape(to)}${path.slice(1 + escape(key).length)}`;
}

/** Every top-level state key a value reads or writes. */
function stateKeys(value: JsonValue | undefined, out: Set<string>): void {
  if (Array.isArray(value)) value.forEach((item) => stateKeys(item, out));
  else if (isRecord(value)) {
    for (const [key, inner] of Object.entries(value)) {
      if (PATH_KEYS.includes(key) && typeof inner === "string") {
        const top = topKey(inner);
        if (top !== null && top !== SCENARIO_STATE) out.add(top);
      } else if (key === "$template" && typeof inner === "string") {
        for (const match of inner.matchAll(/\$\{(\/[^}]*)\}/g)) {
          const top = topKey(match[1] ?? "");
          if (top !== null && top !== SCENARIO_STATE) out.add(top);
        }
      }
      stateKeys(inner, out);
    }
  }
}

/** A value with its state paths renamed. */
function renameState(value: JsonValue, renames: ReadonlyMap<string, string>): JsonValue {
  if (renames.size === 0) return value;
  if (Array.isArray(value)) return value.map((item) => renameState(item, renames));
  if (!isRecord(value)) return value;
  const out: Record<string, JsonValue> = {};
  for (const [key, inner] of Object.entries(value)) {
    if (PATH_KEYS.includes(key) && typeof inner === "string") out[key] = renamePath(inner, renames);
    else if (key === "$template" && typeof inner === "string") out[key] = inner.replace(/\$\{(\/[^}]*)\}/g, (_, path: string) => `\${${renamePath(path, renames)}}`);
    else out[key] = renameState(inner, renames);
  }
  return out;
}

function keyList(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** The keys an element lists: its named slots (in name order), then its children. */
function listed(element: Element): string[] {
  const slots = isRecord(element.slots) ? element.slots : {};
  return [...Object.keys(slots).sort(compare).flatMap((slot) => keyList(slots[slot])), ...keyList(element.children)];
}

function readSource(name: string, text: string): Result<Source, string> {
  const parsed = parseJson(text);
  if (!parsed.ok) return { ok: false, error: `${name} does not parse as JSON: it ${parsed.message} at line ${parsed.at.line}` };
  const value = parsed.value;
  const elements = isRecord(value) && isRecord(value.elements) ? value.elements : null;
  const root = isRecord(value) && typeof value.root === "string" ? value.root : null;
  const rootElement = root !== null && elements && isRecord(elements[root]) ? (elements[root] as Element) : null;
  if (!elements || root === null || !rootElement || rootElement.type !== PAGE_TYPE) return { ok: false, error: `${name} is not a page spec: its root is not a Page` };
  return { ok: true, value: { name, root, rootElement, elements: elements as Record<string, Element>, state: isRecord(value) && isRecord(value.state) ? value.state : {} } };
}

/**
 * One page recombined from named sources, each a whole page spec: `picks`
 * names, for every slot of the page's type, the source it comes from.
 * Refused when the page is not a spec page of the prototype, a slot of its
 * type has no pick, a pick names a slot the type lacks or a source not
 * given, or a source used is not a page spec.
 */
export function recombine(prototype: Prototype, config: ProjectConfig, page: string, sources: Readonly<Record<string, string>>, picks: Readonly<Record<string, string>>): Result<Recombination, string> {
  const entry = prototype.pages.find((item) => item.id === page);
  const type = entry ? config.inventories.pageTypes.find((item) => item.id === entry.pageType) : undefined;
  if (!entry || !type) return { ok: false, error: `There is no page "${page}" of an inventoried page type.` };
  const extra = Object.keys(picks).filter((slot) => !type.slots.includes(slot)).sort(compare);
  if (extra.length > 0) return { ok: false, error: `A ${type.id} page has no slot ${extra.map((slot) => `"${slot}"`).join(", ")}.` };
  const missing = type.slots.filter((slot) => picks[slot] === undefined);
  if (missing.length > 0) return { ok: false, error: `Say where slot ${missing.map((slot) => `"${slot}"`).join(", ")} comes from.` };
  const slots: Record<string, string> = Object.fromEntries(type.slots.map((slot) => [slot, picks[slot] as string]));
  const used = [...new Set(Object.values(slots))].sort(compare);
  const read = new Map<string, Source>();
  for (const name of used) {
    if (sources[name] === undefined) return { ok: false, error: `No source "${name}" was given.` };
    const source = readSource(name, sources[name] as string);
    if (!source.ok) return source;
    read.set(name, source.value);
  }
  const single = used.length === 1 ? read.get(used[0] as string) : undefined;

  // What each source brings: per slot, the listed keys and everything under them, in order.
  const brought = new Map<string, string[]>();
  const slotKeys = new Map<string, string[]>();
  for (const slot of type.slots) {
    const source = read.get(slots[slot] as string) as Source;
    const rootSlots = isRecord(source.rootElement.slots) ? source.rootElement.slots : {};
    const keys = keyList(rootSlots[slot]).filter((key) => isRecord(source.elements[key]) && key !== source.root);
    slotKeys.set(slot, keys);
    const list = brought.get(source.name) ?? [];
    const visit = (key: string) => {
      if (list.includes(key) || key === source.root || !isRecord(source.elements[key])) return;
      list.push(key);
      listed(source.elements[key] as Element).forEach(visit);
    };
    keys.forEach(visit);
    brought.set(source.name, list);
  }
  if (single) {
    // Every element of the one source, those outside the slots and any nothing lists included.
    const list = brought.get(single.name) as string[];
    const visit = (key: string) => {
      if (list.includes(key) || key === single.root || !isRecord(single.elements[key])) return;
      list.push(key);
      listed(single.elements[key] as Element).forEach(visit);
    };
    keyList(single.rootElement.children).forEach(visit);
    Object.keys(single.elements).sort(compare).forEach(visit);
  }
  const rootKey = single ? single.root : "page";
  const renamed: Rename[] = [];

  // Element keys: one that two sources bring (or that is the root's) is named for its source in each.
  const owners = new Map<string, string[]>();
  for (const [name, keys] of brought) for (const key of keys) owners.set(key, [...(owners.get(key) ?? []), name]);
  const taken = new Set<string>([rootKey, ...[...owners.entries()].filter(([key, names]) => names.length === 1 && key !== rootKey).map(([key]) => key)]);
  const keyMaps = new Map<string, Map<string, string>>(used.map((name) => [name, new Map()]));
  for (const key of [...owners.keys()].sort(compare)) {
    const names = (owners.get(key) as string[]).sort(compare);
    if (names.length === 1 && key !== rootKey) {
      keyMaps.get(names[0] as string)?.set(key, key);
      continue;
    }
    for (const name of names) {
      let to = `${key}-${name}`;
      for (let n = 2; taken.has(to); n += 1) to = `${key}-${name}-${n}`;
      taken.add(to);
      keyMaps.get(name)?.set(key, to);
      renamed.push({ kind: "element", source: name, from: key, to });
    }
  }

  // Literal ids: one that two sources use is named for its source in each.
  const idOwners = new Map<string, Set<string>>();
  for (const [name, keys] of brought) {
    const source = read.get(name) as Source;
    for (const key of keys) {
      const props = (source.elements[key] as Element).props;
      if (!isRecord(props)) continue;
      for (const prop of ID_PROPS) if (typeof props[prop] === "string") idOwners.set(props[prop] as string, (idOwners.get(props[prop] as string) ?? new Set()).add(name));
    }
  }
  const idMaps = new Map<string, Map<string, string>>(used.map((name) => [name, new Map()]));
  for (const id of [...idOwners.keys()].sort(compare)) {
    const names = [...(idOwners.get(id) as Set<string>)].sort(compare);
    if (names.length < 2) continue;
    for (const name of names) {
      idMaps.get(name)?.set(id, `${id}-${name}`);
      renamed.push({ kind: "id", source: name, from: id, to: `${id}-${name}` });
    }
  }

  // State: what each source's elements read, and the keys whose values differ between the sources that read them.
  const reads = new Map<string, Set<string>>();
  for (const [name, keys] of brought) {
    const source = read.get(name) as Source;
    const out = new Set<string>();
    for (const key of keys) stateKeys(source.elements[key] as JsonValue, out);
    reads.set(name, out);
  }
  const state: Record<string, JsonValue> = {};
  const stateMaps = new Map<string, Map<string, string>>(used.map((name) => [name, new Map()]));
  const allKeys = [...new Set(used.flatMap((name) => [...Object.keys((read.get(name) as Source).state), ...(reads.get(name) ?? [])]))].sort(compare);
  const stateTaken = new Set(allKeys);
  for (const key of allKeys) {
    const readers = used.filter((name) => reads.get(name)?.has(key));
    const holders = (readers.length > 0 ? readers : used).filter((name) => Object.hasOwn((read.get(name) as Source).state, key));
    const values = new Map<string, JsonValue>();
    for (const name of holders) values.set(canonical((read.get(name) as Source).state[key] as JsonValue), (read.get(name) as Source).state[key] as JsonValue);
    if (values.size <= 1) {
      const [value] = values.values();
      if (value !== undefined) state[key] = value;
      continue;
    }
    // Differing values: shared by nobody. A key nothing reads is dropped; one that is read is named for each reader.
    for (const name of readers) {
      let to = `${key}-${name}`;
      for (let n = 2; stateTaken.has(to); n += 1) to = `${key}-${name}-${n}`;
      stateTaken.add(to);
      stateMaps.get(name)?.set(key, to);
      const value = (read.get(name) as Source).state[key];
      if (value !== undefined) state[to] = value;
      renamed.push({ kind: "state", source: name, from: key, to });
    }
  }

  // The page: its root, then each slot's elements in the page type's order, each source's renames applied.
  const elements: Record<string, JsonValue> = {};
  const rewrite = (name: string, key: string): JsonValue => {
    const source = read.get(name) as Source;
    const keys = keyMaps.get(name) as Map<string, string>;
    const ids = idMaps.get(name) as Map<string, string>;
    const element = renameState(source.elements[key] as JsonValue, stateMaps.get(name) as Map<string, string>) as Element;
    const mapKeys = (list: JsonValue | undefined) => (Array.isArray(list) ? list.map((item) => (typeof item === "string" ? (keys.get(item) ?? item) : item)) : list);
    const out: Record<string, JsonValue> = {};
    for (const field of [...FIELD_ORDER.filter((name) => name in element), ...Object.keys(element).filter((name) => !FIELD_ORDER.includes(name)).sort(compare)]) {
      const value = element[field] as JsonValue;
      if (field === "props" && isRecord(value)) {
        out.props = sortedRecord(Object.fromEntries(Object.entries(value).map(([prop, inner]) => [prop, ID_PROPS.includes(prop) && typeof inner === "string" ? (ids.get(inner) ?? inner) : inner]))) as JsonValue;
      } else if (field === "children") out.children = mapKeys(value) as JsonValue;
      else if (field === "slots" && isRecord(value)) out.slots = Object.fromEntries(Object.keys(value).sort(compare).map((slot) => [slot, mapKeys(value[slot]) as JsonValue]));
      else out[field] = value;
    }
    return out;
  };
  const rootSlots: Record<string, JsonValue> = {};
  for (const slot of type.slots) {
    const name = slots[slot] as string;
    rootSlots[slot] = (slotKeys.get(slot) ?? []).map((key) => keyMaps.get(name)?.get(key) ?? key);
  }
  const rootChildren = single ? keyList(single.rootElement.children).filter((key) => key !== single.root).map((key) => keyMaps.get(single.name)?.get(key) ?? key) : [];
  const rootProps = single && isRecord(single.rootElement.props) ? sortedRecord(single.rootElement.props) : {};
  elements[rootKey] = { type: PAGE_TYPE, props: rootProps, children: rootChildren, slots: rootSlots };
  for (const name of used) for (const key of brought.get(name) ?? []) elements[keyMaps.get(name)?.get(key) ?? key] = rewrite(name, key);
  // Elements in slot order: what each slot holds, depth first, as the page reads.
  const ordered: Record<string, JsonValue> = { [rootKey]: elements[rootKey] as JsonValue };
  const place = (key: string) => {
    if (key in ordered || !(key in elements)) return;
    ordered[key] = elements[key] as JsonValue;
    listed(elements[key] as Element).forEach(place);
  };
  for (const slot of type.slots) keyList(rootSlots[slot]).forEach(place);
  rootChildren.forEach(place);
  Object.keys(elements).sort(compare).forEach(place);

  const spec: Record<string, JsonValue> = { root: rootKey, elements: ordered };
  if (Object.keys(state).length > 0) spec.state = sortedRecord(state);
  const text = formatSpec(spec);
  renamed.sort((a, b) => compare(a.kind, b.kind) || compare(a.source, b.source) || compare(a.from, b.from));
  const keys: Record<string, Record<string, string>> = {};
  for (const name of used) {
    const source = read.get(name) as Source;
    const map = keyMaps.get(name) as Map<string, string>;
    const own = new Map<string, string>([[source.root, rootKey]]);
    for (const key of brought.get(name) ?? []) own.set(key, map.get(key) ?? key);
    keys[name] = Object.fromEntries([...own.keys()].sort(compare).map((key) => [key, own.get(key) as string]));
  }
  return { ok: true, value: { spec: text, prototype: withPageSpec(prototype, page, text), slots, renamed, root: rootKey, keys } };
}

/**
 * Where an element of one source is in a recombined page: its key in the
 * result's expanded page, or null when the result does not hold it, because
 * no slot picked from that source reaches it. `key` is the element's key in
 * the source's expanded page, as a finding's target and an element tag give
 * it: a key of the page's file, `<instance>/<key>` for what a layout
 * instance draws, or `<root>/slots/<name>` for one of the page's slots. An
 * instance keeps what it draws under its own key, so only the first part of
 * a key is ever renamed. A slot is in the result when it was picked from
 * that source, and the page's root itself only when every slot was.
 */
export function recombinedKey(result: Pick<Recombination, "keys" | "root" | "slots">, source: string, key: string): string | null {
  const cut = key.indexOf("/");
  const head = cut < 0 ? key : key.slice(0, cut);
  const rest = cut < 0 ? "" : key.slice(cut);
  const own = result.keys[source];
  const to = own && Object.hasOwn(own, head) ? own[head] : undefined;
  if (to === undefined) return null;
  if (to !== result.root) return `${to}${rest}`;
  if (rest === "") return Object.values(result.slots).every((name) => name === source) ? to : null;
  const slot = rest.startsWith("/slots/") ? rest.slice("/slots/".length) : null;
  return slot !== null && Object.hasOwn(result.slots, slot) && result.slots[slot] === source ? `${to}${rest}` : null;
}
