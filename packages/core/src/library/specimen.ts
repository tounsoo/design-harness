import type { PartDescription, ProjectConfig, RoleMapping } from "../config/types";
import type { Prototype } from "../prototype/types";
import { ROLE_NAMES, type Literal, type RoleName } from "../rules/types";
import { composer, familyOf, rootOf, type LibrarySetup } from "./project";
import type { LibraryDescription } from "./roles";

/**
 * A specimen of one inventoried component: a one-page spec prototype, and a
 * config to render it with, that draws the component's parts with the
 * project's own library, so a person sees what "Disclosure" is and which of
 * its parts the rules know by a role. Everything is generated from the
 * project config: `library.parts` (what each part takes), `library.roles`
 * (which part and prop value carries each role) and `inputs.ranking` (the
 * ranked actions, written on the parts of their level). No config field
 * says how to draw a part.
 *
 * It is a picture: its config has no rules and nothing checks it. It fails
 * closed: a component whose parts a spec cannot give what they need has no
 * specimen, with the reason in words, and an app then shows the name alone.
 *
 * The composition is read from part names, as `rolePreview`'s is (the two
 * share `composer`): a root around its header, title, body and footer, a
 * table's head and rows, a heading and a paragraph. A part that only lays
 * out what it holds (`Stack`, `Group`) draws no ink, so it is drawn holding
 * three of the library's own small parts, and `standIn` names them.
 */

/** One thing the specimen draws on a row of its own, in the order drawn. */
export type SpecimenSample = {
  /** The text the sample reads, by which a person finds it in the picture. */
  readonly label: string;
  /** The part drawn. */
  readonly part: string;
  /** The roles the sample carries, each with how the library marks it: a part's name, or a prop's value. */
  readonly roles: readonly { readonly role: RoleName; readonly how: string }[];
  /** The rank of the project's ranked action the sample is written with, when it is one. */
  readonly rank?: number;
};

export type PartSpecimen =
  | {
      readonly ok: true;
      readonly component: string;
      readonly config: ProjectConfig;
      readonly prototype: Prototype;
      readonly samples: readonly SpecimenSample[];
      /** How many parts the library has for this component. */
      readonly parts: number;
      /** For a part that only lays out what it holds: the part its three stand-in children are. */
      readonly standIn?: string;
    }
  | { readonly ok: false; readonly component: string; readonly why: string; readonly parts: number };

/** Parts that place what they hold and paint nothing themselves, by family name. */
const LAYOUT_FAMILIES = ["Stack", "Group", "Flex", "Grid", "SimpleGrid", "Box", "Container", "Center", "Inline", "Row", "Column", "HStack", "VStack"];
/** What a layout part is drawn holding: the first of these the library has, else its text part. */
const STAND_IN_FAMILIES = ["Badge", "Chip", "Tag", "Card", "Paper"];
/** A family's members a root is drawn around, in this order, each reading its own name. */
const INNER_MEMBERS = ["Header", "Title", "Description", "Body", "Content", "Section", "Footer"];
/** How many values of a prop are drawn before the rest are left to the count. */
const MOST_VALUES = 8;

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const ACTION_ROLES = ["action", "primary-action", "secondary-action"] as const satisfies readonly RoleName[];

/** How a role's mapping marks one part: by the part alone, or by a prop's values. */
function how(mapping: RoleMapping, part: string): string {
  if (!mapping.prop) return part;
  return `${mapping.prop.name} ${mapping.prop.values.map((value) => String(value)).join(" or ")}${mapping.prop.whenMissing ? ", or none" : ""}`;
}

const drawable = (part: PartDescription | undefined): part is PartDescription => part !== undefined && !(part.needs && part.needs.length > 0);

/**
 * The specimen of `component`, one of the project's inventoried components
 * (a family name such as `Button`, which covers `Button.Root`). `partProps`
 * are props a deployment gives a library's parts beside their own, as the
 * wizard's setup does. Pure: the same config gives the same specimen.
 */
export function partSpecimen(config: ProjectConfig, component: string, scheme: "light" | "dark" = "light", partProps?: LibrarySetup["partProps"]): PartSpecimen {
  const { library } = config;
  const all = library.parts;
  if (!all) return { ok: false, component, why: "The project carries no description of its library's parts, so none can be drawn.", parts: 0 };
  const names = Object.keys(all).filter((name) => familyOf(name) === component).sort(compare);
  const parts = names.length;
  if (parts === 0) return { ok: false, component, why: `${library.package} ${library.version} has no part named ${component}.`, parts };
  const description: LibraryDescription = { package: library.package, version: library.version, parts: all };
  const setup: LibrarySetup = { react: library.react, ...(library.stylesheets ? { stylesheets: library.stylesheets } : {}), ...(library.schemeAttribute ? { schemeAttribute: library.schemeAttribute } : {}), ...(library.root ? { root: library.root } : {}), ...(partProps ? { partProps } : {}) };
  const { add, keys, disclosure, question, page, texts } = composer(description, partProps, library.roles);
  const top: string[] = [];
  const samples: SpecimenSample[] = [];
  let standIn: string | undefined;
  const mapped = (role: RoleName) => library.roles[role].components.filter((name) => familyOf(name) === component);
  const sample = (made: readonly string[], value: SpecimenSample) => {
    if (made.length === 0) return;
    top.push(...made);
    samples.push(value);
  };

  const actions = [...new Set(ACTION_ROLES.flatMap(mapped))];
  const disclosures = mapped("disclosure");
  const summaries = mapped("disclosure-summary");
  const questions = mapped("question");
  const root = rootOf(description, component);

  if (actions.length > 0) {
    const ranking = [...config.inputs.ranking].sort((a, b) => a.rank - b.rank);
    const written = new Set<number>();
    for (const part of actions) {
      if (!drawable(all[part])) continue;
      const roles = ACTION_ROLES.filter((role) => library.roles[role].components.includes(part));
      const prop = roles.map((role) => library.roles[role].prop).find((value) => value !== undefined);
      // The values to draw: those a role selects by, in role order, then the prop's others.
      const schema = prop ? all[part]?.props[prop.name] : undefined;
      const selected = prop ? roles.flatMap((role) => (library.roles[role].prop?.name === prop.name ? library.roles[role].prop.values : [])) : [];
      const others: Literal[] = schema?.type === "enum" ? [...schema.values].sort(compare) : [];
      const values = prop ? [...new Set<Literal>([...selected, ...others])].slice(0, MOST_VALUES) : [null];
      for (const value of values) {
        const carried = roles.filter((role) => {
          const mapping = library.roles[role];
          return !mapping.prop || !prop || (mapping.prop.name === prop.name && mapping.prop.values.includes(value));
        });
        // A ranked action is written on the first sample of its level.
        const level = carried.includes("primary-action") ? "primary" : carried.includes("secondary-action") ? "secondary" : null;
        const ranked = level ? ranking.find((item) => item.level === level && !written.has(item.rank)) : undefined;
        if (ranked) written.add(ranked.rank);
        const label = ranked?.action ?? (prop ? String(value) : component);
        sample(keys(add(part, { ...(prop ? { [prop.name]: value } : {}), text: label })), {
          label,
          part,
          roles: carried.map((role) => ({ role, how: how(library.roles[role], part) })),
          ...(ranked ? { rank: ranked.rank } : {}),
        });
      }
    }
  } else if (disclosures.length > 0 || summaries.length > 0) {
    const drawn = disclosures.length > 0 ? disclosures.map((part) => ({ part, role: "disclosure" as const })) : summaries.map((part) => ({ part, role: "disclosure-summary" as const }));
    for (const { part, role } of drawn) {
      if (!drawable(all[part])) continue;
      // Closed, as a page opens it.
      sample(disclosure(part, role, false), {
        label: "Section name",
        part,
        roles: role === "disclosure" ? [{ role, how: part }, ...summaries.map((name) => ({ role: "disclosure-summary" as const, how: name }))] : [{ role, how: part }],
      });
    }
  } else if (questions.length > 0) {
    for (const part of questions) {
      if (!drawable(all[part])) continue;
      sample(question(part), { label: "Your answer", part, roles: [{ role: "question", how: part }] });
    }
  } else if (root !== null && (texts.heading?.part === root || texts.text?.part === root)) {
    if (texts.heading?.part === root) sample(keys(add(root, { ...texts.heading.props, text: "Heading" })), { label: "Heading", part: root, roles: [] });
    if (texts.text?.part === root) sample(keys(add(root, { ...texts.text.props, text: "Paragraph" })), { label: "Paragraph", part: root, roles: [] });
  } else if (root !== null && LAYOUT_FAMILIES.includes(component)) {
    const candidate = STAND_IN_FAMILIES.map((family) => rootOf(description, family)).find((name) => name !== null && all[name]?.content === "children") ?? texts.text?.part ?? null;
    if (candidate === null) return { ok: false, component, why: `${component} only places what it holds, and the project's library has no small part to draw inside it.`, parts };
    const extra = candidate === texts.text?.part ? texts.text.props : all[candidate]?.props.withBorder?.type === "boolean" ? { withBorder: true } : {};
    const children = ["One", "Two", "Three"].flatMap((text) => keys(add(candidate, { ...extra, text })));
    standIn = candidate;
    sample(keys(add(root, {}, children)), { label: "One, Two, Three", part: root, roles: [] });
  } else if (root !== null && component === "Table" && [`${component}.Row`, `${component}.Cell`].every((name) => drawable(all[name]))) {
    const cell = (member: string, text: string) => add(drawable(all[`${component}.${member}`]) ? `${component}.${member}` : `${component}.Cell`, { text });
    const row = (member: string, texts: readonly string[]) => add(`${component}.Row`, {}, keys(...texts.map((text) => cell(member, text))));
    const section = (member: string, rows: (string | null)[]) => (drawable(all[`${component}.${member}`]) ? [add(`${component}.${member}`, {}, keys(...rows))] : rows);
    sample(keys(add(root, {}, keys(...section("Head", [row("HeaderCell", ["Name", "Value"])]), ...section("Body", [row("Cell", ["One", "1"]), row("Cell", ["Two", "2"])])))), { label: "Name, Value", part: root, roles: [] });
  } else if (root !== null) {
    const part = all[root] as PartDescription;
    const inner = part.content === "children" ? INNER_MEMBERS.map((member) => `${component}.${member}`).filter((name) => drawable(all[name]) && all[name]?.content === "children") : [];
    const children = inner.flatMap((name) => keys(add(name, { text: name.slice(component.length + 1) })));
    const label = inner.length > 0 ? inner.map((name) => name.slice(component.length + 1)).join(", ") : component;
    sample(keys(add(root, children.length > 0 ? {} : part.props.label?.type === "string" ? { label: component } : { text: component }, children)), { label, part: root, roles: [] });
  }

  if (top.length === 0) {
    const needs = names.flatMap((name) => (all[name]?.needs ?? []).map((need) => `${name} needs "${need}"`));
    return { ok: false, component, why: needs.length > 0 ? `${needs.join(", ")}, which a spec cannot give, so it cannot be drawn alone.` : `${component} has no part this app can tell how to draw alone.`, parts };
  }
  // Tall enough for what it draws: an app shows as much of it as the page fills.
  const drawn = page(top, `specimen-${component.toLowerCase()}`, `${component} specimen`, setup, { width: 280, height: Math.min(720, 200 + 72 * top.length), scheme });
  // Drawn from where the project's own frames load the library: the source a person chose for it, when they chose one.
  const drawnConfig: ProjectConfig = library.source ? { ...drawn.config, library: { ...drawn.config.library, source: library.source } } : drawn.config;
  return { ok: true, component, config: drawnConfig, prototype: drawn.prototype, samples, parts, ...(standIn !== undefined ? { standIn } : {}) };
}

/** Every role the palette cannot place on a specimen: a role mapped to no part, or to a part outside the inventory. */
export function unplacedRoles(config: ProjectConfig): readonly { readonly role: RoleName; readonly why: string }[] {
  const inventory = new Set(config.inventories.components);
  return ROLE_NAMES.flatMap((role) => {
    const { components } = config.library.roles[role];
    if (components.length === 0) return [{ role, why: "No part has this role." }];
    const outside = components.filter((name) => !inventory.has(familyOf(name)));
    return outside.length === components.length ? [{ role, why: `${outside.join(", ")} ${outside.length === 1 ? "has" : "have"} this role, and ${outside.length === 1 ? "is" : "are"} not in the inventory.` }] : [];
  });
}
