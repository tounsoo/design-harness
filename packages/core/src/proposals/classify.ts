import type { ProjectConfig } from "../config/types";
import { describeRule } from "../engine/words";
import { boundValue, boundWords, compareRules, type BoundKey, type BoundMove } from "../rules/bounds";
import type { RuleSpec } from "../rules/types";
import { opLabel } from "./apply";
import type { InventoryOp, Proposal } from "./types";

/**
 * `adds`: every change grows an inventory, so nothing that passed before
 * fails, and nothing that failed for a missing member passes for another reason.
 * `tightens`: every change adds or makes a rule stricter, and at least one is stricter.
 * `loosens-or-removes`: some change removes a member or rule, or loosens or
 * replaces an input in a way that is not provably stricter.
 */
export type ChangeClass = "adds" | "tightens" | "loosens-or-removes";

/** One limit of a changed rule, before and after in words ("at most 1", "at most 2"), and which way it moved. */
export type BoundChange = { readonly bound: BoundKey; readonly before: string; readonly after: string; readonly direction: BoundMove["direction"] };

/**
 * One change and its class. A change to a rule in force also names the rule
 * (`rule`) and says it in core's words as it was when classified (`was`),
 * since a removed or replaced rule is gone from the config once the
 * proposal is adopted; `bounds` lists the limits a changed rule moves, or
 * a task's step budget before and after, which the config also forgets.
 */
export type ClassifiedChange = {
  readonly change: string;
  readonly class: ChangeClass;
  readonly reason: string;
  readonly rule?: string;
  readonly was?: string;
  readonly bounds?: readonly BoundChange[];
};

export type Classification = { readonly class: ChangeClass; readonly changes: readonly ClassifiedChange[] };

const ORDER: readonly ChangeClass[] = ["adds", "tightens", "loosens-or-removes"];

function classifyOp(op: InventoryOp, config: ProjectConfig): ClassifiedChange {
  const change = opLabel(op);
  const loosens = (reason: string): ClassifiedChange => ({ change, class: "loosens-or-removes", reason });
  switch (op.op) {
    case "add-component":
    case "add-layout":
    case "add-page-type":
    case "add-flow-state":
    case "add-task":
      return { change, class: "adds", reason: "grows an inventory" };
    case "add-cap":
      return { change, class: "adds", reason: "a new cap, which no rule in force reads yet" };
    case "remove-component":
    case "remove-layout":
    case "remove-page-type":
    case "remove-flow-state":
    case "remove-task":
      return loosens("removes a member, and the rules that read it check less");
    case "set-max-steps": {
      const before = config.inputs.tasks.find((task) => task.id === op.task)?.maxSteps;
      if (before === undefined) return loosens("names a task the config does not have");
      // The budget is a limit like a rule's `max`: it is said before and after in the same words, with which way it moved.
      const bounds = (direction: BoundChange["direction"]): readonly BoundChange[] => [{ bound: "max", before: boundWords("max", before, config), after: boundWords("max", op.value, config), direction }];
      return op.value < before ? { change, class: "tightens", reason: `lowers max steps from ${before} to ${op.value}`, bounds: bounds("stricter") } : { ...loosens(`raises max steps from ${before} to ${op.value}`), bounds: bounds("looser") };
    }
    case "set-cap": {
      const cap = config.inputs.caps[op.name];
      if (!cap) return loosens("names a cap the config does not have");
      const stricter = cap.stricter === "lower" ? op.value < cap.value : op.value > cap.value;
      return stricter ? { change, class: "tightens", reason: `moves ${op.name} from ${cap.value} to ${op.value}, the stricter way` } : loosens(`moves ${op.name} from ${cap.value} to ${op.value}, the looser way`);
    }
    case "add-disclosed-section":
      return { change, class: "tightens", reason: "one more section must sit behind a disclosure" };
    case "remove-disclosed-section":
      return loosens("a section no longer has to sit behind a disclosure");
    case "set-ranking":
      return loosens("changes which actions are primary and secondary, which is not provably stricter");
    case "set-role":
      return loosens("changes which library parts a role covers, which changes what every rule on that role counts");
  }
}

/** One moved limit as a reason: "moves max from 1 to 2, the looser way". */
function moveReason(move: BoundMove, config: ProjectConfig): string {
  const said = (value: BoundMove["before"]) => (value === undefined ? "none" : typeof value === "number" ? String(value) : `the cap ${value.cap} (now ${boundValue(value, config) ?? "unset"})`);
  if (move.direction === "unknown") return `replaces ${move.key} ${said(move.before)} with ${said(move.after)}, which is not provably stricter: a cap moves on its own`;
  const way = `the ${move.direction} way`;
  if (move.before === undefined) return `adds ${move.key} ${said(move.after)} where there was no limit, ${way}`;
  if (move.after === undefined) return `drops ${move.key} ${said(move.before)}, ${way}`;
  return `moves ${move.key} from ${said(move.before)} to ${said(move.after)}, ${way}`;
}

/**
 * A rule in force that the proposal removes and adds again under the same
 * id: a change to that rule, classified by what differs. When only numeric
 * limits moved, it tightens if every one moved the stricter way, and loosens
 * otherwise; anything else differing is not provably stricter.
 */
function classifyChangedRule(before: RuleSpec, after: RuleSpec, config: ProjectConfig): ClassifiedChange {
  const base = { change: `change rule "${after.id}"`, rule: after.id, was: describeRule(before, config) };
  const difference = compareRules(before, after);
  if (difference.kind === "same") return { ...base, class: "adds", reason: "puts the rule back as it is, its description apart: it checks the same thing" };
  if (difference.kind === "other") return { ...base, class: "loosens-or-removes", reason: "replaces the rule with one that differs by more than its numeric limits, which is not provably stricter" };
  const bounds = difference.moves.map((move): BoundChange => ({ bound: move.key, before: boundWords(move.key, move.before, config), after: boundWords(move.key, move.after, config), direction: move.direction }));
  const stricter = difference.moves.every((move) => move.direction === "stricter");
  return { ...base, class: stricter ? "tightens" : "loosens-or-removes", reason: difference.moves.map((move) => moveReason(move, config)).join("; "), bounds };
}

/** Classifies a proposal against the config it would change. Deterministic: the same proposal and config give the same answer. */
export function classifyProposal(proposal: Proposal, config: ProjectConfig): Classification {
  const inForce = (id: string) => config.rules.find((rule) => rule.id === id);
  // A rule removed and added again under its id is one change to that rule, listed where it is removed.
  const readded = (id: string) => (inForce(id) ? proposal.rules.add.find((rule) => rule.id === id) : undefined);
  const changes: ClassifiedChange[] = [
    ...proposal.inventory.map((op) => classifyOp(op, config)),
    ...proposal.rules.remove.map((id): ClassifiedChange => {
      const before = inForce(id);
      const after = readded(id);
      if (before && after) return classifyChangedRule(before, after, config);
      return { change: `remove rule "${id}"`, class: "loosens-or-removes", reason: "a rule leaves force", rule: id, ...(before ? { was: describeRule(before, config) } : {}) };
    }),
    ...proposal.rules.add
      .filter((rule) => !(proposal.rules.remove.includes(rule.id) && inForce(rule.id)))
      .map((rule): ClassifiedChange => ({ change: `add rule "${rule.id}"`, class: "tightens", reason: "a new rule can only fail more prototypes" })),
  ];
  const worst = changes.reduce<ChangeClass>((acc, item) => (ORDER.indexOf(item.class) > ORDER.indexOf(acc) ? item.class : acc), "adds");
  return { class: worst, changes };
}
