import type { ProjectConfig } from "../config/types";
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

export type ClassifiedChange = { readonly change: string; readonly class: ChangeClass; readonly reason: string };

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
      return op.value < before ? { change, class: "tightens", reason: `lowers max steps from ${before} to ${op.value}` } : loosens(`raises max steps from ${before} to ${op.value}`);
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

/** Classifies a proposal against the config it would change. Deterministic: the same proposal and config give the same answer. */
export function classifyProposal(proposal: Proposal, config: ProjectConfig): Classification {
  const changes: ClassifiedChange[] = [
    ...proposal.inventory.map((op) => classifyOp(op, config)),
    ...proposal.rules.remove.map((id): ClassifiedChange => ({ change: `remove rule "${id}"`, class: "loosens-or-removes", reason: "a rule leaves force" })),
    ...proposal.rules.add.map((rule): ClassifiedChange => ({ change: `add rule "${rule.id}"`, class: "tightens", reason: "a new rule can only fail more prototypes" })),
  ];
  const worst = changes.reduce<ChangeClass>((acc, item) => (ORDER.indexOf(item.class) > ORDER.indexOf(acc) ? item.class : acc), "adds");
  return { class: worst, changes };
}
