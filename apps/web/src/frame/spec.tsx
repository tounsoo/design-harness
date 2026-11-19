import { Children, Component, createElement, Fragment, useMemo, useSyncExternalStore, type ComponentType, type ReactNode } from "react";
import { JSONUIProvider, Renderer, useBoundProp, type ComponentRegistry, type ComponentRenderProps } from "@json-render/react";
import type { SpecPart, SpecPayload } from "../runtime/protocol";
import { TAG_PROP } from "../runtime/tags";

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
 * when the spec binds one. A Page fills its slots with the kit's Slot. A
 * part that throws is reported to the frame through `onError`, so the frame
 * fails rather than measuring the page without it.
 *
 * With tags on, each part also gets the element tag prop
 * (`runtime/tags.ts`): its key in the expanded page, which carries the
 * layout instance's scope, and each of a Page's slots `<key>/slots/<name>`.
 * The frame finds what each drew in React's tree, so a part that does not
 * pass the prop on to the DOM is found all the same.
 */

type Slot = ComponentType<{ readonly name: string; readonly children?: ReactNode }>;

/** Where the renderer keeps an element's key on the element, since json-render hands a part its element but not its key. */
const KEY_FIELD = "dhKey";

/** An element's key, as the renderer stored it, when tags are on. */
function keyOf(element: object): string | undefined {
  const key = (element as Record<string, unknown>)[KEY_FIELD];
  return typeof key === "string" ? key : undefined;
}

/** The spec with each element's key stored on it, for the parts to tag themselves with. */
export function withKeys(spec: SpecPayload["spec"]): SpecPayload["spec"] {
  return { ...spec, elements: Object.fromEntries(Object.entries(spec.elements).map(([key, element]) => [key, { ...element, [KEY_FIELD]: key }])) };
}

function partOf(library: Readonly<Record<string, unknown>>, type: string): ComponentType<Record<string, unknown>> | null {
  let value: unknown = library;
  for (const name of type.split(".")) {
    if ((typeof value !== "object" && typeof value !== "function") || value === null || !Object.hasOwn(value, name)) return null;
    value = (value as Record<string, unknown>)[name];
  }
  return typeof value === "function" || (typeof value === "object" && value !== null) ? (value as ComponentType<Record<string, unknown>>) : null;
}

/**
 * Catches what one library part throws while it renders, before
 * json-render's own boundary would draw it as nothing and log it, and hands
 * it to the frame, which then reports the page as failing to render rather
 * than measuring a page with the part missing.
 */
class PartBoundary extends Component<{ readonly type: string; readonly onError: (error: Error) => void; readonly children?: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(error: unknown) {
    this.props.onError(new Error(`${this.props.type} could not render: ${error instanceof Error ? error.message : String(error)}`));
  }
  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

/** One bound prop: its value from state and the callback that writes it back. A hook, so each part calls it once per bindable prop, in a fixed order. */
function useBinding(props: Readonly<Record<string, unknown>>, bindings: Readonly<Record<string, string>> | undefined, prop: string): [unknown, ((value: unknown) => void) | undefined] {
  const [value, set] = useBoundProp<unknown>(props[prop], bindings?.[prop]);
  return [value, bindings?.[prop] !== undefined ? set : undefined];
}

function partRenderer(type: string, Part: ComponentType<Record<string, unknown>>, part: SpecPart, onError: (error: Error) => void): ComponentType<ComponentRenderProps> {
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
    const key = keyOf(element);
    if (key !== undefined) given[TAG_PROP] = key;
    let content: ReactNode = undefined;
    if (part.content === "children") {
      const text = typeof props.text === "string" || typeof props.text === "number" ? String(props.text) : null;
      content = text === null ? children : createElement(Fragment, null, text, children);
      // Nothing to put in it: no children at all, as a part such as an input may take none even when its types say it does.
      if (text === null && Children.count(children) === 0) content = undefined;
    } else if (part.content === "options" && Array.isArray(props.options)) {
      content = (props.options as { value?: unknown; label?: unknown }[]).map((option) => createElement("option", { key: String(option.value), value: String(option.value) }, String(option.label)));
    }
    return createElement(PartBoundary, { type, onError }, content === undefined ? createElement(Part, given) : createElement(Part, given, content));
  }
  return SpecPart;
}

/** A page drawn from a spec, and how to draw another spec in its place. */
export type SpecPage = ComponentType & { readonly redraw: (payload: SpecPayload) => void };

/**
 * The page component a frame mounts in the default shell: the spec, drawn by
 * json-render with a registry built from the library. A Page puts its slots
 * in the DOM in the page type's order (`slotOrder`), as code export writes
 * them, so headings and focus follow it; a slot the type lacks goes last.
 * `redraw` draws another spec of the same catalog in place, as React
 * updates: elements that stay keep their DOM. A change of the spec's
 * starting state remounts the state provider, so the draft's state shows.
 */
export function specPage(library: Readonly<Record<string, unknown>>, Slot: Slot, payload: SpecPayload, slotOrder: readonly string[], options: { readonly tags?: boolean; readonly onError?: (error: Error) => void } = {}): SpecPage {
  const rank = (name: string) => (slotOrder.includes(name) ? slotOrder.indexOf(name) : slotOrder.length);
  const registry: ComponentRegistry = {};
  for (const [type, part] of Object.entries(payload.parts)) {
    if (part.kind === "page") {
      registry[type] = function Page({ element, slots, children }: ComponentRenderProps) {
        const named = Object.keys(element.slots ?? {}).sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
        const key = keyOf(element);
        return createElement(Fragment, null, ...named.map((name) => createElement(Slot, { key: name, name, ...(key !== undefined ? { [TAG_PROP]: `${key}/slots/${name}` } : {}) }, slots?.[name])), children);
      };
      continue;
    }
    const Part = partOf(library, type);
    if (Part) registry[type] = partRenderer(type, Part, part, options.onError ?? (() => undefined));
  }
  let current = payload;
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  function SpecPage() {
    const shown = useSyncExternalStore(subscribe, () => current, () => current);
    const keyed = useMemo(() => (options.tags ? withKeys(shown.spec) : shown.spec), [shown.spec]);
    const spec = keyed as unknown as Parameters<typeof Renderer>[0]["spec"];
    return createElement(JSONUIProvider, { key: JSON.stringify(shown.spec.state), registry, initialState: shown.spec.state as Record<string, unknown>, children: createElement(Renderer, { spec, registry }) });
  }
  return Object.assign(SpecPage, {
    redraw(next: SpecPayload) {
      current = next;
      for (const listener of listeners) listener();
    },
  });
}
