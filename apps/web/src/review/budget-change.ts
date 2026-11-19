import { classifyProposal, type ChangeClass, type ClassifiedChange, type ProjectConfig, type Proposal, type ProposalDraft, type Task } from "@design-harness/core";
import { humanize } from "../app/words";
import { freshId, type Limit, type LimitMove } from "./rule-change";

/**
 * A person's way to start a proposal that moves a task's step budget, from
 * the task in the Project view. Like a rule's limit (`rule-change.ts`), it
 * is a draft and what core says of it: the `set-max-steps` operation, core's
 * classification, and the budget before and after in words. Core's reading
 * of the project with the draft applied (`impactOf`), the examples taken
 * from the project (`chooseExamples`) and the way in (`proposeByPerson`) are
 * the rule flow's own. Nothing here edits a task.
 */

/** A task as a person reads it: its description, else its id in words. */
export function taskName(task: Pick<Task, "id" | "description">): string {
  return task.description ?? humanize(task.id);
}

const steps = (count: number) => `${count} ${count === 1 ? "step" : "steps"}`;

/** The budget as the one limit the change form edits: a `max`, stricter when lower, that a task cannot be without. */
export function budgetLimit(task: Task): Limit {
  return { key: "max", label: "At most", unit: "steps", value: task.maxSteps, stricter: "lower", required: true };
}

export type BudgetPreview =
  /** The number is the budget in force. */
  | { readonly state: "unchanged" }
  /** The number is not a budget, in words. */
  | { readonly state: "invalid"; readonly problem: string }
  | {
      readonly state: "changed";
      readonly draft: ProposalDraft;
      /** "at most 4 steps" to "at most 3", and which way. */
      readonly move: LimitMove;
      /** Core's classification of the draft against the project as it is. */
      readonly class: ChangeClass;
      readonly changes: readonly ClassifiedChange[];
    };

const asProposal = (draft: ProposalDraft): Proposal => ({ ...draft, status: "open", history: [{ status: "open", at: "" }] });

/** The draft a new budget makes, and what core says of it. `value` is null when the field is empty. */
export function previewBudget(config: ProjectConfig, task: Task, value: number | null, why: string): BudgetPreview {
  if (value === task.maxSteps) return { state: "unchanged" };
  if (value === null) return { state: "invalid", problem: "A task needs its budget: it cannot be left out." };
  if (!Number.isInteger(value) || value < 1) return { state: "invalid", problem: "A step budget is a whole number, 1 or more: a task takes at least one step." };
  const lower = value < task.maxSteps;
  const draft: ProposalDraft = {
    id: freshId(config, `budget-${task.id}`),
    title: `${lower ? "Lower" : "Raise"} the step budget of “${taskName(task)}” from ${task.maxSteps} to ${value}`,
    reason: why.trim(),
    states: [],
    inventory: [{ op: "set-max-steps", task: task.id, value }],
    rules: { add: [], remove: [] },
    examples: { pass: [], fail: [] },
  };
  const classified = classifyProposal(asProposal(draft), config);
  // Which way it moved is core's answer, not a comparison made here.
  const direction = classified.changes[0]?.bounds?.[0]?.direction ?? "unknown";
  return { state: "changed", draft, move: { key: "max", before: `at most ${steps(task.maxSteps)}`, after: `at most ${value}`, direction }, class: classified.class, changes: classified.changes };
}

/** Proposals still waiting that move this task's budget, or remove the task: the person should know before starting another. */
export function budgetWaiting(config: ProjectConfig, task: string): readonly Proposal[] {
  return config.proposals.filter((proposal) => (proposal.status === "open" || proposal.status === "approved") && proposal.inventory.some((op) => (op.op === "set-max-steps" && op.task === task) || (op.op === "remove-task" && op.id === task)));
}

/** What a waiting proposal does to a task's budget, in a few words. */
export function budgetWaitingWords(proposal: Proposal, task: string): string {
  const set = proposal.inventory.find((op) => op.op === "set-max-steps" && op.task === task);
  return set?.op === "set-max-steps" ? `moves this budget to at most ${steps(set.value)}` : "removes this task";
}
