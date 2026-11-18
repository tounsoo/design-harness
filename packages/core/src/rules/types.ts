/**
 * The rule vocabulary. A rule is data: one of a fixed set of types, each
 * evaluated by a pure function in ../engine. A project lists the rules in
 * force in its config, and a proposal adds rules in the same shape.
 */

/** A JSON scalar, as a prop value or an allowed value. */
export type Literal = string | number | boolean | null;

/**
 * The parts of a component library that rules talk about. A project's config
 * maps each to the library's own component and prop names, so a rule written
 * as `{ role: "primary-action" }` holds for any library.
 */
export const ROLE_NAMES = ["action", "primary-action", "secondary-action", "disclosure", "disclosure-summary", "question"] as const;
export type RoleName = (typeof ROLE_NAMES)[number];

export const PAGE_KINDS = ["action", "collection", "content"] as const;
/**
 * `action`: a page with one primary action, in its page type's primary slot.
 * `collection`: a page that lists records to choose from; no primary action.
 * `content`: a page that shows information; no primary action.
 */
export type PageKind = (typeof PAGE_KINDS)[number];

/** Text an element must read: a literal, the action ranked `rank` in the project's inputs, or the current item of a count rule's `each` list. */
export type TextMatch = string | { readonly rank: number } | { readonly each: true };

/**
 * Which elements a rule talks about. Every field present must hold. A field
 * the extractor cannot decide for an element, such as a prop given by a
 * computed expression, makes the match unknown, and the rule reports that the
 * element cannot be checked rather than passing it.
 */
export type Selector = {
  /** Library part names as written after import aliases are undone (`Button.Root`), or lowercase HTML tags (`button`). */
  readonly component?: string | readonly string[];
  readonly role?: RoleName;
  /** Each prop equals the literal. A missing prop is not equal. */
  readonly props?: Readonly<Record<string, Literal>>;
  readonly hasProp?: string;
  /** The element's whole text, whitespace collapsed. */
  readonly text?: TextMatch;
  /** A page component from the prototype's manifest, rendered inside another page. */
  readonly page?: true;
  /** An instance of a layout from the manifest: any layout, or the one with this id. */
  readonly layout?: true | string;
  /** Has an ancestor matching the selector. */
  readonly inside?: Selector;
  /** Has no ancestor matching the selector. */
  readonly notInside?: Selector;
  readonly not?: Selector;
  /** Matches at least one of the selectors. */
  readonly anyOf?: readonly Selector[];
};

/** A number, or a cap from the project's inputs by name, so a proposal can tighten the cap without touching the rule. */
export type Bound = number | { readonly cap: string };

/** Limits a rule to some pages. Omitted, the rule holds on every page. */
export type PageFilter = { readonly kinds?: readonly PageKind[]; readonly types?: readonly string[] };

/**
 * Where a count looks.
 * `page`: each page's rendered tree, one count per page.
 * `pages`: every page's tree together, one count.
 * `source`: every JSX element written in the prototype's files, rendered or not.
 */
export type CountScope = "page" | "pages" | "source";

/** An input list a count rule repeats over, once per item, with `text: { each: true }` standing for the item. */
export type EachList = "disclosedSections";

/** Lists a membership rule checks against the project's inventories. */
export type MembershipSubject = "components" | "imports" | "page-types" | "layouts" | "flow-states";

/** A slot by name, or `$primary` (the page type's primary slot), `$body` (every slot neither chrome nor primary), or `$chrome`. */
export type SlotName = string;

type Base<T extends string> = { readonly type: T; readonly id: string; readonly description?: string };

export type MembershipRule = Base<"membership"> & { readonly of: MembershipSubject };

export type CountRule = Base<"count"> & {
  readonly select: Selector;
  readonly scope: CountScope;
  readonly min?: Bound;
  readonly max?: Bound;
  readonly pages?: PageFilter;
  readonly each?: EachList;
};

export type ContainmentRule = Base<"containment"> & { readonly select: Selector; readonly pages?: PageFilter } & (
    | { readonly must: "be-inside"; readonly of: Selector }
    | { readonly must: "not-be-inside"; readonly of: Selector }
    /** Elements matching `select` nest inside each other at most `depth` deep: a lone one is depth 1. */
    | { readonly must: "nest-at-most"; readonly depth: Bound }
  );

export type PropValuesRule = Base<"prop-values"> & {
  readonly select: Selector;
  readonly prop: string;
  readonly allowed: readonly Literal[];
  /** When true, a matching element without the prop fails. */
  readonly required?: boolean;
};

/** Every element matching `select` also matches `must`. */
export type RequiresRule = Base<"requires"> & { readonly select: Selector; readonly must: Selector; readonly pages?: PageFilter };

/** What one named slot of a page type holds, read from the slot's top-level elements. */
export type SlotRule = Base<"slot"> & {
  readonly slot: SlotName;
  readonly pages?: PageFilter;
  /** Count the top-level elements matching this selector against min and max. */
  readonly holds?: Selector;
  readonly min?: Bound;
  readonly max?: Bound;
  /** Every top-level element must match this selector. */
  readonly only?: Selector;
};

/** Elements matching `select` anywhere in the source must be reached from a page, so per-page rules can count them. */
export type ReachableRule = Base<"reachable"> & { readonly select: Selector };

/** Every page fills only its page type's slots, each at most once, and puts nothing outside them. A named built-in: it reads the page kit's Slot elements. */
export type PageStructureRule = Base<"page-structure">;

export type FlowCheck = "state-coverage" | "step-budget";
/**
 * `state-coverage`: every flow state has a scenario, and every scenario shows a modeled state on a known page.
 * `step-budget`: every route from a task's start to its success state, not only the shortest, fits the task's max steps.
 */
export type FlowRule = Base<"flow"> & { readonly check: FlowCheck };

export type RenderedRule = Base<"rendered"> &
  (
    | { readonly check: "target-size"; readonly minPx: Bound }
    | { readonly check: "headings" }
    | { readonly check: "contrast" }
    | { readonly check: "accessible-names" }
    | { readonly check: "first-view"; readonly action: TextMatch }
    | { readonly check: "no-sideways-scroll" }
  );

export type RuleSpec =
  | MembershipRule
  | CountRule
  | ContainmentRule
  | PropValuesRule
  | RequiresRule
  | SlotRule
  | ReachableRule
  | PageStructureRule
  | FlowRule
  | RenderedRule;

export type RuleType = RuleSpec["type"];
