import { describe, expect, it } from "vitest";
import { proposalImpact, type ExistingPrototype, type ProjectConfig, type ProposalDraft, type RuleSpec } from "@design-harness/core";
import { nook } from "../../../../packages/core/examples/nook/project";
import { seedSpec } from "../../test/nook";
import { withPrimaries, withTwoQuestions } from "../../test/rule-change";
import { prototypeEffect } from "./impact";

const onePrimary = nook.rules.find((rule) => rule.id === "one-primary-per-page") as RuleSpec;
const draft = (content: Partial<ProposalDraft>): ProposalDraft => ({ id: "change", title: "A change", reason: "Because.", states: [], inventory: [], rules: { add: [], remove: [] }, examples: { pass: [], fail: [] }, ...content });
const withMax = (max: number): ProjectConfig => ({ ...nook, rules: nook.rules.map((rule) => (rule.id === onePrimary.id ? ({ ...rule, max } as RuleSpec) : rule)) });

const booking: ExistingPrototype = { name: "Booking", prototype: seedSpec() };
const early: ExistingPrototype = { name: "Early booking", prototype: withPrimaries(1) };
const earlier: ExistingPrototype = { name: "Three ways to book", prototype: withPrimaries(2) };
const questions: ExistingPrototype = { name: "Two questions", prototype: withTwoQuestions() };

function effects(config: ProjectConfig, change: Partial<ProposalDraft>, existing: readonly ExistingPrototype[]) {
  const impact = proposalImpact(config, draft(change), existing);
  if (!impact.ok) throw new Error(impact.error.message);
  return impact.value.prototypes.map(prototypeEffect);
}

describe("what a change does to each prototype, in three states", () => {
  it("a removal: the prototype that fails the rule today stops failing it, and the rest do not change", () => {
    const read = effects(nook, { rules: { add: [], remove: [onePrimary.id] } }, [booking, early, questions]);
    expect(read.map((effect) => [effect.name, effect.state, effect.fixes, effect.stillFails])).toEqual([
      ["Booking", "no-change", [], false],
      ["Early booking", "stops-failing", ["one-primary-per-page"], false],
      // It fails another rule today and still would: that is no change, not "fine".
      ["Two questions", "no-change", [], true],
    ]);
  });

  it("a looser limit: one stops failing, and one that is over the new limit too does not change, though its finding reads differently", () => {
    const read = effects(nook, { rules: { remove: [onePrimary.id], add: [{ ...onePrimary, max: 2 } as RuleSpec] } }, [early, earlier]);
    expect(read.map((effect) => [effect.name, effect.state, effect.breaks, effect.fixes, effect.stillFails])).toEqual([
      ["Early booking", "stops-failing", [], ["one-primary-per-page"], false],
      ["Three ways to book", "no-change", [], [], true],
    ]);
    // The finding that reads differently is still there to open.
    expect(read[1]?.added.map((finding) => finding.rule)).toEqual(["one-primary-per-page"]);
  });

  it("a stricter limit: the prototype it newly flags needs fixing, named by the rule and with core's finding", () => {
    const two = withMax(2);
    const read = effects(two, { rules: { remove: [onePrimary.id], add: [{ ...onePrimary, max: 1 } as RuleSpec] } }, [booking, early]);
    expect(read.map((effect) => [effect.name, effect.state, effect.breaks])).toEqual([
      ["Booking", "no-change", []],
      ["Early booking", "needs-fixing", ["one-primary-per-page"]],
    ]);
    expect(read[1]?.added[0]?.message).toMatch(/^Page "booking" has 2 primary actions, more than 1/);
  });

  it("stops failing one rule while still failing another: it says both", () => {
    const both: ExistingPrototype = { name: "Both", prototype: withTwoQuestions(withPrimaries(1)) };
    const read = effects(nook, { rules: { add: [], remove: [onePrimary.id] } }, [both]);
    expect(read.map((effect) => [effect.state, effect.fixes, effect.stillFails])).toEqual([["stops-failing", ["one-primary-per-page"], true]]);
  });
});
