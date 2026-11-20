import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nook } from "../../examples/nook/project";
import { EXAMPLES, loadCases, loadPrototype } from "../../test/fixtures";
import type { ProjectConfig } from "../config/types";
import { checkPrototype } from "../engine/check";
import { parseProjectConfig } from "../parse";
import type { Prototype } from "../prototype/types";
import type { RuleSpec } from "../rules/types";
import type { Result } from "../validate";
import { applyProposal } from "./apply";
import { classifyProposal } from "./classify";
import { adopt, approve, dryRunAdoption, onlyRemovesRules, proposalImpact, propose, rerunExamples, supersededExamples, type ProposalDraft, type Refusal } from "./lifecycle";
import type { Proposal } from "./types";

/**
 * Changing a rule in force: a proposal removes it and adds it again under
 * its id. These hold how such a proposal is classified, applied and adopted,
 * and what `proposalImpact` says of one before it is proposed. Every
 * prototype here is a spec.
 */
const SPEC = join(EXAMPLES, "spec");
const legal = loadPrototype(join(SPEC, "legal", "booking"));
/** Two primary actions on the booking page, which fails `one-primary-per-page` and nothing else. */
const twoPrimaries: Prototype = { ...legal, files: { ...legal.files, ...loadPrototype(join(SPEC, "illegal", "slot-second-primary", "files")).files } };
/** Three of them. */
const threePrimaries: Prototype = {
  ...twoPrimaries,
  files: {
    ...twoPrimaries.files,
    "pages/booking.json": (twoPrimaries.files["pages/booking.json"] ?? "")
      .replace('"hint": ["book-early"]', '"hint": ["book-early", "book-earlier"]')
      .replace('"book-early": {', '"book-earlier": { "type": "Button.Root", "props": { "text": "Book room" }, "children": [] },\n    "book-early": {'),
  },
};
const twoQuestions: Prototype = { ...legal, files: { ...legal.files, ...loadPrototype(join(SPEC, "illegal", "two-questions", "files")).files } };

const ruleOf = (config: ProjectConfig, id: string): RuleSpec => {
  const rule = config.rules.find((item) => item.id === id);
  if (!rule) throw new Error(`no rule "${id}"`);
  return rule;
};
const onePrimary = ruleOf(nook, "one-primary-per-page");
const atMost = (max: number): RuleSpec => ({ ...onePrimary, max, description: `A page holds at most ${max} primary actions.` }) as RuleSpec;

function ok<T>(result: Result<T, Refusal>): T {
  if (!result.ok) throw new Error(`refused: ${result.error.code}: ${result.error.message}`);
  return result.value;
}

function refusal<T>(result: Result<T, Refusal>): Refusal {
  if (result.ok) throw new Error("expected a refusal");
  return result.error;
}

const failing = (config: ProjectConfig, prototype: Prototype) => checkPrototype({ config, prototype }).rules.filter((rule) => rule.status === "fail").map((rule) => rule.rule);

function change(id: string, rule: RuleSpec, examples: ProposalDraft["examples"] = { pass: [], fail: [] }): ProposalDraft {
  return { id, title: `Change ${rule.id}`, reason: "The booking page offers to book early.", states: [], inventory: [], rules: { remove: [rule.id], add: [rule] }, examples };
}

const asProposal = (draft: ProposalDraft): Proposal => ({ ...draft, status: "open", history: [{ status: "open", at: "t0" }] });
const approved = (config: ProjectConfig, draft: ProposalDraft) => ok(approve(ok(propose(config, draft, { at: "t0", by: "you" })), draft.id, { at: "t1", by: "you" }));

describe("the fixtures", () => {
  it("fail for one rule each", () => {
    expect(failing(nook, legal)).toEqual([]);
    expect(failing(nook, twoPrimaries)).toEqual(["one-primary-per-page"]);
    expect(failing(nook, threePrimaries)).toEqual(["one-primary-per-page"]);
    expect(failing(nook, twoQuestions)).toEqual(["visible-questions"]);
  });
});

describe("classifying a changed rule", () => {
  it("loosens when a limit moves the looser way, naming the limit and its before and after", () => {
    expect(classifyProposal(asProposal(change("two", atMost(2))), nook)).toEqual({
      class: "loosens-or-removes",
      changes: [
        {
          change: 'change rule "one-primary-per-page"',
          class: "loosens-or-removes",
          reason: "moves max from 1 to 2, the looser way",
          rule: "one-primary-per-page",
          was: "Each page holds at most 1 primary action.",
          bounds: [{ bound: "max", before: "at most 1", after: "at most 2", direction: "looser" }],
        },
      ],
    });
  });

  it("tightens when every limit moves the stricter way", () => {
    const two: ProjectConfig = { ...nook, rules: nook.rules.map((rule) => (rule.id === onePrimary.id ? atMost(2) : rule)) };
    const classified = classifyProposal(asProposal(change("one", atMost(1))), two);
    expect(classified.class).toBe("tightens");
    expect(classified.changes).toEqual([
      {
        change: 'change rule "one-primary-per-page"',
        class: "tightens",
        reason: "moves max from 2 to 1, the stricter way",
        rule: "one-primary-per-page",
        was: "Each page holds at most 2 primary actions.",
        bounds: [{ bound: "max", before: "at most 2", after: "at most 1", direction: "stricter" }],
      },
    ]);
    const slot = ruleOf(nook, "rank-1-shown");
    expect(classifyProposal(asProposal(change("shown-twice", { ...slot, min: 2 } as RuleSpec)), nook).changes[0]).toMatchObject({ class: "tightens", reason: "moves min from 1 to 2, the stricter way" });
    expect(classifyProposal(asProposal(change("at-least-one", { ...onePrimary, min: 1 } as RuleSpec)), nook).changes[0]).toMatchObject({ class: "tightens", reason: "adds min 1 where there was no limit, the stricter way", bounds: [{ bound: "min", before: "no lower limit", after: "at least 1", direction: "stricter" }] });
  });

  it("loosens when limits move both ways, with a reason for each", () => {
    const slot = ruleOf(nook, "primary-slot");
    const classified = classifyProposal(asProposal(change("slot", { ...slot, min: 0, max: 0 } as RuleSpec)), nook);
    expect(classified.class).toBe("loosens-or-removes");
    expect(classified.changes[0]?.reason).toBe("moves min from 1 to 0, the looser way; moves max from 1 to 0, the stricter way");
  });

  it("does not call a move between a number and a cap stricter", () => {
    const depth = ruleOf(nook, "disclosure-depth");
    const classified = classifyProposal(asProposal(change("depth", { ...depth, depth: 1 } as RuleSpec)), nook);
    expect(classified.changes[0]).toMatchObject({ class: "loosens-or-removes", reason: "replaces depth the cap MAX_DISCLOSURE_DEPTH (now 1) with 1, which is not provably stricter: a cap moves on its own", bounds: [{ bound: "depth", before: "at most 1 deep (MAX_DISCLOSURE_DEPTH)", after: "at most 1 deep", direction: "unknown" }] });
  });

  it("loosens when anything but a limit differs, and only adds when the rule checks the same thing", () => {
    expect(classifyProposal(asProposal(change("actions", { ...onePrimary, select: { role: "action" } } as RuleSpec)), nook).changes).toEqual([
      { change: 'change rule "one-primary-per-page"', class: "loosens-or-removes", reason: "replaces the rule with one that differs by more than its numeric limits, which is not provably stricter", rule: "one-primary-per-page", was: "Each page holds at most 1 primary action." },
    ]);
    expect(classifyProposal(asProposal(change("reworded", { ...onePrimary, description: "One primary action a page." } as RuleSpec)), nook).changes[0]).toMatchObject({ class: "adds", reason: "puts the rule back as it is, its description apart: it checks the same thing" });
  });

  it("keeps a removal a removal, in the rule's words, and a rule added under a removed rule's place a new rule", () => {
    const removal: ProposalDraft = { ...change("drop", onePrimary), rules: { remove: [onePrimary.id], add: [] } };
    expect(classifyProposal(asProposal(removal), nook).changes).toEqual([{ change: 'remove rule "one-primary-per-page"', class: "loosens-or-removes", reason: "a rule leaves force", rule: "one-primary-per-page", was: "Each page holds at most 1 primary action." }]);
    const swap: ProposalDraft = { ...change("swap", onePrimary), rules: { remove: [onePrimary.id], add: [{ ...atMost(2), id: "two-primaries-per-page" } as RuleSpec] } };
    expect(classifyProposal(asProposal(swap), nook).changes.map((item) => [item.change, item.class])).toEqual([
      ['remove rule "one-primary-per-page"', "loosens-or-removes"],
      ['add rule "two-primaries-per-page"', "tightens"],
    ]);
  });

  it("is the same whatever order the rule's keys come in", () => {
    const { type, id, ...rest } = atMost(2);
    expect(classifyProposal(asProposal(change("two", { ...rest, id, type } as RuleSpec)), nook)).toEqual(classifyProposal(asProposal(change("two", atMost(2))), nook));
  });
});

describe("applying a changed rule", () => {
  it("removes the rule and puts the changed one in force under its id", () => {
    const applied = applyProposal(nook, asProposal(change("two", atMost(2))));
    if (!applied.ok) throw new Error(applied.error);
    expect(applied.value.rules.filter((rule) => rule.id === onePrimary.id)).toEqual([atMost(2)]);
    expect(applied.value.rules).toHaveLength(nook.rules.length);
    expect(failing(applied.value, twoPrimaries)).toEqual([]);
    expect(failing(applied.value, threePrimaries)).toEqual(["one-primary-per-page"]);
  });
});

describe("adopting a changed rule", () => {
  const loosened = change("two", atMost(2), { pass: [{ name: "two-primaries", prototype: twoPrimaries }], fail: [{ name: "three-primaries", prototype: threePrimaries, flaggedBy: { rule: onePrimary.id, message: "has 3 primary actions, more than 2" } }] });

  it("adopts a looser limit on a passing example it lets through and a failing one it still flags, and keeps the classification", () => {
    const adoption = ok(adopt(approved(nook, loosened), "two", { at: "t2", by: "you" }, [{ name: "Booking", prototype: twoPrimaries }]));
    expect(adoption.classification.class).toBe("loosens-or-removes");
    expect(adoption.newlyFailing).toEqual([]);
    expect(ruleOf(adoption.config, onePrimary.id)).toEqual(atMost(2));
    expect(adoption.config.proposals[0]?.classification?.changes[0]?.bounds).toEqual([{ bound: "max", before: "at most 1", after: "at most 2", direction: "looser" }]);
    expect(parseProjectConfig(JSON.parse(JSON.stringify(adoption.config))).ok).toBe(true);
    expect(rerunExamples(adoption.config).map((run) => [run.example, run.ok])).toEqual([
      ["two-primaries", true],
      ["three-primaries", true],
    ]);
  });

  it("holds a changed rule to adoption's rules like any rule a proposal adds: a failing example must name it", () => {
    const unproven = change("two", atMost(2), { pass: [{ name: "two-primaries", prototype: twoPrimaries }], fail: [{ name: "two-questions", prototype: twoQuestions, flaggedBy: { rule: "visible-questions" } }] });
    expect(refusal(adopt(approved(nook, unproven), "two", { at: "t2" }))).toMatchObject({ code: "unproven-rule", message: 'rule "one-primary-per-page" has no failing example that names it, so nothing shows it fires' });
  });

  it("adopts a stricter limit, says which prototypes newly fail, and retires the passing example of the same rule it tightens past", () => {
    const two: ProjectConfig = { ...nook, rules: nook.rules.map((rule) => (rule.id === onePrimary.id ? atMost(2) : rule)) };
    const tightened = change("one", atMost(1), { pass: [{ name: "one-primary", prototype: legal }], fail: [{ name: "two-primaries-fail", prototype: twoPrimaries, flaggedBy: { rule: onePrimary.id } }] });
    const adoption = ok(adopt(approved(two, tightened), "one", { at: "t2" }, [{ name: "Early", prototype: twoPrimaries }, { name: "Booking", prototype: legal }]));
    expect(adoption.classification.class).toBe("tightens");
    expect(adoption.newlyFailing.map((item) => [item.name, item.rules])).toEqual([["Early", ["one-primary-per-page"]]]);
    // After the looser limit was adopted on "two primaries pass", tightening it again contradicts that kept example: the change supersedes it, and says so.
    const loose = ok(adopt(approved(nook, loosened), "two", { at: "t2" })).config;
    // Its failing example named the old limit's words ("more than 2"), which the rule no longer says, so it is superseded too.
    const superseded = [
      { proposal: "two", example: "two-primaries", expect: "pass", rules: ["one-primary-per-page"] },
      { proposal: "two", example: "three-primaries", expect: "fail", rules: ["one-primary-per-page"] },
    ];
    expect(ok(supersededExamples(approved(loose, tightened), "one")).map(({ detail: _, ...rest }) => rest)).toEqual(superseded);
    const again = ok(adopt(approved(loose, tightened), "one", { at: "t3" }));
    expect(again.retiredExamples.map((run) => [run.proposal, run.example, run.expect, run.ok, run.retiredBy])).toEqual([
      ["two", "two-primaries", "pass", true, "one"],
      ["two", "three-primaries", "fail", true, "one"],
    ]);
    expect(again.config.proposals.find((item) => item.id === "one")?.supersedes?.map(({ detail: _, ...rest }) => rest)).toEqual(superseded);
    expect(rerunExamples(again.config).every((run) => run.ok)).toBe(true);
  });
});

describe("a change that supersedes earlier adopted examples", () => {
  const two: ProjectConfig = { ...nook, rules: nook.rules.map((rule) => (rule.id === onePrimary.id ? atMost(2) : rule)) };
  /** Adopted first: the limit tightened to one, proven by a passing example with one primary and a failing one with two. */
  const tightened = change("one", atMost(1), { pass: [{ name: "one-primary", prototype: legal }], fail: [{ name: "two-primaries-fail", prototype: twoPrimaries, flaggedBy: { rule: onePrimary.id, message: "more than 1" } }] });
  const strict = ok(adopt(approved(two, tightened), "one", { at: "t2" })).config;
  const loosened = change("two", atMost(2), { pass: [{ name: "two-primaries", prototype: twoPrimaries }], fail: [{ name: "three-primaries", prototype: threePrimaries, flaggedBy: { rule: onePrimary.id } }] });

  it("adopts a looser limit past an earlier failing example of the same rule, and retires that example by name", () => {
    const listed = ok(supersededExamples(approved(strict, loosened), "two"));
    expect(listed).toEqual([{ proposal: "one", example: "two-primaries-fail", expect: "fail", rules: ["one-primary-per-page"], detail: '"one-primary-per-page" passed it' }]);
    const adoption = ok(adopt(approved(strict, loosened), "two", { at: "t3", by: "you" }));
    expect(adoption.retiredExamples).toEqual([
      { proposal: "one", example: "two-primaries-fail", expect: "fail", ok: true, detail: 'retired: proposal "two" changed "one-primary-per-page" past it, so it no longer fails ("one-primary-per-page" passed it)', retiredBy: "two", changed: ["one-primary-per-page"] },
    ]);
    expect(adoption.config.proposals.find((item) => item.id === "two")?.supersedes).toEqual(listed);
    // dryRunAdoption says the same before anything changes.
    expect(ok(dryRunAdoption(ok(propose(strict, loosened, { at: "t0" })), "two", { at: "t3" })).retiredExamples).toEqual(adoption.retiredExamples);
  });

  it("re-runs green and the same every time after adoption, through a round trip of the stored config too", () => {
    const adopted = ok(adopt(approved(strict, loosened), "two", { at: "t3" })).config;
    const runs = rerunExamples(adopted);
    expect(runs.every((run) => run.ok)).toBe(true);
    expect(runs.map((run) => [run.proposal, run.example, run.retiredBy ?? null])).toEqual([
      ["one", "one-primary", null],
      ["one", "two-primaries-fail", "two"],
      ["two", "two-primaries", null],
      ["two", "three-primaries", null],
    ]);
    expect(rerunExamples(adopted)).toEqual(runs);
    const stored = parseProjectConfig(JSON.parse(JSON.stringify(adopted)));
    if (!stored.ok) throw new Error("the adopted config does not parse");
    expect(rerunExamples(stored.value)).toEqual(runs);
    // Proposals in another order give the same runs.
    expect(rerunExamples({ ...adopted, proposals: [...adopted.proposals].reverse() })).toEqual(runs);
  });

  it("keeps refusing a conflict the proposal does not own: an earlier example that also fails a rule it only adds", () => {
    const loose = ok(adopt(approved(nook, loosened), "two", { at: "t2" })).config;
    const strictPrimary = { ...atMost(1), id: "strict-primary" } as RuleSpec;
    const both: ProposalDraft = { ...change("both", atMost(1)), rules: { remove: [onePrimary.id], add: [atMost(1), strictPrimary] } };
    const impact = ok(proposalImpact(loose, both));
    expect(impact.retired).toEqual([]);
    expect(impact.broken.map((run) => [run.proposal, run.example, run.expect])).toEqual([["two", "two-primaries", "pass"]]);
  });

  it("supersedes through a cap the proposal sets, for every rule whose limit reads it", () => {
    const capped = (value: number): ProjectConfig => ({ ...nook, inputs: { ...nook.inputs, caps: { ...nook.inputs.caps, MAX_VISIBLE_QUESTIONS: { ...nook.inputs.caps.MAX_VISIBLE_QUESTIONS!, value } } } });
    const setCap = (id: string, value: number, examples: ProposalDraft["examples"]): ProposalDraft => ({ id, title: `Questions ${value}`, reason: "Why.", states: [], inventory: [{ op: "set-cap", name: "MAX_VISIBLE_QUESTIONS", value }], rules: { add: [], remove: [] }, examples });
    const one = setCap("one-question", 1, { pass: [{ name: "one-question", prototype: legal }], fail: [{ name: "two-questions", prototype: twoQuestions, flaggedBy: { rule: "visible-questions" } }] });
    const adopted = ok(adopt(approved(capped(2), one), "one-question", { at: "t1" })).config;
    const back = setCap("two-questions-ok", 2, { pass: [{ name: "two-questions-pass", prototype: twoQuestions }], fail: [{ name: "two-primaries", prototype: twoPrimaries, flaggedBy: { rule: onePrimary.id } }] });
    const adoption = ok(adopt(approved(adopted, back), "two-questions-ok", { at: "t2" }));
    expect(adoption.retiredExamples.map((run) => [run.proposal, run.example, run.retiredBy])).toEqual([["one-question", "two-questions", "two-questions-ok"]]);
    expect(rerunExamples(adoption.config).every((run) => run.ok)).toBe(true);
  });

  it("supersedes through a task's step budget the proposal sets", () => {
    const overBudget = loadCases(legal, join(SPEC, "illegal")).find((item) => item.name === "route-over-budget")?.prototype;
    if (!overBudget) throw new Error("no route-over-budget case");
    expect(failing(nook, overBudget)).toEqual(["step-budget"]);
    const budget = (value: number): ProjectConfig => ({ ...nook, inputs: { ...nook.inputs, tasks: nook.inputs.tasks.map((task) => (task.id === "hold-room" ? { ...task, maxSteps: value } : task)) } });
    const setSteps = (id: string, value: number, examples: ProposalDraft["examples"]): ProposalDraft => ({ id, title: `Hold in ${value}`, reason: "Why.", states: [], inventory: [{ op: "set-max-steps", task: "hold-room", value }], rules: { add: [], remove: [] }, examples });
    const lower = setSteps("hold-in-two", 2, { pass: [{ name: "short", prototype: legal }], fail: [{ name: "over-budget", prototype: overBudget, flaggedBy: { rule: "step-budget" } }] });
    const adopted = ok(adopt(approved(budget(3), lower), "hold-in-two", { at: "t1" })).config;
    const raise = setSteps("hold-in-three", 3, { pass: [{ name: "long-way", prototype: overBudget }], fail: [{ name: "two-primaries", prototype: twoPrimaries, flaggedBy: { rule: onePrimary.id } }] });
    const adoption = ok(adopt(approved(adopted, raise), "hold-in-three", { at: "t2" }));
    expect(adoption.retiredExamples.map((run) => [run.proposal, run.example, run.retiredBy])).toEqual([["hold-in-two", "over-budget", "hold-in-three"]]);
    expect(rerunExamples(adoption.config).every((run) => run.ok)).toBe(true);
  });

  it("answers only for an open or approved proposal, and changes nothing", () => {
    const before = JSON.stringify(strict);
    expect(refusal(supersededExamples(strict, "one")).code).toBe("wrong-status");
    expect(refusal(supersededExamples(strict, "nope")).code).toBe("not-found");
    expect(JSON.stringify(strict)).toBe(before);
  });
});

describe("what a draft would do, before it is a proposal", () => {
  const existing = [
    { name: "Two questions", prototype: twoQuestions },
    { name: "Booking", prototype: legal },
    { name: "Early", prototype: twoPrimaries },
  ];
  const removal: ProposalDraft = { id: "drop", title: "Remove one-primary-per-page", reason: "Booking early is a second primary action.", states: [], inventory: [], rules: { remove: [onePrimary.id], add: [] }, examples: { pass: [], fail: [] } };

  it("reads every prototype under both configs, in name order, with the findings a removal clears", () => {
    const impact = ok(proposalImpact(nook, removal, existing));
    expect(impact.config.rules.some((rule) => rule.id === onePrimary.id)).toBe(false);
    expect(impact.prototypes.map((item) => [item.name, item.before, item.after, item.rules, item.removed.length, item.added.length])).toEqual([
      ["Booking", "incomplete", "incomplete", [{ rule: "one-primary-per-page", before: "pass", after: "not in force" }], 0, 0],
      ["Early", "fail", "incomplete", [{ rule: "one-primary-per-page", before: "fail", after: "not in force" }], 1, 0],
      ["Two questions", "fail", "fail", [{ rule: "one-primary-per-page", before: "pass", after: "not in force" }], 0, 0],
    ]);
    expect(impact.retired).toEqual([]);
    expect(impact.broken).toEqual([]);
  });

  it("names the examples of adopted proposals a removal retires and a change breaks", () => {
    const loosened = change("two", atMost(2), { pass: [{ name: "two-primaries", prototype: twoPrimaries }], fail: [{ name: "three-primaries", prototype: threePrimaries, flaggedBy: { rule: onePrimary.id } }] });
    const loose = ok(adopt(approved(nook, loosened), "two", { at: "t2" })).config;
    expect(ok(proposalImpact(loose, removal)).retired).toEqual([{ proposal: "two", example: "three-primaries", expect: "fail", ok: true, detail: 'retired: proposal "drop" removed rule "one-primary-per-page", which it proves', retiredBy: "drop" }]);
    // A change to the rule an earlier example is about supersedes it, either way: it is retired by the change, not broken.
    const one = ok(proposalImpact(loose, change("one", atMost(1))));
    expect(one.broken).toEqual([]);
    expect(one.retired.map((run) => [run.proposal, run.example, run.expect, run.retiredBy])).toEqual([["two", "two-primaries", "pass", "one"]]);
    const three = ok(proposalImpact(loose, change("three", atMost(3))));
    expect(three.broken).toEqual([]);
    expect(three.retired.map((run) => [run.example, run.detail])).toEqual([["three-primaries", 'retired: proposal "three" changed "one-primary-per-page" past it, so it no longer fails ("one-primary-per-page" passed it)']]);
    // A rule the draft only adds is not one an earlier example was about: what it breaks stays broken.
    const strict = { ...atMost(1), id: "strict-primary" } as RuleSpec;
    const added = ok(proposalImpact(loose, { ...change("strict", strict), rules: { remove: [], add: [strict] } }));
    expect(added.broken.map((run) => [run.example, run.expect])).toEqual([["two-primaries", "pass"]]);
    expect(added.retired).toEqual([]);
  });

  it("says how a looser and a stricter limit change each prototype", () => {
    const looser = ok(proposalImpact(nook, change("two", atMost(2)), existing));
    expect(looser.prototypes.filter((item) => item.rules.length > 0).map((item) => [item.name, item.rules])).toEqual([["Early", [{ rule: "one-primary-per-page", before: "fail", after: "pass" }]]]);
    const two: ProjectConfig = { ...nook, rules: nook.rules.map((rule) => (rule.id === onePrimary.id ? atMost(2) : rule)) };
    const stricter = ok(proposalImpact(two, change("one", atMost(1)), existing));
    expect(stricter.prototypes.filter((item) => item.added.length > 0).map((item) => [item.name, item.added.map((finding) => finding.rule)])).toEqual([["Early", ["one-primary-per-page"]]]);
  });

  it("refuses what cannot apply, in adopt's words, and changes nothing", () => {
    const before = JSON.stringify(nook);
    expect(refusal(proposalImpact(nook, { ...removal, rules: { remove: ["no-such-rule"], add: [] } }))).toEqual({ code: "cannot-apply", message: 'proposal "drop" cannot apply: rule "no-such-rule" is not in force, so it cannot be removed' });
    ok(proposalImpact(nook, removal, existing));
    expect(JSON.stringify(nook)).toBe(before);
  });

  it("gives the same answer whatever order the prototypes come in", () => {
    expect(ok(proposalImpact(nook, removal, [...existing].reverse()))).toEqual(ok(proposalImpact(nook, removal, existing)));
  });
});

describe("a proposal that only removes rules", () => {
  const removal = (examples: ProposalDraft["examples"] = { pass: [], fail: [] }): ProposalDraft => ({ id: "drop-one-primary", title: "Drop one primary", reason: "Why.", states: [], inventory: [], rules: { add: [], remove: [onePrimary.id] }, examples });

  it("is told apart from one that adds a rule or changes an inventory", () => {
    expect(onlyRemovesRules(removal())).toBe(true);
    expect(onlyRemovesRules(change("change-one-primary", atMost(2)))).toBe(false);
    expect(onlyRemovesRules({ inventory: [{ op: "set-cap", name: "MAX_VISIBLE_QUESTIONS", value: 2 }], rules: { add: [], remove: [onePrimary.id] } })).toBe(false);
    expect(onlyRemovesRules({ inventory: [], rules: { add: [], remove: [] } })).toBe(false);
  });

  it("adopts with no examples, and the rule leaves force", () => {
    const adopted = ok(adopt(approved(nook, removal()), "drop-one-primary", { at: "t2" }, [{ name: "Two primaries", prototype: twoPrimaries }]));
    expect(adopted.config.rules.some((rule) => rule.id === onePrimary.id)).toBe(false);
    expect(failing(adopted.config, twoPrimaries)).not.toContain(onePrimary.id);
    expect(adopted.classification.class).toBe("loosens-or-removes");
  });

  it("still has any examples it carries judged", () => {
    const wrong = removal({ pass: [{ name: "two-questions", prototype: twoQuestions }], fail: [] });
    expect(refusal(adopt(approved(nook, wrong), "drop-one-primary", { at: "t2" })).code).toBe("passing-example-fails");
  });

  it("needs examples again once it also changes an inventory", () => {
    const mixed: ProposalDraft = { ...removal(), inventory: [{ op: "set-cap", name: "MAX_VISIBLE_QUESTIONS", value: 2 }] };
    expect(refusal(adopt(approved(nook, mixed), "drop-one-primary", { at: "t2" })).code).toBe("missing-examples");
  });
});
