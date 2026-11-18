import type { ProjectConfig } from "../config/types";
import type { Prototype, Scenario } from "../prototype/types";
import { LAYOUT_TYPE, SCENARIO_STATE } from "./catalog";
import type { JsonValue } from "./json";
import { readSpecs, type SpecDoc } from "./read";

/** A json-render spec as a renderer draws it: flat elements by key, from `root`, with the state it starts in. */
export type FlatSpec = {
  readonly root: string;
  readonly elements: { readonly [key: string]: { readonly type: string; readonly props: { readonly [key: string]: JsonValue }; readonly children: readonly string[]; readonly slots?: { readonly [slot: string]: readonly string[] }; readonly visible?: JsonValue; readonly repeat?: JsonValue; readonly on?: JsonValue } };
  readonly state: { readonly [key: string]: JsonValue };
};

/**
 * One page of a spec prototype as one json-render spec, for one scenario:
 * each Layout drawn in place (its elements copied in under keys of their
 * own, so a layout drawn twice is two copies), only the elements that passed
 * validation, and the page's state with `scenario` set to `{ id, state }`.
 * This is exactly what core checked, and all a frame needs: data, no code.
 * Null when the page's spec could not be read.
 */
export function resolvePageSpec(prototype: Prototype, config: ProjectConfig, scenario: Scenario): FlatSpec | null {
  const page = prototype.pages.find((item) => item.id === scenario.page);
  if (!page) return null;
  const { docs } = readSpecs(prototype, config);
  const doc = docs.get(page.component.file);
  if (!doc || !doc.elements.has(doc.root)) return null;
  const elements: Record<string, FlatSpec["elements"][string]> = {};
  const layoutDoc = (id: string): SpecDoc | undefined => {
    const entry = prototype.layouts.find((layout) => layout.id === id);
    return entry ? docs.get(entry.component.file) : undefined;
  };

  /** Copies `key` of `from` in under `prefix`, and returns the key it now has, or null when it renders nothing. */
  const copy = (from: SpecDoc, key: string, prefix: string, drawing: readonly string[], visible: JsonValue | undefined): string | null => {
    const element = from.elements.get(key);
    if (!element) return null;
    const both = (own: JsonValue | undefined): JsonValue | undefined => (visible === undefined ? own : own === undefined ? visible : [visible, own]);
    if (element.type === LAYOUT_TYPE) {
      const id = typeof element.props.id === "string" ? element.props.id : "";
      const layout = layoutDoc(id);
      if (!layout || drawing.includes(id)) return null;
      return copy(layout, layout.root, `${prefix}${key}>`, [...drawing, id], both(element.visible));
    }
    const list = (keys: readonly string[]) => keys.map((child) => copy(from, child, prefix, drawing, undefined)).filter((child): child is string => child !== null);
    const own = both(element.visible);
    const slots = element.slots ? Object.fromEntries(Object.entries(element.slots).map(([slot, keys]) => [slot, list(keys)])) : undefined;
    const out = `${prefix}${key}`;
    elements[out] = {
      type: element.type,
      props: element.props,
      children: list(element.children),
      ...(slots ? { slots } : {}),
      ...(own !== undefined ? { visible: own } : {}),
      ...(element.repeat ? { repeat: element.repeat as unknown as JsonValue } : {}),
      ...(element.on ? { on: element.on as unknown as JsonValue } : {}),
    };
    return out;
  };
  const root = copy(doc, doc.root, "", [], undefined);
  if (root === null) return null;
  return { root, elements, state: { ...(doc.state ?? {}), [SCENARIO_STATE]: { id: scenario.id, state: scenario.state } } };
}
