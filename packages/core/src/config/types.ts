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

export type ComponentLibrary = {
  /** The npm package prototypes import components from, such as `@tounsoo/todae`. */
  readonly package: string;
  readonly version: string;
  readonly roles: Readonly<Record<RoleName, RoleMapping>>;
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
