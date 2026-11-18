import type { Cap, PageType, RankedAction, RoleMapping, Task } from "../config/types";
import type { Prototype } from "../prototype/types";
import type { RenderedSnapshot } from "../rendered/types";
import type { RoleName, RuleSpec } from "../rules/types";

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

export type Proposal = {
  readonly id: string;
  readonly title: string;
  readonly reason: string;
  readonly states: readonly StateNote[];
  readonly status: ProposalStatus;
  /** Every status the proposal has been in, oldest first; the last entry's status is `status`. */
  readonly history: readonly StatusChange[];
  readonly inventory: readonly InventoryOp[];
  readonly rules: { readonly add: readonly RuleSpec[]; readonly remove: readonly string[] };
  readonly examples: { readonly pass: readonly PassingExample[]; readonly fail: readonly FailingExample[] };
};
