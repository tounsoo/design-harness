import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nook } from "../../examples/nook/project";
import { EXAMPLES, loadPrototype } from "../../test/fixtures";
import type { ProjectConfig } from "../config/types";
import { checkPrototype } from "../engine/check";
import { parseProjectConfig } from "../parse";
import type { Prototype } from "../prototype/types";
import type { RuleSpec } from "../rules/types";
import type { Result } from "../validate";
import { applyProposal } from "./apply";
import { classifyProposal } from "./classify";
import { adopt, approve, proposalImpact, propose, rerunExamples, type ProposalDraft, type Refusal } from "./lifecycle";
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

  it("adopts a stricter limit, says which prototypes newly fail, and refuses one that breaks an example an adopted proposal keeps", () => {
    const two: ProjectConfig = { ...nook, rules: nook.rules.map((rule) => (rule.id === onePrimary.id ? atMost(2) : rule)) };
    const tightened = change("one", atMost(1), { pass: [{ name: "one-primary", prototype: legal }], fail: [{ name: "two-primaries-fail", prototype: twoPrimaries, flaggedBy: { rule: onePrimary.id } }] });
    const adoption = ok(adopt(approved(two, tightened), "one", { at: "t2" }, [{ name: "Early", prototype: twoPrimaries }, { name: "Booking", prototype: legal }]));
    expect(adoption.classification.class).toBe("tightens");
    expect(adoption.newlyFailing.map((item) => [item.name, item.rules])).toEqual([["Early", ["one-primary-per-page"]]]);
    // After the looser limit was adopted on "two primaries pass", tightening it again breaks that kept example.
    const loose = ok(adopt(approved(nook, loosened), "two", { at: "t2" })).config;
    expect(refusal(adopt(approved(loose, tightened), "one", { at: "t3" }))).toMatchObject({ code: "breaks-adopted-example", proposal: "two", example: "two-primaries" });
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
    const broken = ok(proposalImpact(loose, change("one", atMost(1)))).broken;
    expect(broken.map((run) => [run.proposal, run.example, run.expect])).toEqual([["two", "two-primaries", "pass"]]);
    const three = ok(proposalImpact(loose, change("three", atMost(3))));
    expect(three.broken.map((run) => [run.example, run.detail])).toEqual([["three-primaries", '"one-primary-per-page" passed it']]);
    expect(three.retired).toEqual([]);
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
