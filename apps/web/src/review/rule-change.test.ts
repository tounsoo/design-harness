import { describe, expect, it } from "vitest";
import { adopt, approve, checkPrototype, dryRunAdoption, type ExistingPrototype, type ProjectConfig, type ProposalDraft, type Refusal, type Result, type RuleSpec } from "@design-harness/core";
import { nook } from "../../../../packages/core/examples/nook/project";
import { seedSpec } from "../../test/nook";
import { withPrimaries, withTwoQuestions } from "../../test/rule-change";
import { changeMessage, chooseExamples, examplesMessage, freshId, impactOf, limitsOf, otherReaders, previewChange, proposeByPerson, removalDraft, waitingOn, waitingWords, type ChangePreview } from "./rule-change";

function ok<T>(result: Result<T, Refusal>): T {
  if (!result.ok) throw new Error(`refused: ${result.error.code}: ${result.error.message}`);
  return result.value;
}

const ruleOf = (config: ProjectConfig, id: string): RuleSpec => {
  const rule = config.rules.find((item) => item.id === id);
  if (!rule) throw new Error(`no rule ${id}`);
  return rule;
};
const onePrimary = ruleOf(nook, "one-primary-per-page");
const withMax = (max: number): ProjectConfig => ({ ...nook, rules: nook.rules.map((rule) => (rule.id === onePrimary.id ? ({ ...rule, max } as RuleSpec) : rule)) });

const booking: ExistingPrototype = { name: "Booking", prototype: seedSpec() };
const early: ExistingPrototype = { name: "Early booking", prototype: withPrimaries(1) };
const earlier: ExistingPrototype = { name: "Three ways to book", prototype: withPrimaries(2) };
const questions: ExistingPrototype = { name: "Two questions", prototype: withTwoQuestions() };

const failing = (config: ProjectConfig, item: ExistingPrototype) => checkPrototype({ config, prototype: item.prototype }).rules.filter((rule) => rule.status === "fail").map((rule) => rule.rule);
const changed = (preview: ChangePreview) => {
  if (preview.state !== "changed") throw new Error(`expected a change, got ${preview.state}`);
  return preview;
};

describe("the prototypes these tests read", () => {
  it("break one rule each", () => {
    expect(failing(nook, booking)).toEqual([]);
    expect(failing(nook, early)).toEqual(["one-primary-per-page"]);
    expect(failing(nook, earlier)).toEqual(["one-primary-per-page"]);
    expect(failing(nook, questions)).toEqual(["visible-questions"]);
  });
});

describe("what a rule's card can change in place", () => {
  it("is a rule's own numbers, set or not, and the caps it reads", () => {
    expect(limitsOf(onePrimary, nook)).toEqual([
      { key: "min", label: "At least", unit: "", stricter: "higher", required: false },
      { key: "max", label: "At most", unit: "", value: 1, stricter: "lower", required: false },
    ]);
    expect(limitsOf(ruleOf(nook, "visible-questions"), nook)).toEqual([
      { key: "min", label: "At least", unit: "", stricter: "higher", required: false },
      { key: "max", label: "At most", unit: "", value: 1, cap: "MAX_VISIBLE_QUESTIONS", stricter: "lower", required: false },
    ]);
    expect(limitsOf(ruleOf(nook, "disclosure-depth"), nook)).toEqual([{ key: "depth", label: "Nested at most", unit: "deep", value: 1, cap: "MAX_DISCLOSURE_DEPTH", stricter: "lower", required: true }]);
    expect(limitsOf(ruleOf(nook, "target-size"), nook)).toEqual([{ key: "minPx", label: "At least", unit: "px", value: 24, cap: "TARGET_MIN_PX", stricter: "higher", required: true }]);
  });

  it("is nothing for a rule with no number: that one changes only through the agent", () => {
    for (const id of ["rank-2-secondary", "page-structure", "body-from-layouts", "text-contrast", "state-coverage"]) expect(limitsOf(ruleOf(nook, id), nook), id).toEqual([]);
  });

  it("names the other rules that read a cap", () => {
    expect(otherReaders(nook, "MAX_VISIBLE_QUESTIONS", "visible-questions")).toEqual([]);
    const second: RuleSpec = { type: "count", id: "questions-on-collections", scope: "page", pages: { kinds: ["collection"] }, select: { role: "question" }, max: { cap: "MAX_VISIBLE_QUESTIONS" } };
    expect(otherReaders({ ...nook, rules: [...nook.rules, second] }, "MAX_VISIBLE_QUESTIONS", "visible-questions").map((rule) => rule.id)).toEqual(["questions-on-collections"]);
  });
});

describe("removing a rule", () => {
  it("drafts a proposal that removes it and nothing else, titled in the rule's own words", () => {
    expect(removalDraft(nook, onePrimary, "  Booking early is a second primary action. ")).toEqual({
      id: "remove-one-primary-per-page",
      title: "Remove the rule “A page holds at most one primary action”",
      reason: "Booking early is a second primary action.",
      states: [],
      inventory: [],
      rules: { add: [], remove: ["one-primary-per-page"] },
      examples: { pass: [], fail: [] },
    });
  });

  it("takes an id no proposal has", () => {
    const opened = ok(proposeByPerson(nook, removalDraft(nook, onePrimary, "Why."), { pass: [], fail: [] }, "t0"));
    expect(freshId(opened, "remove-one-primary-per-page")).toBe("remove-one-primary-per-page-2");
    expect(removalDraft(opened, onePrimary, "Why.").id).toBe("remove-one-primary-per-page-2");
    expect(freshId(nook, "set-MAX_VISIBLE_QUESTIONS")).toBe("set-max-visible-questions");
  });

  it("says what core reads in every prototype with the rule gone", () => {
    const view = impactOf(nook, removalDraft(nook, onePrimary, ""), [questions, early, booking], [onePrimary.id]);
    if (!view.ok) throw new Error(view.refusal.message);
    expect(view.summary).toBe("1 of 3 prototypes has findings from this rule now; 1 would stop failing.");
    expect(view.rows).toEqual([
      { name: "Booking", now: 0, effect: "same", text: "No finding from this rule now. Nothing changes for it." },
      { name: "Early booking", now: 1, effect: "clears", text: "1 finding from this rule now. It would stop failing." },
      { name: "Two questions", now: 0, effect: "same", text: "No finding from this rule now. Nothing changes for it." },
    ]);
    expect(view.retired).toEqual([]);
    expect(view.broken).toEqual([]);
  });

  it("takes no examples, since a removal adds nothing an example could show firing, and core adopts it on none", () => {
    const draft = removalDraft(nook, onePrimary, "Why.");
    for (const existing of [[questions, early, booking], [booking], []]) {
      expect(chooseExamples(nook, draft, existing)).toEqual({ examples: { pass: [], fail: [] }, picked: [], needs: [] });
    }
    const opened = ok(proposeByPerson(nook, draft, chooseExamples(nook, draft, [booking]).examples, "2026-11-19T10:00:00.000Z"));
    expect(opened.proposals[0]?.history).toEqual([{ status: "open", at: "2026-11-19T10:00:00.000Z", by: "you" }]);
    expect(opened.rules).toBe(nook.rules);
    // A project whose every prototype passes, the seed's case, can still remove a rule.
    expect(dryRunAdoption(opened, draft.id, { at: "t" }, [booking])).toMatchObject({ ok: true });
    const adoption = ok(adopt(ok(approve(opened, draft.id, { at: "t1", by: "you" })), draft.id, { at: "t2", by: "you" }, [early, booking, questions]));
    expect(adoption.config.rules.some((rule) => rule.id === onePrimary.id)).toBe(false);
    expect(adoption.newlyFailing).toEqual([]);
    expect(failing(adoption.config, early)).toEqual([]);
  });

  it("needs a reason", () => {
    expect(proposeByPerson(nook, removalDraft(nook, onePrimary, "  "), { pass: [], fail: [] }, "t0")).toMatchObject({ ok: false, error: { code: "missing-note" } });
  });
});

describe("changing a rule's own limit", () => {
  it("is unchanged until a number differs", () => {
    expect(previewChange(nook, onePrimary, { limits: {} }, "")).toEqual({ state: "unchanged" });
    expect(previewChange(nook, onePrimary, { limits: { max: 1 } }, "")).toEqual({ state: "unchanged" });
  });

  it("looser: the proposal removes the rule and adds it again with the new number, and core says looser", () => {
    const preview = changed(previewChange(nook, onePrimary, { limits: { max: 2 } }, "Booking early."));
    expect(preview.draft).toMatchObject({
      id: "change-one-primary-per-page",
      title: "Change “A page holds at most one primary action” to at most 2",
      reason: "Booking early.",
      inventory: [],
      rules: { remove: ["one-primary-per-page"], add: [{ type: "count", id: "one-primary-per-page", scope: "page", select: { role: "primary-action" }, max: 2 }] },
    });
    expect(preview.moves).toEqual([{ key: "max", before: "at most 1", after: "at most 2", direction: "looser" }]);
    expect(preview.class).toBe("loosens-or-removes");
    expect(preview.changes[0]?.reason).toBe("moves max from 1 to 2, the looser way");
    expect(preview.words).toEqual({ before: "Each page holds at most 1 primary action.", after: "Each page holds at most 2 primary actions." });
    expect(preview.caps).toEqual([]);
  });

  it("drops the rule's own sentence, which names the old limit, unless the person writes one", () => {
    expect(changed(previewChange(nook, onePrimary, { limits: { max: 2 } }, "")).draft.rules.add[0]).not.toHaveProperty("description");
    expect(changed(previewChange(nook, onePrimary, { limits: { max: 2 }, description: " A page holds at most two primary actions. " }, "")).draft.rules.add[0]).toMatchObject({ description: "A page holds at most two primary actions." });
  });

  it("stricter: core says tightens, and a new limit where there was none is stricter too", () => {
    const two = withMax(2);
    const preview = changed(previewChange(two, ruleOf(two, onePrimary.id), { limits: { max: 1 } }, ""));
    expect(preview.class).toBe("tightens");
    expect(preview.moves).toEqual([{ key: "max", before: "at most 2", after: "at most 1", direction: "stricter" }]);
    const floor = changed(previewChange(nook, onePrimary, { limits: { min: 1 } }, ""));
    expect(floor.class).toBe("tightens");
    expect(floor.moves).toEqual([{ key: "min", before: "no lower limit", after: "at least 1", direction: "stricter" }]);
    expect(floor.words.after).toBe("Each page holds exactly 1 primary action.");
  });

  it("refuses what is not a rule: a fraction, a negative, no limit at all", () => {
    expect(previewChange(nook, onePrimary, { limits: { max: 1.5 } }, "")).toEqual({ state: "invalid", problem: "A limit is a whole number, 0 or more." });
    expect(previewChange(nook, onePrimary, { limits: { max: -1 } }, "")).toMatchObject({ state: "invalid" });
    expect(previewChange(nook, onePrimary, { limits: { max: null } }, "")).toEqual({ state: "invalid", problem: "With no limit at all the rule would check nothing. Remove the rule instead." });
  });

  it("reads each prototype under the changed rule: one stops failing, one still fails, one newly fails", () => {
    const looser = impactOf(nook, changed(previewChange(nook, onePrimary, { limits: { max: 2 } }, "")).draft, [early, earlier], [onePrimary.id]);
    if (!looser.ok) throw new Error(looser.refusal.message);
    expect(looser.summary).toBe("2 of 2 prototypes have findings from this rule now; 1 would stop failing.");
    expect(looser.rows.map((row) => [row.name, row.effect, row.text])).toEqual([
      ["Early booking", "clears", "1 finding from this rule now. It would stop failing."],
      ["Three ways to book", "still-fails", "1 finding from this rule now. It would still fail one-primary-per-page."],
    ]);
    const two = withMax(2);
    const stricter = impactOf(two, changed(previewChange(two, ruleOf(two, onePrimary.id), { limits: { max: 1 } }, "")).draft, [booking, early], [onePrimary.id]);
    if (!stricter.ok) throw new Error(stricter.refusal.message);
    expect(stricter.summary).toBe("None of the 2 prototypes has findings from this rule now; 1 would newly fail.");
    // One prototype is not "0 of 1 prototype have": the sentence is about the one.
    const alone = impactOf(two, changed(previewChange(two, ruleOf(two, onePrimary.id), { limits: { max: 1 } }, "")).draft, [early], [onePrimary.id]);
    expect(alone.ok && alone.summary).toBe("The one prototype has no findings from this rule now; it would newly fail.");
    const cleared = impactOf(nook, changed(previewChange(nook, onePrimary, { limits: { max: 2 } }, "")).draft, [early], [onePrimary.id]);
    expect(cleared.ok && cleared.summary).toBe("The one prototype has findings from this rule now; it would stop failing.");
    expect(stricter.rows[1]).toMatchObject({ name: "Early booking", effect: "fails" });
    expect(stricter.rows[1]?.text).toMatch(/^No finding from this rule now\. It would newly fail one-primary-per-page: Page "booking" has 2 primary actions, more than 1/);
  });

  it("takes a changed rule's examples from the project: one that passes it, one it flags alone", () => {
    const looser = changed(previewChange(nook, onePrimary, { limits: { max: 2 } }, "Why."));
    const choice = chooseExamples(nook, looser.draft, [earlier, early]);
    expect(choice.picked).toEqual([
      { name: "early-booking", expect: "pass", from: "the prototype Early booking" },
      { name: "three-ways-to-book", expect: "fail", from: "the prototype Three ways to book", rule: "one-primary-per-page" },
    ]);
    expect(choice.needs).toEqual([]);
    const opened = ok(proposeByPerson(nook, looser.draft, choice.examples, "t0"));
    const adoption = ok(dryRunAdoption(opened, looser.draft.id, { at: "t1", by: "you" }, [early, earlier]));
    expect(adoption.classification.class).toBe("loosens-or-removes");
    expect(failing(adoption.config, early)).toEqual([]);
  });

  it("a stricter limit needs a prototype the new limit flags, and says so when the project has none", () => {
    const two = withMax(2);
    const tighter = changed(previewChange(two, ruleOf(two, onePrimary.id), { limits: { max: 1 } }, "Why."));
    expect(chooseExamples(two, tighter.draft, [booking])).toMatchObject({ picked: [{ name: "booking", expect: "pass" }], needs: ["a prototype that one-primary-per-page flags as changed, and no other rule does"] });
    const choice = chooseExamples(two, tighter.draft, [booking, early]);
    expect(choice.picked.map((item) => [item.name, item.expect, item.rule])).toEqual([
      ["booking", "pass", undefined],
      ["early-booking", "fail", "one-primary-per-page"],
    ]);
    const adoption = ok(dryRunAdoption(ok(proposeByPerson(two, tighter.draft, choice.examples, "t0")), tighter.draft.id, { at: "t1" }, [booking, early]));
    expect(adoption.classification.class).toBe("tightens");
    expect(adoption.newlyFailing.map((item) => item.name)).toEqual(["Early booking"]);
  });

  it("takes an example an adopted proposal keeps when the project's prototypes are not enough, and says when a change breaks one", () => {
    const looser = changed(previewChange(nook, onePrimary, { limits: { max: 2 } }, "Why."));
    const adopted = ok(adopt(ok(approve(ok(proposeByPerson(nook, looser.draft, chooseExamples(nook, looser.draft, [early, earlier]).examples, "t0")), looser.draft.id, { at: "t1" })), looser.draft.id, { at: "t2" })).config;
    const rule = ruleOf(adopted, onePrimary.id);
    // Three is still more than the kept failing example proves; it stands as the failing example again.
    const three = changed(previewChange(adopted, rule, { limits: { max: 3 } }, "Why."));
    const broken = impactOf(adopted, three.draft, [early], [rule.id]);
    expect(broken.ok && broken.broken).toEqual(['failing example three-ways-to-book of change-one-primary-per-page: "one-primary-per-page" passed it']);
    const back = changed(previewChange(adopted, rule, { limits: { max: 1 } }, "Why."));
    const view = impactOf(adopted, back.draft, [], [rule.id]);
    expect(view.ok && view.broken.map((line) => line.split(":")[0])).toEqual(["passing example early-booking of change-one-primary-per-page"]);
    const removal = impactOf(adopted, removalDraft(adopted, rule, ""), [], [rule.id]);
    expect(removal.ok && removal.retired).toEqual(["three-ways-to-book, of change-one-primary-per-page"]);
    // A change still falls back to the examples adopted proposals keep: one the looser rule passes.
    const loosest = changed(previewChange(adopted, rule, { limits: { max: 4 } }, "Why."));
    expect(chooseExamples(adopted, loosest.draft, []).picked.filter((item) => item.expect === "pass").map((item) => item.from)).toEqual(["the example early-booking that change-one-primary-per-page keeps"]);
  });
});

describe("changing a limit that reads a cap", () => {
  const visible = ruleOf(nook, "visible-questions");

  it("moves the cap with set-cap and leaves the rule alone", () => {
    const preview = changed(previewChange(nook, visible, { limits: { max: 2 } }, "Booking asks for a start time too."));
    expect(preview.draft).toMatchObject({ id: "set-max-visible-questions", title: "Move the cap MAX_VISIBLE_QUESTIONS from 1 to 2", inventory: [{ op: "set-cap", name: "MAX_VISIBLE_QUESTIONS", value: 2 }], rules: { add: [], remove: [] } });
    expect(preview.moves).toEqual([{ key: "max", cap: "MAX_VISIBLE_QUESTIONS", before: "at most 1", after: "at most 2", direction: "looser" }]);
    expect(preview.class).toBe("loosens-or-removes");
    expect(preview.caps).toEqual([{ name: "MAX_VISIBLE_QUESTIONS", before: 1, after: 2, others: [] }]);
    expect(preview.words).toEqual({ before: "Each page holds at most 1 (MAX_VISIBLE_QUESTIONS) question outside every disclosure.", after: "Each page holds at most 2 (MAX_VISIBLE_QUESTIONS) questions outside every disclosure." });
  });

  it("cannot leave a cap out, and reads the project with the cap moved", () => {
    expect(previewChange(nook, visible, { limits: { max: null } }, "")).toMatchObject({ state: "invalid" });
    const preview = changed(previewChange(nook, visible, { limits: { max: 2 } }, ""));
    const view = impactOf(nook, preview.draft, [booking, questions], [visible.id]);
    expect(view.ok && view.rows.map((row) => [row.name, row.effect])).toEqual([
      ["Booking", "same"],
      ["Two questions", "clears"],
    ]);
    expect(chooseExamples(nook, preview.draft, [booking, questions, early]).picked.map((item) => [item.name, item.expect, item.rule])).toEqual([
      ["two-questions", "pass", undefined],
      ["early-booking", "fail", "one-primary-per-page"],
    ]);
  });
});

describe("what already waits on a rule", () => {
  it("lists open and approved proposals that remove or change it, or move a cap it reads", () => {
    const draft = removalDraft(nook, onePrimary, "Why.");
    const opened = ok(proposeByPerson(nook, draft, { pass: [], fail: [] }, "t0"));
    expect(waitingOn(opened, { rule: onePrimary.id }).map((proposal) => [proposal.id, waitingWords(proposal, onePrimary.id)])).toEqual([["remove-one-primary-per-page", "removes this rule"]]);
    expect(waitingOn(opened, { rule: "visible-questions" })).toEqual([]);
    const cap = changed(previewChange(opened, ruleOf(opened, "visible-questions"), { limits: { max: 2 } }, "Why."));
    const both = ok(proposeByPerson(opened, cap.draft, { pass: [], fail: [] }, "t1"));
    expect(waitingOn(both, { rule: "visible-questions", caps: ["MAX_VISIBLE_QUESTIONS"] }).map((proposal) => waitingWords(proposal, "visible-questions"))).toEqual(["moves a cap this rule reads"]);
    const change: ProposalDraft = changed(previewChange(both, onePrimary, { limits: { max: 2 } }, "Why.")).draft;
    const three = ok(proposeByPerson(both, change, { pass: [], fail: [] }, "t2"));
    expect(waitingOn(three, { rule: onePrimary.id }).map((proposal) => waitingWords(proposal, onePrimary.id))).toEqual(["removes this rule", "changes this rule"]);
  });
});

describe("the messages that ask the agent", () => {
  it("names the proposal and what its examples still need", () => {
    const draft = removalDraft(nook, onePrimary, "Why.");
    const message = examplesMessage(draft, ["a prototype that one rule still in force flags, and no other rule does"]);
    expect(message).toMatch(/^I opened proposal "remove-one-primary-per-page" \(Remove the rule “A page holds at most one primary action”\)\./);
    expect(message).toContain("- a prototype that one rule still in force flags, and no other rule does");
    expect(message).toContain("revise_proposal, keeping its id, and give only examples");
  });

  it("names the rule in core's words and carries the person's own", () => {
    const message = changeMessage(ruleOf(nook, "rank-2-secondary"), nook, "  Let Hold room be a link on the rooms page. ");
    expect(message).toMatch(/^Draft a proposal that changes the rule "rank-2-secondary"\. In core's words it says: Every action reading the rank-2 action "Hold room" is also a secondary action\./);
    expect(message).toContain("What I want changed: Let Hold room be a link on the rooms page.");
    expect(message).toContain('put "rank-2-secondary" in rules.remove and the changed rule, under the same id, in rules.add');
  });
});
