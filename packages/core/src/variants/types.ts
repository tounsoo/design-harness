/**
 * Variants of a spec prototype's page: other complete pages the agent
 * offers beside the current one, for the person to compare and pick from,
 * slot by slot. A variant is data, kept with the prototype but apart from
 * its files, so it never changes what the prototype is until the person
 * picks; a pick is recorded with where each slot came from and the page
 * as it was, so it can be undone.
 */

/** The source name of the page as it is now, beside the variants' ids. */
export const CURRENT = "current";

export type Variant = {
  /** A short lowercase id, "a", "b", ... shown as "Variant A". */
  readonly id: string;
  /** The manifest page it is a variant of. */
  readonly page: string;
  /** One line on what is different about it. */
  readonly note: string;
  /** The whole page spec, as the page's file would hold it. */
  readonly spec: string;
  /** The variant it was asked to be like, when the person asked for more like one. */
  readonly like?: string;
};

/** One pick the person applied: which source each slot of the page came from, and the page's file before and after. */
export type PickRecord = {
  readonly at: string;
  readonly page: string;
  /** Slot name to source: `current` or a variant's id. */
  readonly slots: Readonly<Record<string, string>>;
  /** Each variant used, with its note at the time, so the record reads the same once the variant is gone. */
  readonly notes: Readonly<Record<string, string>>;
  readonly before: string;
  readonly after: string;
  readonly undone?: true;
};

export type VariantState = { readonly variants: readonly Variant[]; readonly picks: readonly PickRecord[] };

export const NO_VARIANTS: VariantState = { variants: [], picks: [] };
