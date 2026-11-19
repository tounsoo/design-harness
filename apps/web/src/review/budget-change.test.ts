import { describe, expect, it } from "vitest";
import { adopt, approve, checkPrototype, classifyProposal, flowFacts, type ExistingPrototype, type ProjectConfig, type Refusal, type Result, type Task } from "@design-harness/core";
import { nook } from "../../../../packages/core/examples/nook/project";
import { seedSpec } from "../../test/nook";
import { withPrimaries, withShorterRoute } from "../../test/rule-change";
import { budgetLimit, budgetWaiting, budgetWaitingWords, previewBudget, taskName, type BudgetPreview } from "./budget-change";
import { chooseExamples, examplesMessage, impactOf, proposeByPerson, stepBudgetRules } from "./rule-change";

function ok<T>(result: Result<T, Refusal>): T {
  if (!result.ok) throw new Error(`refused: ${result.error.code}: ${result.error.message}`);
  return result.value;
}

const taskOf = (config: ProjectConfig, id: string): Task => {
  const task = config.inputs.tasks.find((item) => item.id === id);
  if (!task) throw new Error(`no task ${id}`);
  return task;
};
const bookRoom = taskOf(nook, "book-room");
const withBudget = (maxSteps: number): ProjectConfig => ({ ...nook, inputs: { ...nook.inputs, tasks: nook.inputs.tasks.map((task) => (task.id === "book-room" ? { ...task, maxSteps } : task)) } });

const booking: ExistingPrototype = { name: "Booking", prototype: seedSpec() };
const straight: ExistingPrototype = { name: "Straight to booking", prototype: withShorterRoute() };
const early: ExistingPrototype = { name: "Early booking", prototype: withPrimaries(1) };

const failing = (config: ProjectConfig, item: ExistingPrototype) => checkPrototype({ config, prototype: item.prototype }).rules.filter((rule) => rule.status === "fail").map((rule) => rule.rule);
const longest = (item: ExistingPrototype) => flowFacts(nook, item.prototype).tasks.find((task) => task.task === "book-room")?.longest?.length;
const changed = (preview: BudgetPreview) => {
  if (preview.state !== "changed") throw new Error(`expected a change, got ${preview.state}`);
  return preview;
};

describe("the prototypes these tests read", () => {
  it("take 3 steps and 2 to book a room, and break nothing else", () => {
    expect([longest(booking), longest(straight)]).toEqual([3, 2]);
    expect(failing(nook, booking)).toEqual([]);
    expect(failing(nook, straight)).toEqual([]);
    expect(failing(withBudget(2), booking)).toEqual(["step-budget"]);
    expect(failing(withBudget(2), straight)).toEqual([]);
  });
});

describe("a task's step budget, as the change form takes it", () => {
  it("is one limit: at most, stricter when lower, and never left out", () => {
    expect(budgetLimit(bookRoom)).toEqual({ key: "max", label: "At most", unit: "steps", value: 3, stricter: "lower", required: true });
    expect(taskName(bookRoom)).toBe("Pick a free room and book it");
    expect(taskName({ id: "check-out" })).toBe("Check out");
  });

  it("is unchanged until the number differs, and refuses what is not a budget", () => {
    expect(previewBudget(nook, bookRoom, 3, "")).toEqual({ state: "unchanged" });
    expect(previewBudget(nook, bookRoom, null, "")).toMatchObject({ state: "invalid", problem: expect.stringContaining("cannot be left out") });
    expect(previewBudget(nook, bookRoom, 0, "")).toMatchObject({ state: "invalid", problem: expect.stringContaining("1 or more") });
    expect(previewBudget(nook, bookRoom, 2.5, "")).toMatchObject({ state: "invalid" });
  });

  it("lower: a set-max-steps draft that core says tightens, with the budget before and after", () => {
    const preview = changed(previewBudget(nook, bookRoom, 2, "  Two taps is the promise. "));
    expect(preview.draft).toEqual({
      id: "budget-book-room",
      title: "Lower the step budget of “Pick a free room and book it” from 3 to 2",
      reason: "Two taps is the promise.",
      states: [],
      inventory: [{ op: "set-max-steps", task: "book-room", value: 2 }],
      rules: { add: [], remove: [] },
      examples: { pass: [], fail: [] },
    });
    expect(preview.move).toEqual({ key: "max", before: "at most 3 steps", after: "at most 2", direction: "stricter" });
    expect(preview.class).toBe("tightens");
    expect(preview.changes.map((change) => change.reason)).toEqual(["lowers max steps from 3 to 2"]);
    expect(changed(previewBudget(withBudget(2), taskOf(withBudget(2), "book-room"), 1, "")).move).toMatchObject({ before: "at most 2 steps", after: "at most 1" });
  });

  it("higher: core says looser, and the class and the direction are core's own", () => {
    const preview = changed(previewBudget(nook, bookRoom, 4, "Holding first is a real way to book."));
    expect(preview.draft.title).toBe("Raise the step budget of “Pick a free room and book it” from 3 to 4");
    expect(preview.move).toEqual({ key: "max", before: "at most 3 steps", after: "at most 4", direction: "looser" });
    expect(preview.class).toBe("loosens-or-removes");
    expect(preview.class).toBe(classifyProposal({ ...preview.draft, status: "open", history: [{ status: "open", at: "" }] }, nook).class);
    expect(preview.changes.map((change) => change.reason)).toEqual(["raises max steps from 3 to 4"]);
  });

  it("takes an id no proposal has", () => {
    const first = changed(previewBudget(nook, bookRoom, 2, "Why."));
    const opened = ok(proposeByPerson(nook, first.draft, { pass: [], fail: [] }, "t0"));
    expect(changed(previewBudget(opened, bookRoom, 4, "")).draft.id).toBe("budget-book-room-2");
  });
});

describe("what core reads in the project with the budget moved", () => {
  const said = "the rule step-budget";

  it("names the rule that reads step budgets", () => {
    expect(stepBudgetRules(nook).map((rule) => rule.id)).toEqual(["step-budget"]);
    expect(stepBudgetRules({ ...nook, rules: nook.rules.filter((rule) => rule.id !== "step-budget") })).toEqual([]);
  });

  it("lower: the prototype whose route is over the new budget would newly fail step-budget", () => {
    const { draft } = changed(previewBudget(nook, bookRoom, 2, ""));
    const impact = impactOf(nook, draft, [booking, straight], ["step-budget"], said);
    if (!impact.ok) throw new Error(impact.refusal.message);
    expect(impact.summary).toBe("0 of 2 prototypes have findings from the rule step-budget now; 1 would newly fail.");
    expect(impact.rows.map((row) => [row.name, row.effect])).toEqual([["Booking", "fails"], ["Straight to booking", "same"]]);
    expect(impact.rows[0]?.text).toBe('No finding from the rule step-budget now. It would newly fail step-budget: The route open-room → hold → book takes 3 steps, which exceeds max steps 2 for "book-room". Every route that finishes the task must fit, not only the shortest.');
  });

  it("higher: the prototype that was over the budget would stop failing", () => {
    const tight = withBudget(2);
    const { draft } = changed(previewBudget(tight, taskOf(tight, "book-room"), 3, ""));
    const impact = impactOf(tight, draft, [booking, straight], ["step-budget"], said);
    if (!impact.ok) throw new Error(impact.refusal.message);
    expect(impact.summary).toBe("1 of 2 prototypes has findings from the rule step-budget now; 1 would stop failing.");
    expect(impact.rows.map((row) => [row.name, row.effect])).toEqual([["Booking", "clears"], ["Straight to booking", "same"]]);
  });
});

describe("a budget change's examples, from the project", () => {
  it("lower: one that passes, and one whose route the new budget flags and no other rule does; core adopts on them", () => {
    const { draft } = changed(previewBudget(nook, bookRoom, 2, "Two taps is the promise."));
    // Early booking fails one-primary-per-page and, under the new budget, step-budget too: it proves nothing alone.
    const choice = chooseExamples(nook, draft, [early, booking, straight]);
    expect(choice.needs).toEqual([]);
    expect(choice.picked).toEqual([
      { name: "straight-to-booking", expect: "pass", from: "the prototype Straight to booking" },
      { name: "booking", expect: "fail", from: "the prototype Booking", rule: "step-budget" },
    ]);
    const opened = ok(proposeByPerson(nook, draft, choice.examples, "t0"));
    const adopted = ok(adopt(ok(approve(opened, draft.id, { at: "t1", by: "you" })), draft.id, { at: "t2", by: "you" }, [booking, straight]));
    expect(adopted.classification.class).toBe("tightens");
    expect(adopted.newlyFailing.map((item) => item.name)).toEqual(["Booking"]);
    expect(taskOf(adopted.config, "book-room").maxSteps).toBe(2);
    expect(failing(adopted.config, booking)).toEqual(["step-budget"]);
  });

  it("lower: a prototype some other rule flags is not the proof, and what is missing is named, never written", () => {
    const { draft } = changed(previewBudget(nook, bookRoom, 2, "Why."));
    const short: ExistingPrototype = { name: "Two ways, straight", prototype: withPrimaries(1, withShorterRoute()) };
    const choice = chooseExamples(nook, draft, [straight, short]);
    expect(choice.examples.fail).toEqual([]);
    expect(choice.needs).toEqual(["a prototype whose longest route for book-room takes more than 2 steps, so that step-budget flags it, and no other rule does"]);
    expect(examplesMessage(draft, choice.needs)).toContain("- a prototype whose longest route for book-room takes more than 2 steps");
  });

  it("lower: a route within the old budget and over the new one is taken before one already over both", () => {
    const tight = withBudget(2);
    const { draft } = changed(previewBudget(tight, taskOf(tight, "book-room"), 1, "Why."));
    const choice = chooseExamples(tight, draft, [booking, straight]);
    expect(choice.picked).toEqual([{ name: "straight-to-booking", expect: "fail", from: "the prototype Straight to booking", rule: "step-budget" }]);
    expect(choice.needs).toEqual(["a prototype that passes every rule once this is adopted"]);
    expect(chooseExamples(tight, draft, [booking]).picked).toEqual([{ name: "booking", expect: "fail", from: "the prototype Booking", rule: "step-budget" }]);
  });

  it("higher: any one prototype a rule still in force flags, as core's adoption asks; core adopts on them", () => {
    const tight = withBudget(2);
    const { draft } = changed(previewBudget(tight, taskOf(tight, "book-room"), 3, "Holding first is a real way to book."));
    const choice = chooseExamples(tight, draft, [booking, early]);
    expect(choice.needs).toEqual([]);
    expect(choice.picked).toEqual([
      { name: "booking", expect: "pass", from: "the prototype Booking" },
      { name: "early-booking", expect: "fail", from: "the prototype Early booking", rule: "one-primary-per-page" },
    ]);
    const opened = ok(proposeByPerson(tight, draft, choice.examples, "t0"));
    const adopted = ok(adopt(ok(approve(opened, draft.id, { at: "t1", by: "you" })), draft.id, { at: "t2", by: "you" }, [booking, early]));
    expect(adopted.classification.class).toBe("loosens-or-removes");
    expect(failing(adopted.config, booking)).toEqual([]);
    // With nothing a rule flags, it says what is missing.
    expect(chooseExamples(tight, draft, [booking]).needs).toEqual(["a prototype that one rule still in force flags, and no other rule does"]);
  });

  it("needs a reason", () => {
    const { draft } = changed(previewBudget(nook, bookRoom, 2, "  "));
    const refused = proposeByPerson(nook, draft, { pass: [], fail: [] }, "t0");
    expect(refused.ok ? null : refused.error.code).toBe("missing-note");
  });
});

describe("what already waits on a budget", () => {
  it("lists open and approved proposals that move it or remove its task", () => {
    const { draft } = changed(previewBudget(nook, bookRoom, 2, "Why."));
    const opened = ok(proposeByPerson(nook, draft, { pass: [], fail: [] }, "t0"));
    expect(budgetWaiting(nook, "book-room")).toEqual([]);
    expect(budgetWaiting(opened, "hold-room")).toEqual([]);
    const waiting = budgetWaiting(opened, "book-room");
    expect(waiting.map((proposal) => proposal.id)).toEqual(["budget-book-room"]);
    expect(waiting[0] && budgetWaitingWords(waiting[0], "book-room")).toBe("moves this budget to at most 2 steps");
    const removal = ok(proposeByPerson(nook, { ...draft, id: "no-booking", inventory: [{ op: "remove-task", id: "book-room" }] }, { pass: [], fail: [] }, "t0"));
    expect(budgetWaiting(removal, "book-room").map((proposal) => budgetWaitingWords(proposal, "book-room"))).toEqual(["removes this task"]);
  });
});
