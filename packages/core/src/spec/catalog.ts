import type { PartDescription, ProjectConfig, PropSchema } from "../config/types";
import { ROLE_NAMES, type RoleName } from "../rules/types";

/**
 * The catalog a spec prototype is written from, generated from the project
 * config: the parts of every inventoried component that a spec can render,
 * plus two of the harness's own, `Page` (a page spec's root, whose named
 * slots are the page type's) and `Layout` (a registered layout, by id).
 *
 * It is data, like the config, and the one source for three things: core's
 * validation of a spec, the agent's instructions (the web app turns it into
 * a json-render catalog and asks it for its prompt), and the frame's
 * registry, which renders only what the catalog lists and passes a part
 * only the props the catalog gives it. A part the inventory does not list is
 * not in the catalog, so a spec cannot name it.
 */

export const PAGE_TYPE = "Page";
export const LAYOUT_TYPE = "Layout";
/** The prop a part's own text goes in: a spec holds no text nodes, so text is data on the element. */
export const TEXT_PROP = "text";
/** The state a page reads its scenario from: `{ "$state": "/scenario/state" }` is the flow state, `/scenario/id` the scenario. */
export const SCENARIO_STATE = "scenario";
/** The actions a spec may bind to an event. They change only the frame's own state. */
export const SPEC_ACTIONS = ["setState", "pushState", "removeState"] as const;

export type CatalogComponent = {
  readonly kind: "part" | "page" | "layout";
  readonly description: string;
  /** Every prop a spec may set, `text` included where the part takes text. */
  readonly props: Readonly<Record<string, PropSchema>>;
  /** `default` when it takes child elements; a page's named slots; none for a leaf. */
  readonly slots: readonly string[];
  readonly content: PartDescription["content"];
  readonly events: readonly "press"[];
  /** The roles this part can have, from the library's role mapping. */
  readonly roles: readonly RoleName[];
};

export type SpecCatalog = {
  readonly components: Readonly<Record<string, CatalogComponent>>;
  /** Inventoried components with no part a spec can render, and why. */
  readonly left: readonly { readonly component: string; readonly why: string }[];
};

const TEXT: PropSchema = { type: "string", required: false };

function roleWords(part: string, config: ProjectConfig): { roles: RoleName[]; words: string[] } {
  const roles: RoleName[] = [];
  const words: string[] = [];
  for (const role of ROLE_NAMES) {
    const mapping = config.library.roles[role];
    if (!mapping.components.includes(part)) continue;
    roles.push(role);
    const name = role.replace(/-/g, " ");
    if (!mapping.prop) words.push(`It is a ${name}.`);
    else {
      const values = mapping.prop.values.map((value) => JSON.stringify(value)).join(" or ");
      words.push(`With ${mapping.prop.name} ${values}${mapping.prop.whenMissing ? ` (or no ${mapping.prop.name})` : ""}, it is a ${name}.`);
    }
  }
  return { roles, words };
}

/** The catalog for a project, or null when its library has no part descriptions. Pure: the same config gives the same catalog, keys in code-unit order. */
export function specCatalog(config: ProjectConfig): SpecCatalog | null {
  const parts = config.library.parts;
  if (!parts) return null;
  const components: Record<string, CatalogComponent> = {};
  const left: { component: string; why: string }[] = [];
  const inventory = new Set(config.inventories.components);
  for (const component of [...inventory].sort()) {
    const names = Object.keys(parts).filter((name) => name.split(".")[0] === component).sort();
    if (names.length === 0) left.push({ component, why: `${config.library.package} ${config.library.version} has no part of ${component} described` });
    for (const name of names) {
      const part = parts[name] as PartDescription;
      if (part.needs && part.needs.length > 0) {
        left.push({ component: name, why: `it needs ${part.needs.map((need) => `"${need}"`).join(", ")}, which a spec cannot give` });
        continue;
      }
      const { roles, words } = roleWords(name, config);
      const props: Record<string, PropSchema> = { ...part.props };
      if (part.content === "children") props[TEXT_PROP] = TEXT;
      // A press is what an action does; other parts are not pressed, whatever DOM events they pass on.
      const events = roles.includes("action") && part.events?.includes("press") ? (["press"] as const) : [];
      const takes = part.content === "children" ? " It takes text in its text prop and child elements." : part.content === "options" ? " Its options are data: a list of { value, label }." : "";
      components[name] = {
        kind: "part",
        description: `${name} from ${config.library.package}.${takes}${words.length > 0 ? ` ${words.join(" ")}` : ""}`,
        props: sortKeys(props),
        slots: part.content === "children" ? ["default"] : [],
        content: part.content,
        events,
        roles,
      };
    }
  }
  const slots = [...new Set(config.inventories.pageTypes.flatMap((type) => type.slots))].sort();
  const pageTypes = config.inventories.pageTypes.map((type) => `${type.id} (${type.slots.join(", ")})`).join("; ");
  components[PAGE_TYPE] = {
    kind: "page",
    description: `The root of a page spec, and only that. Its named slots are its page type's: ${pageTypes}. Put each element of the page in one of them.`,
    props: {},
    slots,
    content: "none",
    events: [],
    roles: [],
  };
  components[LAYOUT_TYPE] = {
    kind: "layout",
    description: `A registered layout, drawn in place: props.id names one of the prototype's layouts (inventoried: ${config.inventories.layouts.join(", ") || "none"}). It reads the page's state.`,
    props: { id: { type: "string", required: true } },
    slots: [],
    content: "none",
    events: [],
    roles: [],
  };
  return { components: sortKeys(components), left };
}

function sortKeys<T>(record: Readonly<Record<string, T>>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
