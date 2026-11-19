import type { Proposal } from "../proposals/types";
import type { Literal, PageKind, RoleName, RuleSpec } from "../rules/types";

/**
 * How the library marks one role: an element of one of these parts, and, when
 * `prop` is given, with that prop set to one of its values. `whenMissing` says
 * whether an element without the prop has the role, as a button with no
 * variant is primary in a library whose default variant is primary.
 */
export type RoleMapping = {
  readonly components: readonly string[];
  readonly prop?: { readonly name: string; readonly values: readonly Literal[]; readonly whenMissing: boolean };
};

/**
 * One prop of a library part, as a spec may set it: a JSON scalar of a type,
 * one of a set of strings, or a list of `{ value, label }` options. `bind`
 * names the part's callback that reports a new value, so a spec may bind the
 * prop to state (`{ "$bindState": "/path" }`). `unknown` is a prop the library
 * declares whose type could not be read as a JSON value (an object, JSX, a
 * union of unlike types): a spec cannot set it, so it fails closed.
 */
export type PropSchema =
  | { readonly type: "string" | "number" | "boolean"; readonly required: boolean; readonly bind?: string }
  | { readonly type: "enum"; readonly values: readonly string[]; readonly required: boolean; readonly bind?: string }
  | { readonly type: "options"; readonly required: boolean }
  | { readonly type: "unknown"; readonly required: boolean };

/** The props a spec may set: every prop schema but `unknown`. */
export type SettablePropSchema = Exclude<PropSchema, { readonly type: "unknown" }>;

/**
 * A part of the library as a spec prototype uses it, generated from the
 * library's TypeScript declarations (packages/core/scripts/describe-library.mjs).
 * `content`: `children` takes text and child elements, `options` takes its
 * options as data, `none` takes nothing. `events`: what a person can do to it.
 * `needs`: required props a spec cannot give (objects, functions), so a spec
 * cannot render the part.
 */
export type PartDescription = {
  readonly props: Readonly<Record<string, PropSchema>>;
  readonly content: "children" | "options" | "none";
  readonly events?: readonly "press"[];
  readonly needs?: readonly string[];
};

/**
 * A part of the library every page renders inside, as many libraries need a
 * provider or theme root (Mantine's `MantineProvider`, Radix Themes'
 * `Theme`). The frame and the code export wrap each page in it; a prototype
 * never names it. `schemeProp` is the prop set to the view's colour scheme,
 * `light` or `dark`.
 */
export type LibraryRoot = {
  /** A top-level export of the library, such as `MantineProvider`. */
  readonly component: string;
  readonly props?: Readonly<Record<string, Literal>>;
  readonly schemeProp?: string;
};

export type ComponentLibrary = {
  /** The npm package prototypes import components from, such as `@tounsoo/todae`. */
  readonly package: string;
  /** The package's exact version, so a prototype renders the same on every load. */
  readonly version: string;
  /** The exact version of React (and React DOM) the library renders with. */
  readonly react: string;
  /** Stylesheets the library's parts need, as paths inside the package, such as `dist/todae.css`. */
  readonly stylesheets?: readonly string[];
  /**
   * The attribute on the root element that switches the library to a view's
   * colour scheme, set to `light` or `dark`, such as Todae's `data-appearance`.
   * Without it, a view's scheme is applied only as the CSS `color-scheme`.
   */
  readonly schemeAttribute?: string;
  /** The part every page renders inside, when the library needs one. */
  readonly root?: LibraryRoot;
  readonly roles: Readonly<Record<RoleName, RoleMapping>>;
  /**
   * Every part of the library, described for spec prototypes (`Button.Root`
   * and the like). A spec prototype can use the parts of the inventoried
   * components; a project without `parts` cannot check one.
   */
  readonly parts?: Readonly<Record<string, PartDescription>>;
};

type PageTypeBase = {
  readonly id: string;
  /** Every slot a page of this type fills. */
  readonly slots: readonly string[];
  /** Slots that frame the page (title, facts) rather than hold its body. */
  readonly chrome: readonly string[];
};

/** A page type. Only an `action` page type has a primary slot, so a collection cannot name one. */
export type PageType =
  | (PageTypeBase & { readonly kind: "action"; readonly primarySlot: string })
  | (PageTypeBase & { readonly kind: Exclude<PageKind, "action"> });

export type Inventories = {
  /** The library's top-level exports a prototype may render, such as `Button` (which covers `Button.Root`). */
  readonly components: readonly string[];
  /** Layout ids a prototype may register in its manifest. */
  readonly layouts: readonly string[];
  readonly pageTypes: readonly PageType[];
  readonly flowStates: readonly string[];
};

export type Task = { readonly id: string; readonly description?: string; readonly successState: string; readonly maxSteps: number };

export type RankedAction = { readonly action: string; readonly rank: number; readonly level: "primary" | "secondary" };

/** A number a rule reads by name, and which way is stricter, so a proposal that moves it is classified without guessing. */
export type Cap = { readonly value: number; readonly stricter: "lower" | "higher"; readonly description?: string };

export type RuleInputs = {
  readonly tasks: readonly Task[];
  readonly ranking: readonly RankedAction[];
  /** Section names that must sit behind a disclosure, by the disclosure summary's text. */
  readonly disclosedSections: readonly string[];
  readonly caps: Readonly<Record<string, Cap>>;
};

/** A viewport the rendered rules expect a snapshot at, for every scenario. */
export type View = { readonly name: string; readonly width: number; readonly height: number; readonly scheme: "light" | "dark" };

export const CONFIG_SCHEMA_VERSION = 1;

export type ProjectConfig = {
  readonly schemaVersion: typeof CONFIG_SCHEMA_VERSION;
  readonly id: string;
  readonly name: string;
  readonly library: ComponentLibrary;
  readonly inventories: Inventories;
  readonly inputs: RuleInputs;
  readonly views: readonly View[];
  /** The rules in force, by id. */
  readonly rules: readonly RuleSpec[];
  readonly proposals: readonly Proposal[];
};
