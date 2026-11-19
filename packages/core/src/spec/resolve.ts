import type { ProjectConfig } from "../config/types";
import type { Prototype, Scenario } from "../prototype/types";
import { SCENARIO_STATE } from "./catalog";
import { expandPage, type ExpandedPage } from "./expand";
import type { JsonValue } from "./json";
import { readSpecs } from "./read";

/** A json-render spec as a renderer draws it: flat elements by key, from `root`, with the state it starts in. */
export type FlatSpec = {
  readonly root: string;
  readonly elements: { readonly [key: string]: { readonly type: string; readonly props: { readonly [key: string]: JsonValue }; readonly children: readonly string[]; readonly slots?: { readonly [slot: string]: readonly string[] }; readonly visible?: JsonValue; readonly repeat?: JsonValue; readonly on?: JsonValue } };
  readonly state: { readonly [key: string]: JsonValue };
};

/**
 * An expanded page as one json-render spec: each layout instance replaced by
 * the layout's root, expanded with its parameters (an instance's `visible`
 * joins its root's with `$and`), and only the elements that passed
 * validation. Null when nothing renders.
 */
export function flatSpecOf(page: ExpandedPage, state: { readonly [key: string]: JsonValue }): FlatSpec | null {
  const elements: Record<string, FlatSpec["elements"][string]> = {};
  const draw = (key: string, visible: JsonValue | undefined): string | null => {
    const element = page.elements.get(key);
    if (!element) return null;
    // json-render's list form holds single conditions only, so two conditions join with $and, which takes any.
    const both = (own: JsonValue | undefined): JsonValue | undefined => (visible === undefined || visible === true ? own : own === undefined || own === true ? visible : visible === false || own === false ? false : { $and: [visible, own] });
    if (element.layout !== undefined) {
      const [root] = element.children;
      return root === undefined ? null : draw(root, both(element.visible));
    }
    const list = (keys: readonly string[]) => keys.map((child) => draw(child, undefined)).filter((child): child is string => child !== null);
    const own = both(element.visible);
    const slots = element.slots ? Object.fromEntries(Object.entries(element.slots).map(([slot, keys]) => [slot, list(keys)])) : undefined;
    elements[key] = {
      type: element.type,
      props: element.props,
      children: list(element.children),
      ...(slots ? { slots } : {}),
      ...(own !== undefined ? { visible: own } : {}),
      ...(element.repeat ? { repeat: element.repeat as unknown as JsonValue } : {}),
      ...(element.on ? { on: element.on as unknown as JsonValue } : {}),
    };
    return key;
  };
  const root = draw(page.root, undefined);
  return root === null ? null : { root, elements, state };
}

/**
 * One page of a spec prototype as one json-render spec, for one scenario:
 * every layout instance expanded in place (each under keys of its own, so a
 * layout drawn twice is two copies), only the elements that passed
 * validation, and the page's state with `scenario` set to `{ id, state }`.
 * This is exactly what core checked, and all a frame needs: data, no code,
 * and no parameter left to resolve. Null when the page's spec could not be
 * read.
 */
export function resolvePageSpec(prototype: Prototype, config: ProjectConfig, scenario: Scenario): FlatSpec | null {
  const page = prototype.pages.find((item) => item.id === scenario.page);
  if (!page) return null;
  const { page: expanded } = expandPage(page, readSpecs(prototype, config), prototype);
  if (!expanded) return null;
  return flatSpecOf(expanded, { ...expanded.state, [SCENARIO_STATE]: { id: scenario.id, state: scenario.state } });
}
