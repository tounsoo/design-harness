import { BUILT_IN_RULES } from "../builtins";
import { CONFIG_SCHEMA_VERSION, type Cap, type ComponentLibrary, type LibraryRoot, type PageType, type PartDescription, type ProjectConfig, type RoleMapping, type View } from "../config/types";
import { checkPrototype } from "../engine/check";
import { formatIssues, parseProjectConfig, parsePrototype } from "../parse";
import type { Prototype } from "../prototype/types";
import { ROLE_NAMES, type Literal, type RoleName, type RuleSpec, type Selector } from "../rules/types";
import { excludedBy } from "../spec/catalog";
import type { Issue, Result } from "../validate";
import { confirmRoles, draftRoles, missingRoleEffects, sameMapping, type ConfirmedRoles, type LibraryDescription, type MissingRoleEffect, type RoleConfirmation, type RoleDraft } from "./roles";

/**
 * Starting a project on a described library: everything the web app's
 * "new project" wizard computes. The wizard shows a role draft and takes a
 * person's choices; these functions turn the choices into a confirmation
 * (`confirmationFrom`), list what each role could be instead (`roleOptions`),
 * write a one-part prototype that draws a role's parts for a live preview
 * (`rolePreview`), pick a starting inventory and rule inputs
 * (`starterInventory`, `defaultStarterRules`), and build the project config
 * with a starter prototype that follows every rule (`buildProject`).
 *
 * Pure and deterministic, like the rest of core. `buildProject` never returns
 * a config `parseProjectConfig` would refuse: the config it returns has been
 * through it.
 */

/** What a project config says about a library beyond its description: how it loads and what it renders inside. */
export type LibrarySetup = {
  /** The exact React version the library renders with. */
  readonly react: string;
  readonly stylesheets?: readonly string[];
  readonly schemeAttribute?: string;
  readonly root?: LibraryRoot;
  /** Rules only this library needs, such as a heading part that must say its level. Each is kept when every part it names is inventoried. */
  readonly rules?: readonly RuleSpec[];
  /**
   * Props the starter prototype and the role previews give a part beside its
   * role's own, by part name: what a library needs to follow the rules out of
   * the box, such as a colour whose text contrast meets AA.
   */
  readonly partProps?: Readonly<Record<string, Readonly<Record<string, Literal>>>>;
};

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const familyOf = (part: string) => part.split(".")[0] as string;
const unique = <T>(values: readonly T[]) => [...new Set(values)];

/** A lowercase slug from a name: "Save & exit" is "save-exit". Empty when the name has no letter or digit. */
export function slugOf(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** A project id from its name, unique among `taken`: "Tally" is "tally", then "tally-2". */
export function projectId(name: string, taken: readonly string[]): string {
  const base = slugOf(name) || "project";
  let id = base;
  for (let count = 2; taken.includes(id); count += 1) id = `${base}-${count}`;
  return id;
}

// ---- What each role could be ---------------------------------------------------

const BUTTON_FAMILY = /Button$/;
const DISCLOSURE_FAMILIES = ["Disclosure", "Details", "Collapsible", "Accordion", "Expandable", "Expander", "ExpansionPanel", "Collapse"];
const SUMMARY_MEMBERS = ["Summary", "Trigger", "Control", "Header", "Button", "Title"];
const PANEL_MEMBERS = ["Panel", "Content", "Body", "Details"];
const QUESTION_FAMILIES = ["Field", "FormField", "FormControl", "TextField", "TextInput"];
const ANSWER_FAMILY = /(Input|Select|Textarea|TextArea|Checkbox|Radio|Switch|Slider|Combobox|Autocomplete|Picker)$/;
const EMPHASIS_PROPS = ["variant", "kind", "intent", "appearance", "emphasis", "priority", "color", "tone"];

/** The part that stands for a family: `X.Root`, else `X`, when the library has it and a spec can draw it. */
function rootOf(description: LibraryDescription, family: string): string | null {
  for (const name of [`${family}.Root`, family]) {
    const part = description.parts[name];
    if (part && !(part.needs && part.needs.length > 0)) return name;
  }
  return null;
}

function familiesOf(description: LibraryDescription): string[] {
  return unique(Object.keys(description.parts).map(familyOf)).sort(compare);
}

/**
 * What a role could map to in this library, for a person to pick from: the
 * parts (for the roles that are a part) or the values of the action part's
 * emphasis prop (for the primary and secondary action). The drafted choice
 * is always among them, first. `roles` is the mapping as chosen so far: the
 * summary's options follow the chosen disclosure, and the emphasis values
 * follow the chosen action.
 */
export type RoleOptions =
  | { readonly kind: "parts"; readonly parts: readonly string[] }
  | { readonly kind: "values"; readonly components: readonly string[]; readonly prop: string; readonly values: readonly string[] }
  | { readonly kind: "none"; readonly why: string };

export function roleOptions(description: LibraryDescription, role: RoleName, roles: Readonly<Partial<Record<RoleName, RoleMapping>>> = {}): RoleOptions {
  const draft = draftRoles(description);
  const drafted = draft.guesses.find((guess) => guess.role === role)?.mapping;
  const families = familiesOf(description);
  const has = (part: string) => part in description.parts;
  const first = (parts: readonly string[]) => unique([...(drafted?.components ?? []), ...parts]).filter(has);
  if (role === "primary-action" || role === "secondary-action") {
    const components = (roles.action?.components.length ? roles.action.components : drafted?.components) ?? [];
    const part = components.map((name) => description.parts[name]).find((item) => item !== undefined);
    if (!part) return { kind: "none", why: "no part is the action yet, and an action's emphasis is a prop of that part" };
    const prop = drafted?.prop && part.props[drafted.prop.name]?.type === "enum" ? drafted.prop.name : EMPHASIS_PROPS.find((name) => part.props[name]?.type === "enum");
    const schema = prop === undefined ? undefined : part.props[prop];
    if (prop === undefined || schema?.type !== "enum") return { kind: "none", why: `${components[0]} has no ${EMPHASIS_PROPS.join(", ")} prop with a set of values, so no value marks its emphasis` };
    return { kind: "values", components, prop, values: schema.values };
  }
  if (role === "action") {
    const buttons = families.filter((family) => BUTTON_FAMILY.test(family)).sort((a, b) => Number(b === "Button") - Number(a === "Button") || compare(a, b));
    return listed(first(buttons.flatMap((family) => rootOf(description, family) ?? [])), "no part is named like a button");
  }
  if (role === "disclosure") {
    const found = DISCLOSURE_FAMILIES.filter((family) => families.includes(family)).flatMap((family) => [`${family}.Item`, rootOf(description, family) ?? ""]);
    return listed(first(found), `no part is named ${DISCLOSURE_FAMILIES.join(", ")}`);
  }
  if (role === "disclosure-summary") {
    const chosen = unique((roles.disclosure?.components ?? []).map(familyOf));
    const from = chosen.length > 0 ? chosen : DISCLOSURE_FAMILIES.filter((family) => families.includes(family));
    return listed(first(from.flatMap((family) => SUMMARY_MEMBERS.map((member) => `${family}.${member}`))), "the disclosure's family has no part to press");
  }
  const questions = [...QUESTION_FAMILIES.filter((family) => families.includes(family)), ...families.filter((family) => ANSWER_FAMILY.test(family) && !family.startsWith("Unstyled") && !QUESTION_FAMILIES.includes(family))];
  return listed(first(questions.flatMap((family) => rootOf(description, family) ?? [])), `no part is named like a field (${QUESTION_FAMILIES.join(", ")}) or takes an answer`);
}

const listed = (parts: readonly string[], why: string): RoleOptions => (parts.length > 0 ? { kind: "parts", parts } : { kind: "none", why });

/** One role as a person chose it: the mapping, and why when it is not the draft's. */
export type RoleChoice = { readonly mapping: RoleMapping; readonly why?: string };

/** What a person decided about the style props: the draft's list, or their own with why. */
export type ExclusionChoice = "accept" | { readonly props: readonly string[]; readonly why: string };

/**
 * A person's choices as the confirmation `confirmRoles` takes: a role whose
 * mapping is the draft's is accepted, and any other is a correction with the
 * reason given (an empty reason is kept, so `confirmRoles` refuses it by
 * name). A role with no choice is left out, and `confirmRoles` says so.
 */
export function confirmationFrom(draft: RoleDraft, choices: Readonly<Partial<Record<RoleName, RoleChoice>>>, exclusion?: ExclusionChoice): RoleConfirmation {
  const accept: RoleName[] = [];
  const corrections: Partial<Record<RoleName, { mapping: RoleMapping; why: string }>> = {};
  for (const role of ROLE_NAMES) {
    const choice = choices[role];
    if (!choice) continue;
    const guess = draft.guesses.find((item) => item.role === role);
    if (guess && sameMapping(guess.mapping, choice.mapping)) accept.push(role);
    else corrections[role] = { mapping: choice.mapping, why: choice.why ?? "" };
  }
  const drafted = draft.excludedProps?.props ?? [];
  const same = exclusion !== undefined && exclusion !== "accept" && JSON.stringify(unique(exclusion.props).sort(compare)) === JSON.stringify(drafted);
  return { accept, ...(Object.keys(corrections).length > 0 ? { corrections } : {}), ...(exclusion === undefined ? {} : { excludedProps: same && draft.excludedProps ? "accept" : exclusion }) };
}

// ---- Drawing a role's parts ------------------------------------------------------

type SpecElement = { type: string; props: Record<string, unknown>; children: string[]; visible?: unknown; slots?: Record<string, string[]> };
type Elements = Record<string, SpecElement>;

/** The props a spec must give a part for it to render: each required prop, with a plain value of its type. */
function requiredProps(part: PartDescription, state: Record<string, unknown>, key: string): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const name of Object.keys(part.props).sort(compare)) {
    const schema = part.props[name] as PartDescription["props"][string];
    if (!schema.required || schema.type === "unknown") continue;
    const plain = schema.type === "string" ? key : schema.type === "number" ? 1 : schema.type === "boolean" ? false : schema.type === "enum" ? (schema.values[0] as string) : null;
    if (schema.type === "options") props[name] = [{ value: "one", label: "One" }, { value: "two", label: "Two" }];
    else if ("bind" in schema && schema.bind !== undefined) {
      state[key] = schema.type === "string" ? "" : plain;
      props[name] = { $bindState: `/${key}` };
    } else props[name] = plain;
  }
  return props;
}

/** The part a library writes plain text with, and the one it writes a heading with, each with the props that say so. */
export type TextParts = { readonly heading: { readonly part: string; readonly props: Readonly<Record<string, Literal>> } | null; readonly text: { readonly part: string; readonly props: Readonly<Record<string, Literal>> } | null };

const HEADING_FAMILIES = ["Heading", "Title"];
const TEXT_FAMILIES = ["Text", "Paragraph", "Typography"];
const LEVEL_PROPS = ["order", "level", "as", "component"];

/** Reads which parts write a heading and a paragraph, from their names and props: `Title` with `order`, `Text.Root` with `as`. Null where the library has none it can tell. */
export function textParts(description: LibraryDescription): TextParts {
  const level = (name: string, value: "h1" | "p"): { part: string; props: Record<string, Literal> } | null => {
    const part = description.parts[name];
    if (!part || part.content !== "children" || (part.needs && part.needs.length > 0)) return null;
    for (const prop of LEVEL_PROPS) {
      const schema = part.props[prop];
      if (value === "h1" && schema?.type === "number") return { part: name, props: { [prop]: 1 } };
      if (schema?.type === "enum" && schema.values.includes(value)) return { part: name, props: { [prop]: value } };
      if (value === "h1" && schema?.type === "enum" && schema.values.includes("1")) return { part: name, props: { [prop]: "1" } };
    }
    return null;
  };
  const roots = (families: readonly string[]) => families.flatMap((family) => rootOf(description, family) ?? []);
  const heading = [...roots(HEADING_FAMILIES), ...roots(TEXT_FAMILIES)].map((name) => level(name, "h1")).find((found) => found !== null) ?? null;
  const textRoot = roots(TEXT_FAMILIES).find((name) => description.parts[name]?.content === "children");
  const text = textRoot === undefined ? null : (level(textRoot, "p") ?? { part: textRoot, props: {} });
  return { heading, text };
}

const NO_ROLES = Object.fromEntries(ROLE_NAMES.map((role) => [role, { components: [] }])) as unknown as Record<RoleName, RoleMapping>;
const PREVIEW_PAGE_TYPE = "preview";

/** What a role's preview draws, or why it cannot draw it. */
export type RolePreview = { readonly ok: true; readonly config: ProjectConfig; readonly prototype: Prototype } | { readonly ok: false; readonly why: string };

/**
 * A one-page spec prototype, and a config to render it with, that draws the
 * parts a role maps to, so a person sees them with the library's own styles
 * before confirming: an action as a pressable part, a primary or secondary
 * action once per prop value (and once with no prop when `whenMissing`), a
 * disclosure with its summary, a question with its label. It is a picture:
 * the config has no rules, and nothing checks it.
 *
 * The composition is read from part names (a family's root around its item,
 * a summary beside a panel, a label for a field), so a library built another
 * way may not draw; the frame then says which part could not render.
 */
export function rolePreview(description: LibraryDescription, setup: LibrarySetup, role: RoleName, roles: Readonly<Partial<Record<RoleName, RoleMapping>>>, scheme: "light" | "dark" = "light"): RolePreview {
  const mapping = roles[role];
  if (!mapping || mapping.components.length === 0) return { ok: false, why: "No part is mapped, so there is nothing to draw." };
  const elements: Elements = {};
  const state: Record<string, unknown> = {};
  const top: string[] = [];
  const used = new Set<string>();
  const texts = textParts(description);
  let count = 0;
  const add = (type: string, props: Record<string, unknown> = {}, children: string[] = []): string | null => {
    const part = description.parts[type];
    if (!part) return null;
    count += 1;
    const key = `${slugOf(type) || "part"}-${count}`;
    used.add(type);
    const text = props.text;
    const given = { ...requiredProps(part, state, key), ...(setup.partProps?.[type] ?? {}), ...props };
    if (part.content !== "children" || text === undefined) delete given.text;
    elements[key] = { type, props: given, children };
    return key;
  };
  const keys = (...items: (string | null)[]) => items.filter((item): item is string => item !== null);

  for (const component of mapping.components) {
    const part = description.parts[component];
    if (!part) return { ok: false, why: `${description.package} ${description.version} has no part named ${component}.` };
    if (part.needs && part.needs.length > 0) return { ok: false, why: `${component} needs ${part.needs.map((need) => `"${need}"`).join(", ")}, which a spec cannot give, so it cannot be drawn here.` };
    const family = familyOf(component);
    if (role === "action") top.push(...keys(add(component, { text: "Action" })));
    else if (role === "primary-action" || role === "secondary-action") {
      const prop = mapping.prop;
      if (!prop) top.push(...keys(add(component, { text: component })));
      else {
        for (const value of prop.values) top.push(...keys(add(component, { [prop.name]: value, text: `${prop.name}: ${String(value)}` })));
        if (prop.whenMissing) top.push(...keys(add(component, { text: `no ${prop.name}` })));
      }
    } else if (role === "disclosure" || role === "disclosure-summary") {
      // The summary to draw: the chosen one of this family, else the first the family has.
      const disclosure = role === "disclosure" ? component : (roles.disclosure?.components.find((name) => familyOf(name) === family) ?? rootOf(description, family) ?? component);
      const summary = role === "disclosure-summary" ? component : (roles["disclosure-summary"]?.components.find((name) => familyOf(name) === family) ?? SUMMARY_MEMBERS.map((member) => `${family}.${member}`).find((name) => name in description.parts) ?? null);
      const panelPart = PANEL_MEMBERS.map((member) => `${family}.${member}`).find((name) => name in description.parts && name !== summary);
      const body = "What this section holds stays here until it is opened.";
      const panel = panelPart ? add(panelPart, { text: body }) : texts.text ? add(texts.text.part, { ...texts.text.props, text: body }) : null;
      const inner = keys(summary ? add(summary, { text: "Section name" }) : null, panel);
      const item = disclosure === summary ? null : add(disclosure, description.parts[disclosure]?.props.defaultOpen?.type === "boolean" ? { defaultOpen: true } : {}, inner);
      const itemValue = item ? elements[item]?.props.value : undefined;
      const wrapper = disclosure.endsWith(".Item") ? rootOf(description, family) : null;
      if (item && wrapper && wrapper !== disclosure) top.push(...keys(add(wrapper, typeof itemValue === "string" && description.parts[wrapper]?.props.defaultValue?.type === "string" ? { defaultValue: itemValue } : {}, [item])));
      else top.push(...(item ? [item] : inner));
    } else {
      const label = "Your answer";
      if (part.props.label?.type === "string") top.push(...keys(add(component, { label })));
      else {
        const control = part.content === "children" ? ["TextInput", "Input", "Control", "Select", "Textarea"].map((member) => `${family}.${member}`).find((name) => name in description.parts && name !== component) : undefined;
        const labelPart = [`${family}.Label`, "Label.Root", "Label"].find((name) => name in description.parts && description.parts[name]?.content === "children");
        const field = add(component, {}, control ? keys(add(control, {})) : []);
        if (!field) continue;
        const hasId = part.props.id?.type === "string";
        if (hasId) (elements[field] as SpecElement).props.id = "preview-answer";
        if (labelPart && hasId && description.parts[labelPart]?.props.htmlFor) top.push(...keys(add(labelPart, { htmlFor: "preview-answer", text: label })));
        else if (part.props["aria-label"]?.type === "string") (elements[field] as SpecElement).props["aria-label"] = label;
        top.push(field);
      }
    }
  }
  if (top.length === 0) return { ok: false, why: "Nothing could be drawn for this mapping." };
  elements.page = { type: "Page", props: {}, children: [], slots: { body: top } };
  const components = unique([...used].map(familyOf)).sort(compare);
  const config: ProjectConfig = {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    id: "role-preview",
    name: "Role preview",
    library: libraryOf(description, setup, NO_ROLES, [], components),
    inventories: { components, layouts: [], pageTypes: [{ id: PREVIEW_PAGE_TYPE, kind: "content", slots: ["body"], chrome: [] }], flowStates: [PREVIEW_PAGE_TYPE] },
    inputs: { tasks: [], ranking: [], disclosedSections: [], caps: {} },
    views: [{ name: "preview", width: 360, height: 200, scheme }],
    rules: [],
    proposals: [],
  };
  const prototype: Prototype = {
    format: "spec",
    files: { "pages/preview.json": `${JSON.stringify({ root: "page", elements, state }, null, 2)}\n` },
    pages: [{ id: PREVIEW_PAGE_TYPE, pageType: PREVIEW_PAGE_TYPE, component: { file: "pages/preview.json", export: "default" } }],
    layouts: [],
    scenarios: [{ id: PREVIEW_PAGE_TYPE, state: PREVIEW_PAGE_TYPE, page: PREVIEW_PAGE_TYPE }],
    flow: { states: [PREVIEW_PAGE_TYPE], tasks: [] },
  };
  return { ok: true, config, prototype };
}

/** The config's `library`: the description cut to the parts of the inventoried components and the root, as `describe-library.mjs --only` cuts it. */
function libraryOf(description: LibraryDescription, setup: LibrarySetup, roles: Readonly<Record<RoleName, RoleMapping>>, excludedProps: readonly string[], components: readonly string[]): ComponentLibrary {
  const keep = new Set([...components, ...(setup.root ? [setup.root.component] : [])]);
  const parts = Object.fromEntries(Object.keys(description.parts).filter((name) => keep.has(familyOf(name))).sort(compare).map((name) => [name, description.parts[name] as PartDescription]));
  return {
    package: description.package,
    version: description.version,
    react: setup.react,
    ...(setup.stylesheets && setup.stylesheets.length > 0 ? { stylesheets: setup.stylesheets } : {}),
    ...(setup.schemeAttribute ? { schemeAttribute: setup.schemeAttribute } : {}),
    ...(setup.root ? { root: setup.root } : {}),
    ...(excludedProps.length > 0 ? { excludedProps } : {}),
    roles,
    parts,
  };
}

// ---- The starting inventory and rule inputs ---------------------------------------

/** Parts most products lay a page out and write with, kept when the library has them. */
const COMMON_FAMILIES = ["Alert", "Badge", "Card", "EmptyState", "Group", "Label", "Stack", "Table"];

/**
 * The components a new project starts with: every component a role maps to
 * (a rule that selects a role needs its part inventoried), the parts the
 * starter prototype writes its heading and text with, and the common layout
 * parts the library has. Sorted. A person adds or removes the rest.
 */
export function starterInventory(description: LibraryDescription, roles: Readonly<Record<RoleName, RoleMapping>>): string[] {
  const families = new Set(familiesOf(description));
  const texts = textParts(description);
  const wanted = [...ROLE_NAMES.flatMap((role) => roles[role].components), ...(texts.heading ? [texts.heading.part] : []), ...(texts.text ? [texts.text.part] : []), ...COMMON_FAMILIES];
  return unique(wanted.map(familyOf)).filter((family) => families.has(family)).sort(compare);
}

/** The components a role maps to, which the inventory must hold whatever a person unchecks. */
export function roleComponents(roles: Readonly<Record<RoleName, RoleMapping>>): string[] {
  return unique(ROLE_NAMES.flatMap((role) => roles[role].components).map(familyOf)).sort(compare);
}

export const STARTER_CAPS = ["MAX_VISIBLE_QUESTIONS", "MAX_DISCLOSURES_PER_PAGE", "MAX_DISCLOSURE_DEPTH", "TARGET_MIN_PX"] as const;
export type StarterCap = (typeof STARTER_CAPS)[number];

/** Each starting cap: which way is stricter, the least it may be, and what it means, in a sentence a designer reads. */
export const STARTER_CAP_NOTES: Readonly<Record<StarterCap, { readonly stricter: Cap["stricter"]; readonly min: number; readonly label: string; readonly description: string }>> = {
  MAX_VISIBLE_QUESTIONS: { stricter: "lower", min: 1, label: "Questions per page", description: "The most questions a page asks outside a disclosure. One keeps each page to one decision." },
  MAX_DISCLOSURES_PER_PAGE: { stricter: "lower", min: 0, label: "Disclosures per page", description: "The most sections a page hides behind a disclosure. Each one is something a person must find." },
  MAX_DISCLOSURE_DEPTH: { stricter: "lower", min: 1, label: "Disclosure depth", description: "How deep disclosures may nest. One means a disclosure never holds another." },
  TARGET_MIN_PX: { stricter: "higher", min: 1, label: "Smallest target, in CSS px", description: "The smallest size of anything a person presses. 24 is WCAG 2.5.8 Target Size (Minimum)." },
};

/** A task a person does in the product, and the most steps it may take. */
export type StarterTask = { readonly name: string; readonly maxSteps: number };

/** The rule inputs a wizard asks for: tasks with step budgets, the ranked actions, and the caps. */
export type StarterRules = {
  readonly tasks: readonly StarterTask[];
  /** The rank-1 action's text: the one primary action. */
  readonly primaryAction: string;
  /** The rank-2 action's text, or empty for none: secondary wherever it appears. */
  readonly secondaryAction: string;
  readonly caps: Readonly<Record<StarterCap, number>>;
};

/** Where a new project's rule inputs start: one task in three steps, two ranked actions, and the caps the worked examples use. */
export function defaultStarterRules(): StarterRules {
  return {
    tasks: [{ name: "Finish the main task", maxSteps: 3 }],
    primaryAction: "Continue",
    secondaryAction: "Not now",
    caps: { MAX_VISIBLE_QUESTIONS: 1, MAX_DISCLOSURES_PER_PAGE: 1, MAX_DISCLOSURE_DEPTH: 1, TARGET_MIN_PX: 24 },
  };
}

/** The page types a new project starts with: a page with one primary action, a page that lists, and a page that informs. */
export const STARTER_PAGE_TYPES: readonly PageType[] = [
  { id: "task", kind: "action", slots: ["title", "intro", "body", "alternate", "action"], chrome: ["title", "intro", "alternate"], primarySlot: "action" },
  { id: "list", kind: "collection", slots: ["title", "intro", "body"], chrome: ["title", "intro"] },
  { id: "info", kind: "content", slots: ["title", "body"], chrome: ["title"] },
];
/** The views a new project is measured at: a desktop in light, a phone in dark, so both schemes are checked. */
export const STARTER_VIEWS: readonly View[] = [
  { name: "desktop", width: 1280, height: 900, scheme: "light" },
  { name: "phone", width: 390, height: 844, scheme: "dark" },
];
/** The flow state every task of a new project starts in, and the layout its starter page's body draws. */
export const STARTER_STATE = "start";
export const STARTER_LAYOUT = "text-block";
const STARTER_PAGE = "home";

// ---- Building the project -----------------------------------------------------------

export type ProjectAnswers = {
  readonly name: string;
  /** Ids of the projects that exist, so the new one's is unique. */
  readonly takenIds: readonly string[];
  readonly description: LibraryDescription;
  readonly setup: LibrarySetup;
  readonly confirmation: RoleConfirmation;
  /** The components a prototype may render; the components the roles map to are added. Omitted: `starterInventory`. */
  readonly components?: readonly string[];
  readonly rules: StarterRules;
};

export type BuiltProject = {
  readonly config: ProjectConfig;
  /** How each role and the excluded props were decided. The config carries the same record as `library.confirmed`. */
  readonly confirmed: ConfirmedRoles;
  /** The built-in and library rules left out because they select a role the library has no part for, by role. */
  readonly dropped: readonly MissingRoleEffect[];
  /** The rules left out because they read an action rank the project does not rank (rank 2, with no secondary action). */
  readonly unranked: readonly string[];
  /** The starter prototype, which follows every rule that runs without a renderer; or why none could be written. */
  readonly starter: Result<Prototype, string>;
};

function selectorsOf(rule: RuleSpec): Selector[] {
  const named = (rule as { select?: Selector; of?: unknown; must?: unknown; holds?: Selector; only?: Selector });
  return [named.select, typeof named.of === "object" ? (named.of as Selector) : undefined, typeof named.must === "object" ? (named.must as Selector) : undefined, named.holds, named.only].filter((selector): selector is Selector => selector !== undefined && selector !== null);
}

/** Every library part a rule's selectors name, nested ones included. */
function partsNamed(selector: Selector): string[] {
  const own = selector.component === undefined ? [] : typeof selector.component === "string" ? [selector.component] : [...selector.component];
  const nested = [selector.inside, selector.notInside, selector.not, ...(selector.anyOf ?? [])].filter((item): item is Selector => item !== undefined);
  return [...own, ...nested.flatMap(partsNamed)];
}

/** Every action rank a rule reads, in a selector's text or a first-view check. */
function ranksNamed(rule: RuleSpec): number[] {
  const ofSelector = (selector: Selector): number[] => [
    ...(typeof selector.text === "object" && "rank" in selector.text ? [selector.text.rank] : []),
    ...[selector.inside, selector.notInside, selector.not, ...(selector.anyOf ?? [])].filter((item): item is Selector => item !== undefined).flatMap(ofSelector),
  ];
  const firstView = rule.type === "rendered" && rule.check === "first-view" && typeof rule.action === "object" && "rank" in rule.action ? [rule.action.rank] : [];
  return [...selectorsOf(rule).flatMap(ofSelector), ...firstView];
}

/**
 * The project a wizard's answers make: the config, validated by
 * `parseProjectConfig`, and a starter prototype checked by `checkPrototype`.
 * Refuses, with every problem and where it is, a name with no letter or
 * digit, a confirmation `confirmRoles` refuses, an inventory component the
 * library lacks, a task without a name or with a step budget under one, two
 * tasks or two actions of one name, a missing primary action and a cap below
 * its least value. A role confirmed as having no part drops the rules that
 * select it, listed in `dropped`, since a config holding one is refused.
 */
export function buildProject(answers: ProjectAnswers): Result<BuiltProject> {
  const issues: Issue[] = [];
  const { description, setup } = answers;
  const name = answers.name.trim();
  if (slugOf(name) === "") issues.push({ path: "$.name", message: "the product needs a name with a letter or a digit" });
  const confirmed = confirmRoles(description, answers.confirmation);
  if (!confirmed.ok) issues.push(...confirmed.error.map((issue) => ({ path: `$.confirmation${issue.path.slice(1)}`, message: issue.message })));

  const families = new Set(familiesOf(description));
  for (const component of answers.components ?? []) {
    if (!families.has(component)) issues.push({ path: "$.components", message: `names ${component}, which ${description.package} ${description.version} has no part of` });
  }

  const { rules } = answers;
  const taskIds = rules.tasks.map((task) => slugOf(task.name));
  if (rules.tasks.length === 0) issues.push({ path: "$.rules.tasks", message: "a project needs at least one task: the step budget rule reads it" });
  rules.tasks.forEach((task, index) => {
    const id = taskIds[index] as string;
    if (id === "") issues.push({ path: `$.rules.tasks[${index}].name`, message: "the task needs a name with a letter or a digit" });
    else if (taskIds.indexOf(id) !== index) issues.push({ path: `$.rules.tasks[${index}].name`, message: `two tasks are named "${task.name.trim()}"` });
    else if (id === STARTER_STATE) issues.push({ path: `$.rules.tasks[${index}].name`, message: `"${STARTER_STATE}" names the state every task starts in; give the task another name` });
    if (!Number.isInteger(task.maxSteps) || task.maxSteps < 1) issues.push({ path: `$.rules.tasks[${index}].maxSteps`, message: "a task takes at least one step, as a whole number" });
  });
  const primary = rules.primaryAction.trim();
  const secondary = rules.secondaryAction.trim();
  if (primary === "") issues.push({ path: "$.rules.primaryAction", message: "the primary action needs its text: the rules find it by what it says" });
  if (secondary !== "" && secondary === primary) issues.push({ path: "$.rules.secondaryAction", message: "the secondary action has the primary action's text; the rules tell them apart by what they say" });
  for (const cap of STARTER_CAPS) {
    const value = rules.caps[cap];
    const least = STARTER_CAP_NOTES[cap].min;
    if (!Number.isInteger(value) || value < least) issues.push({ path: `$.rules.caps.${cap}`, message: `is ${String(value)}; it is a whole number, ${least} or more` });
  }
  if (issues.length > 0 || !confirmed.ok) return { ok: false, error: issues };

  const roles = confirmed.value.roles;
  const components = unique([...(answers.components ?? starterInventory(description, roles)), ...roleComponents(roles)]).sort(compare);
  const missing = ROLE_NAMES.filter((role) => roles[role].components.length === 0);
  const candidates = [...BUILT_IN_RULES, ...(setup.rules ?? []).filter((rule) => selectorsOf(rule).flatMap(partsNamed).every((part) => components.includes(familyOf(part))))];
  const dropped = missingRoleEffects(candidates, missing);
  const ranks = new Set([1, ...(secondary === "" ? [] : [2])]);
  const unranked = candidates.filter((rule) => ranksNamed(rule).some((rank) => !ranks.has(rank))).map((rule) => rule.id);
  const gone = new Set([...dropped.flatMap((effect) => effect.rules.map((rule) => rule.rule)), ...unranked]);
  const config: ProjectConfig = {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    id: projectId(name, answers.takenIds),
    name,
    library: { ...libraryOf(description, setup, roles, confirmed.value.excludedProps, components), confirmed: { roles: confirmed.value.record, exclusion: confirmed.value.exclusion } },
    inventories: { components, layouts: [STARTER_LAYOUT], pageTypes: STARTER_PAGE_TYPES, flowStates: [STARTER_STATE, ...taskIds.map((id) => `${id}-done`)] },
    inputs: {
      tasks: rules.tasks.map((task, index) => ({ id: taskIds[index] as string, description: task.name.trim(), successState: `${taskIds[index] as string}-done`, maxSteps: task.maxSteps })),
      ranking: [{ action: primary, rank: 1, level: "primary" }, ...(secondary === "" ? [] : [{ action: secondary, rank: 2, level: "secondary" } as const])],
      disclosedSections: [],
      caps: Object.fromEntries(STARTER_CAPS.map((cap) => [cap, { value: rules.caps[cap], stricter: STARTER_CAP_NOTES[cap].stricter, description: STARTER_CAP_NOTES[cap].description }])),
    },
    views: STARTER_VIEWS,
    // Without the rules that could never fire: a config holding one is refused.
    rules: candidates.filter((rule) => !gone.has(rule.id)),
    proposals: [],
  };
  // The config is what a store would hold: plain JSON, read back through core's own validation.
  const parsed = parseProjectConfig(JSON.parse(JSON.stringify(config)));
  if (!parsed.ok) return { ok: false, error: parsed.error.map((issue) => ({ path: `$.config${issue.path.slice(1)}`, message: issue.message })) };
  return { ok: true, value: { config: parsed.value, confirmed: confirmed.value, dropped, unranked: unranked.filter((id) => !dropped.some((effect) => effect.rules.some((rule) => rule.rule === id))), starter: starterPrototype(parsed.value, description, setup) } };
}

/**
 * A first prototype for a project `buildProject` made: one page of the
 * project's action page type, with the product's name as its heading, a line
 * of text, the body's one layout, the rank-1 action as the primary action and
 * the rank-2 action as a secondary one, and a scenario for the start and for
 * each task done. A spec prototype, checked here by `checkPrototype`: it is
 * returned only when no rule that runs without a renderer finds anything.
 * Refuses, saying why, a library with no part to write a heading or text
 * with.
 */
export function starterPrototype(config: ProjectConfig, description: LibraryDescription, setup: LibrarySetup): Result<Prototype, string> {
  const texts = textParts({ ...description, parts: config.library.parts ?? {} });
  if (!texts.heading) return { ok: false, error: `No starter page was written: among the project's components, ${config.library.package} has no part this app can tell writes a heading (a Heading or Title with a level, or a Text that can be an h1), and a page needs one h1.` };
  if (!texts.text) return { ok: false, error: `No starter page was written: among the project's components, ${config.library.package} has no part this app can tell writes plain text (Text or Paragraph).` };
  const type = config.inventories.pageTypes.find((item) => item.kind === "action");
  if (!type || type.kind !== "action") return { ok: false, error: "No starter page was written: the project has no page type with a primary action." };
  const { roles } = config.library;
  const extra = (part: string) => setup.partProps?.[part] ?? {};
  const action = (role: "primary-action" | "secondary-action", text: string): SpecElement | null => {
    const mapping = roles[role].components.length > 0 ? roles[role] : role === "primary-action" ? roles.action : null;
    const part = mapping?.components[0];
    if (!mapping || part === undefined) return null;
    return { type: part, props: { ...extra(part), ...(mapping.prop ? { [mapping.prop.name]: mapping.prop.values[0] } : {}), text }, children: [] };
  };
  const text = (value: string, visible?: unknown): SpecElement => ({ type: (texts.text as NonNullable<TextParts["text"]>).part, props: { ...extra((texts.text as NonNullable<TextParts["text"]>).part), ...(texts.text as NonNullable<TextParts["text"]>).props, text: value }, children: [], ...(visible === undefined ? {} : { visible }) });
  const [first, second] = [config.inputs.ranking.find((item) => item.rank === 1), config.inputs.ranking.find((item) => item.rank === 2)];
  const primary = first ? action("primary-action", first.action) : null;
  const secondary = second ? action("secondary-action", second.action) : null;
  const notes = config.inputs.tasks.map((task) => [`${task.id}-note`, text(`Done: ${task.description ?? task.id}`, { $state: "/scenario/state", eq: task.successState })] as const);
  const slots: Record<string, string[]> = { title: ["name"], intro: ["about", ...notes.map(([key]) => key)], body: ["block"], ...(secondary ? { alternate: ["secondary"] } : {}), ...(primary ? { [type.primarySlot]: ["primary"] } : {}) };
  const elements: Elements = {
    page: { type: "Page", props: {}, children: [], slots },
    name: { type: texts.heading.part, props: { ...extra(texts.heading.part), ...texts.heading.props, text: config.name }, children: [] },
    about: text(`A first page for ${config.name}, built with ${config.library.package}.`),
    ...Object.fromEntries(notes),
    block: { type: "Layout", props: { id: STARTER_LAYOUT, text: "Describe the page you want to the agent, and it builds it here, inside the project's rules." }, children: [] },
    ...(secondary ? { secondary } : {}),
    ...(primary ? { primary } : {}),
  };
  const layout = {
    params: { text: { type: "text", description: "What the block says.", example: "A paragraph of text." } },
    root: "block",
    elements: { block: { type: texts.text.part, props: { ...extra(texts.text.part), ...texts.text.props, text: { $param: "text" } }, children: [] } },
  };
  const states = config.inventories.flowStates;
  const candidate = {
    format: "spec",
    files: { [`pages/${STARTER_PAGE}.json`]: `${JSON.stringify({ root: "page", elements, state: {} }, null, 2)}\n`, [`layouts/${STARTER_LAYOUT}.json`]: `${JSON.stringify(layout, null, 2)}\n` },
    pages: [{ id: STARTER_PAGE, pageType: type.id, component: { file: `pages/${STARTER_PAGE}.json`, export: "default" } }],
    layouts: [{ id: STARTER_LAYOUT, component: { file: `layouts/${STARTER_LAYOUT}.json`, export: "default" } }],
    scenarios: states.map((state) => ({ id: state, state, page: STARTER_PAGE })),
    flow: { states, tasks: config.inputs.tasks.map((task) => ({ task: task.id, start: STARTER_STATE, transitions: [{ from: STARTER_STATE, event: task.id, to: task.successState }] })) },
  };
  const prototype = parsePrototype(candidate);
  if (!prototype.ok) return { ok: false, error: `No starter page was written: it did not validate.\n${formatIssues(prototype.error)}` };
  const report = checkPrototype({ config, prototype: prototype.value });
  if (report.findings.length > 0) return { ok: false, error: `No starter page was written: the one this app writes breaks the project's rules.\n${report.findings.map((finding) => `${finding.rule}: ${finding.message}`).join("\n")}` };
  return prototype;
}

/** Whether a config excludes a prop: for a wizard that shows which of a part's props a spec may set. */
export function isExcluded(patterns: readonly string[], prop: string): boolean {
  return excludedBy(patterns, prop) !== null;
}
