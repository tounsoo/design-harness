import type { Cap, PageType, RankedAction, RoleMapping, Task } from "../config/types";
import type { Prototype } from "../prototype/types";
import type { RenderedSnapshot } from "../rendered/types";
import type { RoleName, RuleSpec } from "../rules/types";
import type { Classification } from "./classify";

/** One change to the project's inventories or rule inputs. */
export type InventoryOp =
  | { readonly op: "add-component"; readonly name: string }
  | { readonly op: "remove-component"; readonly name: string }
  | { readonly op: "add-layout"; readonly id: string }
  | { readonly op: "remove-layout"; readonly id: string }
  | { readonly op: "add-page-type"; readonly pageType: PageType }
  | { readonly op: "remove-page-type"; readonly id: string }
  | { readonly op: "add-flow-state"; readonly state: string }
  | { readonly op: "remove-flow-state"; readonly state: string }
  | { readonly op: "add-task"; readonly task: Task }
  | { readonly op: "remove-task"; readonly id: string }
  | { readonly op: "set-max-steps"; readonly task: string; readonly value: number }
  | { readonly op: "add-cap"; readonly name: string; readonly cap: Cap }
  | { readonly op: "set-cap"; readonly name: string; readonly value: number }
  | { readonly op: "add-disclosed-section"; readonly section: string }
  | { readonly op: "remove-disclosed-section"; readonly section: string }
  | { readonly op: "set-ranking"; readonly ranking: readonly RankedAction[] }
  | { readonly op: "set-role"; readonly role: RoleName; readonly mapping: RoleMapping };

export type InventoryOpName = InventoryOp["op"];

/** A prototype the proposal's rules must pass. */
export type PassingExample = { readonly name: string; readonly prototype: Prototype; readonly snapshots?: readonly RenderedSnapshot[] };

/** A prototype that must fail, flagged by the named rule, with a finding whose message contains `message` when given. */
export type FailingExample = PassingExample & { readonly flaggedBy: { readonly rule: string; readonly message?: string } };

export const PROPOSAL_STATUSES = ["open", "approved", "adopted", "declined"] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

/** When a proposal entered a status. `at` is supplied by the caller: the library never reads a clock. */
export type StatusChange = { readonly status: ProposalStatus; readonly at: string; readonly by?: string; readonly note?: string };

/** A note on one state the change shows: ordinary states and edge cases (empty, loading, error, long content, permissions, over time). */
export type StateNote = { readonly state: string; readonly note: string };

/** One example of a rule that does not exist yet, in words: what a prototype is like, and optionally a snippet of it. */
export type RuleTypeExample = { readonly name: string; readonly description: string; readonly snippet?: string };

/**
 * A request for a rule type core's vocabulary does not have: what the rule
 * should check, why no rule type in the vocabulary can say it, and examples
 * in words of prototypes it must pass and fail. A proposal that carries one
 * is only a request: it changes nothing, so it carries no inventory change,
 * rule or example prototype, and it can never be approved or adopted. A new
 * rule type is a code change to core, made by a person; the request is what
 * they file.
 */
export type RuleTypeRequest = {
  readonly checks: string;
  readonly whyNot: string;
  readonly pass: readonly RuleTypeExample[];
  readonly fail: readonly RuleTypeExample[];
};

/** What a proposal says: everything a revision can replace. */
export type ProposalContent = {
  readonly title: string;
  readonly reason: string;
  readonly states: readonly StateNote[];
  readonly inventory: readonly InventoryOp[];
  readonly rules: { readonly add: readonly RuleSpec[]; readonly remove: readonly string[] };
  readonly examples: { readonly pass: readonly PassingExample[]; readonly fail: readonly FailingExample[] };
  /** Set when what the proposal needs is a new rule type: the proposal is then a request for a code change, never a check. */
  readonly needsRuleType?: RuleTypeRequest;
};

/**
 * Something that happened to a proposal other than a status change. `revised`:
 * its content was replaced while it was open, and `previous` is what it said
 * before. `sent-back`: a reviewer asked for a revision, with a note. Neither
 * changes the status. `at` and `by` are the caller's.
 */
export type ProposalEvent =
  | { readonly kind: "revised"; readonly at: string; readonly by?: string; readonly note?: string; readonly previous: ProposalContent }
  | { readonly kind: "sent-back"; readonly at: string; readonly by?: string; readonly note: string };

export type Proposal = ProposalContent & {
  readonly id: string;
  readonly status: ProposalStatus;
  /** Every status the proposal has been in, oldest first; the last entry's status is `status`. */
  readonly history: readonly StatusChange[];
  /** Revisions and send-backs, oldest first. Absent on a proposal that has had none. */
  readonly events?: readonly ProposalEvent[];
  /** Set by `adopt`: the classification against the config the proposal changed, kept since the config it was judged against is gone once adopted. */
  readonly classification?: Classification;
  /**
   * Set by `adopt` when it retires examples of earlier adopted proposals that
   * this proposal's change contradicts (`supersededExamples`): each such
   * example, the changed rules it goes against, and what they did to it.
   * `rerunExamples` reads it, so a retirement stays recorded and visible.
   */
  readonly supersedes?: readonly SupersededExample[];
};

/**
 * An example of an earlier adopted proposal that a proposal retires because
 * it changes the rule, cap or step budget the example is about: a failing
 * example its changed rule no longer flags (loosened past it), or a passing
 * example only its changed rules now fail (tightened past it). `rules` are
 * the changed rules involved; `detail` is what they did to the example.
 */
export type SupersededExample = {
  readonly proposal: string;
  readonly example: string;
  readonly expect: "pass" | "fail";
  readonly rules: readonly string[];
  readonly detail: string;
};
