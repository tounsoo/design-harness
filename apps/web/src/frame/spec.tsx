import { createElement, Fragment, useSyncExternalStore, type ComponentType, type ReactNode } from "react";
import { JSONUIProvider, Renderer, useBoundProp, type ComponentRegistry, type ComponentRenderProps } from "@json-render/react";
import type { SpecPart, SpecPayload } from "../runtime/protocol";

/**
 * `@design-harness/spec`, the spec renderer a frame loads for a spec
 * prototype. It turns the catalog's parts into a json-render registry over
 * the library the frame already imported, and draws the page's spec with
 * json-render's Renderer inside the page kit's default shell. No prototype
 * code runs: the spec is data the app sent, and the registry is the only
 * code that touches it.
 *
 * Each part is the library's own component, given only the props the
 * catalog lists for it (so a prop core refused, such as `style`, never
 * reaches the DOM even in a spec core did not pass), its `text` and child
 * elements, its options as `<option>`s when it takes them as data, a bound
 * prop's value and change callback, and an `onClick` that emits `press`
 * when the spec binds one. A Page fills its slots with the kit's Slot.
 */

type Slot = ComponentType<{ readonly name: string; readonly children?: ReactNode }>;

function partOf(library: Readonly<Record<string, unknown>>, type: string): ComponentType<Record<string, unknown>> | null {
  let value: unknown = library;
  for (const name of type.split(".")) {
    if ((typeof value !== "object" && typeof value !== "function") || value === null || !Object.hasOwn(value, name)) return null;
    value = (value as Record<string, unknown>)[name];
  }
  return typeof value === "function" || (typeof value === "object" && value !== null) ? (value as ComponentType<Record<string, unknown>>) : null;
}

/** One bound prop: its value from state and the callback that writes it back. A hook, so each part calls it once per bindable prop, in a fixed order. */
function useBinding(props: Readonly<Record<string, unknown>>, bindings: Readonly<Record<string, string>> | undefined, prop: string): [unknown, ((value: unknown) => void) | undefined] {
  const [value, set] = useBoundProp<unknown>(props[prop], bindings?.[prop]);
  return [value, bindings?.[prop] !== undefined ? set : undefined];
}

function partRenderer(Part: ComponentType<Record<string, unknown>>, part: SpecPart): ComponentType<ComponentRenderProps> {
  const bindable = Object.keys(part.binds).sort();
  function SpecPart({ element, children, emit, on, bindings }: ComponentRenderProps) {
    const props = element.props as Readonly<Record<string, unknown>>;
    const given: Record<string, unknown> = {};
    for (const name of part.props) if (props[name] !== undefined && props[name] !== null) given[name] = props[name];
    for (const name of bindable) {
      // Hooks in a loop over a list fixed per part, so the order never changes between renders.
      const [value, set] = useBinding(props, bindings, name);
      if (set) {
        given[name] = value;
        given[part.binds[name] as string] = set;
      }
    }
    if (part.events.includes("press") && on("press").bound) given.onClick = () => emit("press");
    let content: ReactNode = undefined;
    if (part.content === "children") {
      const text = typeof props.text === "string" || typeof props.text === "number" ? String(props.text) : null;
      content = text === null ? children : createElement(Fragment, null, text, children);
    } else if (part.content === "options" && Array.isArray(props.options)) {
      content = (props.options as { value?: unknown; label?: unknown }[]).map((option) => createElement("option", { key: String(option.value), value: String(option.value) }, String(option.label)));
    }
    return createElement(Part, given, content);
  }
  return SpecPart;
}

/** A page drawn from a spec, and how to draw another spec in its place. */
export type SpecPage = ComponentType & { readonly redraw: (payload: SpecPayload) => void };

/**
 * The page component a frame mounts in the default shell: the spec, drawn by
 * json-render with a registry built from the library. A Page puts its slots
 * in the DOM in the page type's order (`slotOrder`), as a TSX page writes
 * them, so headings and focus follow it; a slot the type lacks goes last.
 * `redraw` draws another spec of the same catalog in place, as React
 * updates: elements that stay keep their DOM. A change of the spec's
 * starting state remounts the state provider, so the draft's state shows.
 */
export function specPage(library: Readonly<Record<string, unknown>>, Slot: Slot, payload: SpecPayload, slotOrder: readonly string[]): SpecPage {
  const rank = (name: string) => (slotOrder.includes(name) ? slotOrder.indexOf(name) : slotOrder.length);
  const registry: ComponentRegistry = {};
  for (const [type, part] of Object.entries(payload.parts)) {
    if (part.kind === "page") {
      registry[type] = function Page({ element, slots, children }: ComponentRenderProps) {
        const named = Object.keys(element.slots ?? {}).sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
        return createElement(Fragment, null, ...named.map((name) => createElement(Slot, { key: name, name }, slots?.[name])), children);
      };
      continue;
    }
    const Part = partOf(library, type);
    if (Part) registry[type] = partRenderer(Part, part);
  }
  let current = payload;
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  function SpecPage() {
    const shown = useSyncExternalStore(subscribe, () => current);
    const spec = shown.spec as unknown as Parameters<typeof Renderer>[0]["spec"];
    return createElement(JSONUIProvider, { key: JSON.stringify(shown.spec.state), registry, initialState: shown.spec.state as Record<string, unknown>, children: createElement(Renderer, { spec, registry }) });
  }
  return Object.assign(SpecPage, {
    redraw(next: SpecPayload) {
      current = next;
      for (const listener of listeners) listener();
    },
  });
}
