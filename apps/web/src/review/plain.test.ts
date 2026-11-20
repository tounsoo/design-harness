import { describe, expect, it } from "vitest";
import { describeRule, type ProjectConfig, type ProposalDraft, type Refusal, type Result, type RuleSpec } from "@design-harness/core";
import { drafted, harborBelowFold as harborBelowFoldSnapshots, harborDraft, legalSnapshots, toastDraft } from "../../test/proposals";
import { acceptProposal, approveProposal, declineProposal } from "./actions";
import { fromWords, loosensWords, partName, plainChanges, plainRefusal, plainSentence, prototypesOf, routeSentence, ruleSentence, standingWords, waitsForYou, withCapValues, withPartNames } from "./plain";

function ok<T>(result: Result<T, Refusal | string>): T {
  if (!result.ok) throw new Error(`refused: ${JSON.stringify(result.error)}`);
  return result.value;
}

const proposal = (config: ProjectConfig, id = "booking-toast") => {
  const found = config.proposals.find((item) => item.id === id);
  if (!found) throw new Error(`no proposal ${id}`);
  return found;
};

/** A draft with no examples, which is enough for words. */
const draft = (id: string, content: Partial<ProposalDraft>): ProposalDraft => ({ id, title: id, reason: "Because.", states: [], inventory: [], rules: { add: [], remove: [] }, examples: { pass: [], fail: [] }, ...content });

describe("a proposal in plain words", () => {
  it("says each change in one sentence, what the project gains first and then its rules", () => {
    const config = drafted();
    expect(plainChanges(proposal(config), config).map((change) => [change.kind, change.sentence])).toEqual([
      ["inventory", "Add Toast to the parts screens can use."],
      ["rule-added", "New rule: Each page holds at most 1 Toast."],
    ]);
    expect(plainSentence(proposal(config), config)).toBe("Add Toast to the parts screens can use. And 1 more change.");
  });

  it("says a limit before and after, with no cap name, op name or id", () => {
    const config = drafted(draft("limits", { inventory: [{ op: "set-cap", name: "MAX_VISIBLE_QUESTIONS", value: 2 }, { op: "set-max-steps", task: "book-room", value: 2 }] }));
    const sentences = plainChanges(proposal(config, "limits"), config).map((change) => change.sentence);
    const cap = config.inputs.caps.MAX_VISIBLE_QUESTIONS?.value;
    const steps = config.inputs.tasks.find((task) => task.id === "book-room");
    expect(sentences).toEqual([`Visible questions: at most 2 (was at most ${cap}).`, `“${steps?.description}” takes at most 2 steps (was at most ${steps?.maxSteps}).`]);
    expect(sentences.join(" ")).not.toMatch(/MAX_|set-|book-room/);
  });

  it("reads a rule removed and added again under its id as one changed rule, and a removal as a check that stops", () => {
    const base = drafted();
    const rule = base.rules.find((item) => item.id === "one-primary-per-page") as RuleSpec;
    const looser = drafted(draft("two", { rules: { remove: [rule.id], add: [{ ...rule, max: 2 } as RuleSpec] } }));
    expect(plainChanges(proposal(looser, "two"), looser).map((change) => [change.kind, change.sentence])).toEqual([["rule-changed", "Rule change: Each page holds at most 2 primary actions (was at most 1)."]]);
    expect(loosensWords(proposal(looser, "two"), looser)).toEqual(["Something gets looser: a screen that is flagged for it today may pass afterwards."]);
    const removal = drafted(draft("gone", { rules: { remove: [rule.id], add: [] } }));
    expect(plainSentence(proposal(removal, "gone"), removal)).toBe("Stop checking: Each page holds at most 1 primary action.");
    expect(loosensWords(proposal(removal, "gone"), removal)).toEqual(["This check stops running, on every prototype: Each page holds at most 1 primary action."]);
    expect(loosensWords(proposal(drafted()), drafted())).toEqual([]);
  });

  it("writes a cap a rule reads as its value, without the cap's name", () => {
    const config = drafted();
    expect(withCapValues("Each page holds at most 1 (MAX_DISCLOSURES_PER_PAGE) disclosure.", config)).toBe("Each page holds at most 1 disclosure.");
    expect(withCapValues("At most MAX_DISCLOSURES_PER_PAGE, or NOT_A_CAP (NOT_A_CAP).", config)).toBe(`At most ${config.inputs.caps.MAX_DISCLOSURES_PER_PAGE?.value}, or NOT_A_CAP (NOT_A_CAP).`);
  });

  it("names a library part as a designer does, and counts it as a noun", () => {
    expect(["Toast.Root", "Toast", "Card.Header", "Disclosure.Summary", "<button>", "<a>", "RadioGroup.Item"].map(partName)).toEqual(["Toast", "Toast", "Card header", "Disclosure summary", "button", "link", "RadioGroup item"]);
    expect(withPartNames("Each page holds at most 1 Toast.Root.")).toBe("Each page holds at most 1 Toast.");
    expect(withPartNames("Each page holds at most 2 Toast.Root.")).toBe("Each page holds at most 2 Toasts.");
    expect(withPartNames("Each page holds no Toast.Root.")).toBe("Each page holds no Toasts.");
    expect(withPartNames("Every <button> or <a> is inside a Card.Root.")).toBe("Every button or link is inside a Card.");
    // What a rule quotes is the project's own text, and stays as written.
    expect(withPartNames('Every Button.Root reading "Open Card.Root" is inside a Card.Root.')).toBe('Every Button reading "Open Card.Root" is inside a Card.');
  });

  it("says a rule with its parts by plain name, and leaves core's exact words to the details", () => {
    const config = drafted();
    const rule = proposal(config).rules.add[0] as RuleSpec;
    expect(describeRule(rule, config)).toBe("Each page holds at most 1 Toast.Root.");
    expect(ruleSentence(rule, config)).toBe("Each page holds at most 1 Toast.");
    expect(ruleSentence({ ...rule, max: 2 } as RuleSpec, config)).toBe("Each page holds at most 2 Toasts.");
    for (const item of config.rules) expect(ruleSentence(item, config), item.id).not.toMatch(/\.Root\b|\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/);
  });

  it("says a step budget and a route over it by the task's and the steps' own names, with no id", () => {
    const config = drafted();
    const budget = config.rules.find((rule) => rule.id === "step-budget") as RuleSpec;
    const said = ruleSentence(budget, config);
    expect(said).toMatch(/^Every way of finishing a task, not only the shortest, fits the steps the task allows \(“Pick a free room and book it” in 3 steps; /);
    expect(said).not.toMatch(/book-room|hold-room|max steps/);
    const route = [{ from: "rooms", event: "open-room", to: "room-open" }, { from: "room-open", event: "hold", to: "held" }, { from: "held", event: "book", to: "booked" }];
    expect(routeSentence({ task: "book-room", route, steps: 3, budget: 2 }, config)).toBe("“Pick a free room and book it” can take 3 steps (Open room, then hold, then book), 1 more than the 2 allowed.");
    expect(routeSentence({ task: "check-out", route: [], steps: 1, budget: 1 }, config)).toBe("“Check out” can take 1 step, within the 1 allowed.");
  });

  it("counts prototypes as a sentence starts", () => {
    expect([prototypesOf(1, 2), prototypesOf(2, 2), prototypesOf(1, 1)]).toEqual(["1 of 2 prototypes", "2 prototypes", "1 prototype"]);
  });

  it("says where it stands and who it is from, with no status code", () => {
    const open = drafted();
    expect(standingWords(proposal(open))).toBe("Waiting for you");
    expect(fromWords(proposal(open))).toMatch(/^Suggested by the agent, /);
    const approved = ok(approveProposal(open, "booking-toast", "2026-11-18T09:10:00.000Z"));
    expect([standingWords(proposal(approved)), waitsForYou(proposal(approved))]).toEqual(["Waiting for you", true]);
    const declined = ok(declineProposal(open, "booking-toast", "Not this quarter.", "2026-11-18T09:20:00.000Z"));
    expect([standingWords(proposal(declined)), waitsForYou(proposal(declined))]).toEqual(["Declined: Not this quarter.", false]);
  });

  it("says why core refuses in words with no code, for every code it knows", () => {
    for (const code of ["failing-example-passes", "passing-example-fails", "fails-for-another-reason", "unproven-rule", "missing-examples", "unknown-rule", "breaks-adopted-example", "cannot-apply", "changes-nothing", "incomplete-measurement", "needs-rule-type", "wrong-status"] as const) {
      const said = plainRefusal({ code });
      expect(said).not.toContain(code);
      expect(said).not.toMatch(/core|adopt|flag/i);
    }
  });
});

describe("accepting a proposal in one step", () => {
  const measurement = { "as-is": legalSnapshots(), "long-intro": harborBelowFoldSnapshots() };

  it("approves and adopts back to back, and core's history keeps both entries", () => {
    const config = drafted(harborDraft());
    const adoption = ok(acceptProposal(config, "harbor", measurement, [], "t1"));
    expect(proposal(adoption.config, "harbor").history.slice(1)).toEqual([
      { status: "approved", at: "t1", by: "you" },
      { status: "adopted", at: "t1", by: "you" },
    ]);
    expect(adoption.config.rules.some((rule) => rule.id === "harbor-in-first-view")).toBe(true);
  });

  it("only adopts a proposal that was approved before accepting became one step", () => {
    const approved = ok(approveProposal(drafted(harborDraft()), "harbor", "t0"));
    const adoption = ok(acceptProposal(approved, "harbor", measurement, [], "t1"));
    expect(proposal(adoption.config, "harbor").history.slice(1).map((entry) => [entry.status, entry.at])).toEqual([["approved", "t0"], ["adopted", "t1"]]);
  });

  it("is all or nothing: a refused adoption returns core's refusal and no config, so nothing is approved", () => {
    const config = drafted(toastDraft(1));
    const refused = acceptProposal(config, "booking-toast", { "one-toast": legalSnapshots(), toasts: legalSnapshots() }, [], "t1");
    expect(refused).toMatchObject({ ok: false, error: { code: "failing-example-passes", example: "toasts" } });
    expect(proposal(config).status).toBe("open");
    expect(acceptProposal(config, "booking-toast", { "one-toast": legalSnapshots() }, [], "t1")).toMatchObject({ ok: false, error: { code: "incomplete-measurement" } });
  });

  it("cannot accept what is declined, adopted already, or a request for a new rule type", () => {
    const declined = ok(declineProposal(drafted(harborDraft()), "harbor", "No.", "t0"));
    expect(acceptProposal(declined, "harbor", measurement, [], "t1")).toMatchObject({ ok: false, error: { code: "wrong-status" } });
    const adopted = ok(acceptProposal(drafted(harborDraft()), "harbor", measurement, [], "t1")).config;
    expect(acceptProposal(adopted, "harbor", measurement, [], "t2")).toMatchObject({ ok: false, error: { code: "wrong-status" } });
  });
});
