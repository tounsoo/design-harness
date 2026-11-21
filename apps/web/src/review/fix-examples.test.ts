import { describe, expect, it } from "vitest";
import { adopt, approve, dryRunAdoption, propose, rerunExamples, supersededExamples, type ProjectConfig, type ProposalDraft, type Refusal, type Result, type RuleSpec } from "@design-harness/core";
import { nook } from "../../../../packages/core/examples/nook/project";
import { seedSpec } from "../../test/nook";
import { drafted, toastDraft, withSpecToasts } from "../../test/proposals";
import { proposalTimeline, timelineTitle } from "./timeline";
import { applyExampleFix, choiceFindings, exampleFixes, fixNote, prototypeChoices } from "./fix-examples";
import { replacedWords } from "./replaced";
import { waitingWords } from "./waiting";

function ok<T>(result: Result<T, Refusal | string>): T {
  if (!result.ok) throw new Error(`refused: ${JSON.stringify(result.error)}`);
  return result.value;
}

const refusalOf = (config: ProjectConfig, id = "booking-toast"): Refusal => {
  const tried = dryRunAdoption(config, id, { at: "dry run" });
  if (tried.ok) throw new Error("expected core to refuse");
  return tried.error;
};
const proposalOf = (config: ProjectConfig, id = "booking-toast") => {
  const found = config.proposals.find((item) => item.id === id);
  if (!found) throw new Error(`no proposal ${id}`);
  return found;
};

/** The project's own prototypes, as the review page has them measured. */
const existing = [
  { name: "Booking", prototype: seedSpec() },
  { name: "One toast", prototype: withSpecToasts(1) },
  { name: "Two toasts", prototype: withSpecToasts(2) },
  { name: "Three toasts", prototype: withSpecToasts(3) },
];

describe("fixing a proposal's examples yourself", () => {
  it("offers, for a Not allowed example the rule does not catch, only the prototypes the rule catches alone, and replaces it as a revision by you", () => {
    const config = drafted(toastDraft(1));
    const refusal = refusalOf(config);
    expect(refusal.code).toBe("failing-example-passes");
    const fixes = exampleFixes(config, proposalOf(config), refusal, existing);
    expect(fixes).toEqual({ target: { name: "toasts", expect: "fail" }, side: "fail", rule: "one-toast-per-page", canRemove: false, choices: [{ name: "Two toasts" }, { name: "Three toasts" }] });
    const fixed = ok(applyExampleFix(config, "booking-toast", { kind: "use", prototype: "Two toasts", side: "fail", rule: "one-toast-per-page", replaces: { name: "toasts", expect: "fail" } }, existing, "2026-11-20T10:00:00.000Z"));
    const proposal = proposalOf(fixed);
    expect(proposal.status).toBe("open");
    expect(proposal.examples.fail.map((item) => [item.name, item.flaggedBy])).toEqual([["two-toasts", { rule: "one-toast-per-page" }]]);
    // History records who revised it, when, and what changed; the version it replaced is kept.
    const revised = proposalTimeline(proposal).at(-1);
    expect(revised && [timelineTitle(revised), revised.at, "note" in revised ? revised.note : undefined]).toEqual(["Revised by you", "2026-11-20T10:00:00.000Z", "Put the prototype “Two toasts” in place of the “Not allowed” example “Toasts”."]);
    expect(revised?.kind === "revised" && revised.previous.examples.fail.map((item) => item.name)).toEqual(["toasts"]);
    // Core now adopts it.
    expect(dryRunAdoption(fixed, "booking-toast", { at: "dry run" }).ok).toBe(true);
  });

  it("takes out an example the proposal has enough without, and never one core needs", () => {
    const extra: ProposalDraft = { ...toastDraft(), examples: { ...toastDraft().examples, fail: [...toastDraft().examples.fail, { name: "only-one", prototype: withSpecToasts(1), flaggedBy: { rule: "one-toast-per-page" } }] } };
    const config = drafted(extra);
    const refusal = refusalOf(config);
    expect([refusal.code, refusal.example]).toEqual(["failing-example-passes", "only-one"]);
    const fixes = exampleFixes(config, proposalOf(config), refusal, existing);
    expect(fixes?.canRemove).toBe(true);
    const fixed = ok(applyExampleFix(config, "booking-toast", { kind: "remove", example: { name: "only-one", expect: "fail" } }, existing, "t"));
    expect(proposalOf(fixed).examples.fail.map((item) => item.name)).toEqual(["toasts"]);
    expect(dryRunAdoption(fixed, "booking-toast", { at: "dry run" }).ok).toBe(true);
    // The proposal's one Not allowed example is not removable: core needs one for the rule it adds.
    const single = drafted(toastDraft(1));
    expect(exampleFixes(single, proposalOf(single), refusalOf(single), existing)?.canRemove).toBe(false);
  });

  it("offers, for an Allowed example that breaks a rule, the prototypes that pass every rule with the change", () => {
    const config = drafted({ ...toastDraft(), examples: { ...toastDraft().examples, pass: [{ name: "too-many", prototype: withSpecToasts(3) }] } });
    const refusal = refusalOf(config);
    expect(refusal.code).toBe("passing-example-fails");
    const fixes = exampleFixes(config, proposalOf(config), refusal, existing);
    expect(fixes?.choices).toEqual([{ name: "Booking" }, { name: "One toast" }]);
    const fixed = ok(applyExampleFix(config, "booking-toast", { kind: "use", prototype: "One toast", side: "pass", replaces: { name: "too-many", expect: "pass" } }, existing, "t"));
    expect(proposalOf(fixed).examples.pass.map((item) => item.name)).toEqual(["one-toast"]);
    expect(dryRunAdoption(fixed, "booking-toast", { at: "dry run" }).ok).toBe(true);
  });

  it("offers nothing for an earlier proposal's example, or a refusal that is not about examples, and refuses a prototype the project lacks", () => {
    const config = drafted(toastDraft(1));
    const proposal = proposalOf(config);
    expect(exampleFixes(config, proposal, { code: "breaks-adopted-example", message: "m", proposal: "earlier", example: "toasts" }, existing)).toBeNull();
    expect(exampleFixes(config, proposal, { code: "cannot-apply", message: "m" }, existing)).toBeNull();
    expect(applyExampleFix(config, "booking-toast", { kind: "use", prototype: "Gone", side: "fail", rule: "one-toast-per-page" }, existing, "t")).toMatchObject({ ok: false, error: { code: "invalid-proposal" } });
    expect(prototypeChoices(config, proposal, "fail", "one-toast-per-page", [])).toEqual([]);
    expect(fixNote({ kind: "use", prototype: "Two toasts", side: "fail", rule: "one-toast-per-page" })).toBe("Added the prototype “Two toasts” as a “Not allowed” example.");
  });
});

describe("what a change replaces, in words", () => {
  const onePrimary = nook.rules.find((rule) => rule.id === "one-primary-per-page") as RuleSpec;
  const atMost = (max: number) => ({ ...onePrimary, max }) as RuleSpec;

  it("names each earlier example it replaces and the change it came from, before and after acceptance", () => {
    const loosen = (id: string, max: number, examples: ProposalDraft["examples"]): ProposalDraft => ({ id, title: `Allow ${max} primary actions`, reason: "Why.", states: [], inventory: [], rules: { remove: [onePrimary.id], add: [atMost(max)] }, examples });
    const two = withPrimaries(1);
    const three = withPrimaries(2);
    const four = withPrimaries(3);
    const first = loosen("allow-two", 2, { pass: [{ name: "two-primaries", prototype: two }], fail: [{ name: "three-primaries", prototype: three, flaggedBy: { rule: onePrimary.id } }] });
    const adopted = ok(adopt(ok(approve(ok(propose(nook, first, { at: "t0" })), "allow-two", { at: "t1" })), "allow-two", { at: "t2" })).config;
    const second = ok(propose(adopted, loosen("allow-three", 3, { pass: [{ name: "three-ok", prototype: three }], fail: [{ name: "four-primaries", prototype: four, flaggedBy: { rule: onePrimary.id } }] }), { at: "t3" }));
    const superseded = ok(supersededExamples(second, "allow-three"));
    expect(replacedWords(second, superseded)).toBe("This replaces 1 example from an earlier change: “Three primaries” (from “Allow 2 primary actions”). It shows the rule as it was, so accepting this retires it.");
    const accepted = ok(adopt(ok(approve(second, "allow-three", { at: "t4" })), "allow-three", { at: "t5" })).config;
    expect(replacedWords(accepted, proposalOf(accepted, "allow-three").supersedes ?? [], true)).toBe("This replaced 1 example from an earlier change: “Three primaries” (from “Allow 2 primary actions”). It showed the rule as it was, so it was retired.");
    expect(rerunExamples(accepted).every((run) => run.ok)).toBe(true);
    expect(replacedWords(accepted, [])).toBe("");
  });
});

describe("where the rule catches a prototype offered as an example", () => {
  it("is core's own findings for that rule with the proposal applied, naming the elements to outline, and nothing for a prototype it passes", () => {
    const config = drafted(toastDraft(1));
    const two = existing.find((item) => item.name === "Two toasts");
    const one = existing.find((item) => item.name === "One toast");
    if (!two || !one) throw new Error("the fixtures have a prototype with two toasts and one with one");
    const findings = choiceFindings(config, proposalOf(config), "one-toast-per-page", two);
    expect(findings.map((finding) => [finding.rule, finding.page])).toEqual([["one-toast-per-page", "booking"]]);
    expect(findings[0]?.targets?.map((target) => target.key)).toEqual(["toast-1", "toast-2"]);
    expect(choiceFindings(config, proposalOf(config), "one-toast-per-page", one)).toEqual([]);
    expect(choiceFindings(config, proposalOf(config), "no-such-rule", two)).toEqual([]);
  });
});

describe("what drawing still waits for, in words", () => {
  it("says what is still being drawn and what could not be, by name", () => {
    const words = waitingWords([
      { kind: "example", name: "two-toasts", measurement: { state: "measuring", answered: 3, total: 8 } },
      { kind: "board", name: "Booking", measurement: { state: "measuring", answered: 0, total: 0 } },
      { kind: "prototype", name: "Early", measurement: { state: "failed", problems: [{ frame: "f", stage: "timeout", message: "The frame did not answer within 20 s." }] } },
      { kind: "example", name: "fine", measurement: { state: "measured", snapshots: [] } },
    ]);
    expect(words.waiting).toEqual(["The example “Two toasts”: 3 of 8 screens drawn.", "Your open prototype “Booking”: not started yet."]);
    expect(words.failed).toEqual(["Your prototype “Early” couldn't be drawn in one of its screens: The frame did not answer within 20 s."]);
    // The same lines, what failed first, with the thing's name apart from what is said of it.
    expect(words.rows.map((row) => [row.state, `${row.subject}${row.rest}`])).toEqual([["failed", words.failed[0]], ["waiting", words.waiting[0]], ["waiting", words.waiting[1]]]);
    expect(words.rows[0]?.subject).toBe("Your prototype “Early”");
  });

  it("counts screens, a scenario in a view, and never calls them views: 16 failed of 16 is every scenario in every view", () => {
    const problems = Array.from({ length: 16 }, (_, index) => ({ frame: `f${index}`, stage: "setup" as const, message: "Packages could not load" }));
    const failed = (screens: number | undefined, count: number) => waitingWords([{ kind: "example", name: "one-toast", measurement: { state: "failed", problems: problems.slice(0, count) }, ...(screens !== undefined ? { screens } : {}) }]).failed[0];
    expect(failed(16, 16)).toBe("The example “One toast” couldn't be drawn in 16 of its 16 screens: Packages could not load.");
    expect(failed(16, 1)).toBe("The example “One toast” couldn't be drawn in one of its 16 screens: Packages could not load.");
    expect(failed(undefined, 3)).toBe("The example “One toast” couldn't be drawn in 3 of its screens: Packages could not load.");
    expect(waitingWords([{ kind: "example", name: "one-toast", measurement: { state: "measuring", answered: 0, total: 1 } }]).waiting).toEqual(["The example “One toast”: 0 of 1 screen drawn."]);
  });
});

/** The legal spec with `count` primary Book room buttons in the question layout's hint slot, beside the page's own, which only one-primary-per-page reads. */
function withPrimaries(count: number) {
  const base = seedSpec();
  const keys = Array.from({ length: count }, (_, index) => `book-early-${index + 1}`);
  const question = '"answer": { "$bindState": "/duration" } }, "children": [] },';
  const before = base.files["pages/booking.json"] ?? "";
  const file = before.replace(question, `"answer": { "$bindState": "/duration" } }, "slots": { "hint": [${keys.map((key) => `"${key}"`).join(", ")}] }, "children": [] },\n${keys.map((key) => `    "${key}": { "type": "Button.Root", "props": { "text": "Book room" }, "children": [] },`).join("\n")}`);
  if (file === before) throw new Error("the booking page has no question to put primaries in");
  return { ...base, files: { ...base.files, "pages/booking.json": file } };
}
