import type { ProjectConfig } from "../config/types";
import type { Prototype } from "../prototype/types";
import { LAYOUT_TYPE, PAGE_TYPE } from "./catalog";
import type { JsonValue } from "./json";
import { LAYOUT_ID_PROP, describeParam, type LayoutParam } from "./params";
import { locateIn, readSpecs } from "./read";

/**
 * A spec prototype's layouts as data for people and the agent: each one
 * with its parameters in words and where the prototype uses it, and a
 * one-page prototype that draws a layout alone with its example values,
 * which the app renders as the layout's preview. Read from core's own
 * reading of the files, so what is listed is what is checked.
 */

export type ParamSummary = {
  readonly name: string;
  readonly type: LayoutParam["type"];
  readonly required: boolean;
  /** The type in words: "text", "a list of texts", "one of ..."... */
  readonly words: string;
  readonly description?: string;
  readonly default?: JsonValue;
  readonly example?: JsonValue;
};

export type LayoutSummary = {
  readonly id: string;
  readonly file: string;
  readonly inventoried: boolean;
  /** Its parameters, by name. */
  readonly params: readonly ParamSummary[];
  /** Every instance of it in the prototype's files: the file, the element's key and its line. */
  readonly uses: readonly { readonly file: string; readonly key: string; readonly line: number }[];
};

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Every manifest layout of a spec prototype, by id, with its parameters and uses. Pure. */
export function specLayouts(prototype: Prototype, config: ProjectConfig): LayoutSummary[] {
  const read = readSpecs(prototype, config);
  const uses = new Map<string, { file: string; key: string; line: number }[]>();
  for (const doc of [...read.docs.values()].sort((a, b) => compare(a.file, b.file))) {
    for (const element of [...doc.elements.values()].sort((a, b) => compare(a.key, b.key))) {
      const id = element.type === LAYOUT_TYPE ? element.props[LAYOUT_ID_PROP] : undefined;
      if (typeof id !== "string") continue;
      const list = uses.get(id) ?? [];
      list.push({ file: doc.file, key: element.key, line: locateIn(doc.file, doc.positions, ["elements", element.key]).line });
      uses.set(id, list);
    }
  }
  return [...prototype.layouts]
    .sort((a, b) => compare(a.id, b.id))
    .map((layout) => {
      const params = read.layouts.get(layout.id) ?? {};
      return {
        id: layout.id,
        file: layout.component.file,
        inventoried: config.inventories.layouts.includes(layout.id),
        params: Object.keys(params)
          .sort(compare)
          .map((name): ParamSummary => {
            const param = params[name] as LayoutParam;
            return {
              name,
              type: param.type,
              required: param.required,
              words: describeParam(param),
              ...(param.description !== undefined ? { description: param.description } : {}),
              ...("default" in param && param.default !== undefined ? { default: param.default } : {}),
              ...(param.example !== undefined ? { example: param.example } : {}),
            };
          }),
        uses: uses.get(layout.id) ?? [],
      };
    });
}

/** Where a layout's preview page is written, beside the prototype's own files. */
export const PREVIEW_FILE = "preview/layout.json";
export const PREVIEW_PAGE = "layout-preview";
/** Where a preview's bindings write, in the preview page's state. */
const PREVIEW_STATE = "preview";

/**
 * A one-page prototype that draws layout `id` alone, in the body of the
 * first page type that has a body slot, with each parameter's example (or
 * default) as its value. A binding writes to `/preview/<name>`, which starts
 * empty; a slot stays
 * empty; the page's state is the state of the first page that uses the
 * layout, since a layout may read it. `missing` names each required
 * parameter with no example or default, which the preview leaves out.
 * Null when there is no such layout or no page type with a body.
 */
export function layoutPreview(prototype: Prototype, config: ProjectConfig, id: string): { readonly prototype: Prototype; readonly missing: readonly string[] } | null {
  const layout = prototype.layouts.find((item) => item.id === id);
  const pageType = config.inventories.pageTypes.find((type) => type.slots.some((slot) => !type.chrome.includes(slot) && (type.kind !== "action" || slot !== type.primarySlot)));
  if (!layout || !pageType) return null;
  const body = pageType.slots.find((slot) => !pageType.chrome.includes(slot) && (pageType.kind !== "action" || slot !== pageType.primarySlot)) as string;
  const read = readSpecs(prototype, config);
  const params = read.layouts.get(id) ?? {};
  const props: Record<string, JsonValue> = { [LAYOUT_ID_PROP]: id };
  const bound: Record<string, JsonValue> = {};
  const missing: string[] = [];
  for (const name of Object.keys(params).sort(compare)) {
    const param = params[name] as LayoutParam;
    if (param.type === "slot") continue;
    if (param.type === "binding") {
      props[name] = { $bindState: `/${PREVIEW_STATE}/${name}` };
      bound[name] = "";
    }
    else if (param.example !== undefined) props[name] = param.example;
    else if (!("default" in param && param.default !== undefined) && param.required) missing.push(name);
  }
  const user = [...read.docs.values()].sort((a, b) => compare(a.file, b.file)).find((doc) => doc.role === "page" && [...doc.elements.values()].some((element) => element.type === LAYOUT_TYPE && element.props[LAYOUT_ID_PROP] === id));
  const spec = {
    root: "page",
    elements: {
      page: { type: PAGE_TYPE, props: {}, slots: { [body]: ["layout"] }, children: [] },
      layout: { type: LAYOUT_TYPE, props, children: [] },
    },
    state: { ...(user?.state ?? {}), ...(Object.keys(bound).length > 0 ? { [PREVIEW_STATE]: bound } : {}) },
  };
  const state = prototype.flow.states[0] ?? config.inventories.flowStates[0] ?? "preview";
  return {
    prototype: {
      format: "spec",
      // The layouts' files and the preview page only: the prototype's pages are not drawn here.
      files: { ...Object.fromEntries(prototype.layouts.flatMap((entry) => (prototype.files[entry.component.file] === undefined ? [] : [[entry.component.file, prototype.files[entry.component.file] as string]]))), [PREVIEW_FILE]: `${JSON.stringify(spec, null, 2)}\n` },
      pages: [{ id: PREVIEW_PAGE, pageType: pageType.id, component: { file: PREVIEW_FILE, export: "default" } }],
      layouts: prototype.layouts,
      scenarios: [{ id: PREVIEW_PAGE, state, page: PREVIEW_PAGE }],
      flow: { states: [state], tasks: [] },
    },
    missing,
  };
}
