import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nook } from "../../examples/nook/project";
import { EXAMPLES, loadPrototype } from "../../test/fixtures";
import type { ProjectConfig } from "../config/types";
import { checkPrototype } from "../engine/check";
import type { Prototype } from "../prototype/types";
import type { RuleSpec } from "../rules/types";
import type { Result } from "../validate";
import { classifyProposal } from "./classify";
import { adopt, approve, decline, dryRunAdoption, propose, rerunExamples, type ProposalDraft, type Refusal } from "./lifecycle";

const legal = loadPrototype(join(EXAMPLES, "legal", "booking"));

/** The legal prototype with the booking page's facts slot holding `facts`. */
function withFacts(facts: string, extraImport = ""): Prototype {
  const file = legal.files["pages/booking.tsx"] ?? "";
  const changed = file
    .replace('import { Button, Text } from "@tounsoo/todae";', `import { Button, Text, Toast } from "@tounsoo/todae";${extraImport}`)
    .replace(/<Slot name="facts">[\s\S]*?<\/Slot>/, `<Slot name="facts">${facts}</Slot>`);
  return { ...legal, files: { ...legal.files, "pages/booking.tsx": changed } };
}

const oneToast = withFacts(`<Toast.Root>Booked</Toast.Root>`);
const twoToasts = withFacts(`<Toast.Root>Booked</Toast.Root><Toast.Root>Again</Toast.Root>`);
const twoToastsAndRaw = withFacts(`<Toast.Root>Booked</Toast.Root><Toast.Root>Again</Toast.Root><button>raw</button>`);

const toastRule: RuleSpec = { type: "count", id: "one-toast-per-page", scope: "page", select: { component: "Toast.Root" }, max: 1, description: "A page shows at most one toast." };

function draft(id: string, examples: Partial<ProposalDraft["examples"]> = {}): ProposalDraft {
  return {
    id,
    title: "Add a toast for booking confirmations",
    reason: "A booked room needs a confirmation that does not move the page.",
    states: [
      { state: "Booked", note: "the toast says the room is booked" },
      { state: "Error", note: "Out of scope, booking is local" },
    ],
    inventory: [{ op: "add-component", name: "Toast" }],
    rules: { add: [toastRule], remove: [] },
    examples: {
      pass: examples.pass ?? [{ name: "one-toast", prototype: oneToast }],
      fail: examples.fail ?? [{ name: "two-toasts", prototype: twoToasts, flaggedBy: { rule: "one-toast-per-page", message: "has 2 Toast.Root" } }],
    },
  };
}

function ok<T>(result: Result<T, Refusal>): T {
  if (!result.ok) throw new Error(`refused: ${result.error.code}: ${result.error.message}`);
  return result.value;
}

function refusal<T>(result: Result<T, Refusal>): Refusal {
  if (result.ok) throw new Error("expected a refusal");
  return result.error;
}

/** Proposes and approves a draft, as the caller's clock and reviewer would. */
function approved(config: ProjectConfig, proposal: ProposalDraft): ProjectConfig {
  return ok(approve(ok(propose(config, proposal, { at: "2026-11-17T09:00:00Z", by: "agent" })), proposal.id, { at: "2026-11-17T10:00:00Z", by: "ben" }));
}

describe("an adoption dry run", () => {
  it("tells what adopting an open proposal would do, and leaves the config as it was", () => {
    const config = ok(propose(nook, draft("toast"), { at: "2026-11-17T09:00:00Z", by: "agent" }));
    const frozen = JSON.stringify(config);
    const tried = ok(dryRunAdoption(config, "toast", { at: "2026-11-17T09:00:01Z", by: "agent" }, [{ name: "toast-heavy", prototype: twoToasts }]));
    expect(tried.classification.class).toBe("tightens");
    expect(tried.newlyFailing.map((item) => item.name)).toEqual(["toast-heavy"]);
    expect(JSON.stringify(config)).toBe(frozen);
    expect(config.proposals.find((item) => item.id === "toast")?.status).toBe("open");
  });

  it("gives adopt's refusal, word for word, and refuses what can no longer change", () => {
    const config = ok(propose(nook, draft("toast", { fail: [{ name: "only-one", prototype: oneToast, flaggedBy: { rule: "one-toast-per-page" } }] }), { at: "t" }));
    expect(refusal(dryRunAdoption(config, "toast", { at: "t" }))).toMatchObject({ code: "failing-example-passes", message: 'failing example "only-one" is not flagged as it must be: "one-toast-per-page" passed it' });
    const declined = ok(decline(config, "toast", { at: "t" }));
    expect(refusal(dryRunAdoption(declined, "toast", { at: "t" }))).toMatchObject({ code: "wrong-status" });
    expect(refusal(dryRunAdoption(nook, "missing", { at: "t" }))).toMatchObject({ code: "not-found" });
  });
});

describe("a proposal that adds a component with a governing rule", () => {
  it("is refused while open: it must be approved first", () => {
    const config = ok(propose(nook, draft("toast"), { at: "2026-11-17T09:00:00Z" }));
    expect(refusal(adopt(config, "toast", { at: "2026-11-17T11:00:00Z" }))).toMatchObject({ code: "wrong-status", message: 'proposal "toast" is open; it must be approved before it is adopted' });
  });

  it("is refused when its failing example does not fail", () => {
    const config = approved(nook, draft("toast", { fail: [{ name: "only-one", prototype: oneToast, flaggedBy: { rule: "one-toast-per-page" } }] }));
    expect(refusal(adopt(config, "toast", { at: "2026-11-17T11:00:00Z" }))).toMatchObject({
      code: "failing-example-passes",
      example: "only-one",
      message: 'failing example "only-one" is not flagged as it must be: "one-toast-per-page" passed it',
    });
  });

  it("is refused when its failing example fails for the wrong reason, or for another reason too", () => {
    const wrongWords = approved(nook, draft("toast", { fail: [{ name: "two-toasts", prototype: twoToasts, flaggedBy: { rule: "one-toast-per-page", message: "three toasts" } }] }));
    expect(refusal(adopt(wrongWords, "toast", { at: "t" })).message).toContain(`"one-toast-per-page" flagged it, but no finding says "three toasts"; it said: one-toast-per-page: Page "booking" has 2 Toast.Root`);
    const alsoRaw = approved(nook, draft("toast", { fail: [{ name: "two-and-raw", prototype: twoToastsAndRaw, flaggedBy: { rule: "one-toast-per-page" } }] }));
    expect(refusal(adopt(alsoRaw, "toast", { at: "t" }))).toMatchObject({ code: "fails-for-another-reason", example: "two-and-raw" });
  });

  it("is refused when its passing example fails", () => {
    const config = approved(nook, draft("toast", { pass: [{ name: "two-passing", prototype: twoToasts }] }));
    const refused = refusal(adopt(config, "toast", { at: "2026-11-17T11:00:00Z" }));
    expect(refused).toMatchObject({ code: "passing-example-fails", example: "two-passing" });
    expect(refused.message).toMatch(/^passing example "two-passing" fails "one-toast-per-page": one-toast-per-page: Page "booking" has 2 Toast.Root, more than 1: Toast.Root "Booked"/);
  });

  it("is refused without examples, or with a new rule no failing example names", () => {
    expect(refusal(adopt(approved(nook, draft("toast", { fail: [] })), "toast", { at: "t" })).code).toBe("missing-examples");
    const unnamed = approved(nook, draft("toast", { fail: [{ name: "raw", prototype: withFacts(`<button>raw</button>`), flaggedBy: { rule: "no-raw-controls" } }] }));
    expect(refusal(adopt(unnamed, "toast", { at: "t" }))).toMatchObject({ code: "unproven-rule", message: 'rule "one-toast-per-page" has no failing example that names it, so nothing shows it fires' });
  });

  it("is adopted when both examples behave, and the new rule then flags a fresh violating prototype", () => {
    const config = approved(nook, draft("toast"));
    const existing = [
      { name: "rooms-today", prototype: legal },
      { name: "toast-heavy", prototype: twoToasts },
    ];
    const adoption = ok(adopt(config, "toast", { at: "2026-11-17T11:00:00Z", by: "ben" }, existing));

    expect(adoption.classification).toEqual({
      class: "tightens",
      changes: [
        { change: 'add-component "Toast"', class: "adds", reason: "grows an inventory" },
        { change: 'add rule "one-toast-per-page"', class: "tightens", reason: "a new rule can only fail more prototypes" },
      ],
    });
    expect(adoption.newlyFailing.map((item) => [item.name, item.rules])).toEqual([["toast-heavy", ["one-toast-per-page"]]]);
    expect(adoption.retiredExamples).toEqual([]);
    const proposal = adoption.config.proposals.find((item) => item.id === "toast");
    expect(proposal?.status).toBe("adopted");
    expect(proposal?.history.map((entry) => [entry.status, entry.at, entry.by])).toEqual([
      ["open", "2026-11-17T09:00:00Z", "agent"],
      ["approved", "2026-11-17T10:00:00Z", "ben"],
      ["adopted", "2026-11-17T11:00:00Z", "ben"],
    ]);
    expect(adoption.config.inventories.components).toContain("Toast");

    // A prototype written after adoption, with two toasts on the rooms page under an alias.
    const rooms = (legal.files["pages/rooms.tsx"] ?? "")
      .replace('import { Text } from "@tounsoo/todae";', 'import { Text, Toast as Note } from "@tounsoo/todae";')
      .replace('<Text.Root as="p">Pick a free room to book or hold.</Text.Root>', '<Text.Root as="p">Pick a free room to book or hold.</Text.Root>\n        <Note.Root>Lantern is free</Note.Root>\n        <Note.Root>Harbor is free</Note.Root>');
    const freshTwo: Prototype = { ...legal, files: { ...legal.files, "pages/rooms.tsx": rooms } };
    const report = checkPrototype({ config: adoption.config, prototype: freshTwo });
    expect(report.rules.filter((rule) => rule.status === "fail").map((rule) => rule.rule)).toEqual(["one-toast-per-page"]);
    expect(report.findings[0]?.message).toContain(`Page "rooms" has 2 Toast.Root, more than 1: Toast.Root "Lantern is free" at pages/rooms.tsx`);

    expect(rerunExamples(adoption.config)).toEqual([
      { proposal: "toast", example: "one-toast", expect: "pass", ok: true, detail: "passes every rule" },
      { proposal: "toast", example: "two-toasts", expect: "fail", ok: true, detail: 'flagged by "one-toast-per-page"' },
    ]);
  });

  it("keeps its examples as regression tests: removing its rule later retires its failing example", () => {
    const adopted = ok(adopt(approved(nook, draft("toast")), "toast", { at: "t1" })).config;
    const removal: ProposalDraft = {
      ...draft("drop-toast-cap"),
      title: "Let pages show any number of toasts",
      inventory: [],
      rules: { add: [], remove: ["one-toast-per-page"] },
      examples: { pass: [{ name: "two-toasts-pass", prototype: twoToasts }], fail: [{ name: "raw", prototype: withFacts(`<button>raw</button>`), flaggedBy: { rule: "no-raw-controls" } }] },
    };
    const adoption = ok(adopt(approved(adopted, removal), "drop-toast-cap", { at: "t2" }));
    expect(adoption.classification.class).toBe("loosens-or-removes");
    const retired = { proposal: "toast", example: "two-toasts", expect: "fail", ok: true, detail: 'retired: proposal "drop-toast-cap" removed rule "one-toast-per-page", which it proves', retiredBy: "drop-toast-cap" };
    expect(adoption.retiredExamples).toEqual([retired]);
    expect(rerunExamples(adoption.config).filter((run) => run.proposal === "toast")).toEqual([{ proposal: "toast", example: "one-toast", expect: "pass", ok: true, detail: "passes every rule" }, retired]);
  });

  it("is refused when it makes an earlier adopted proposal's passing example fail", () => {
    const adopted = ok(adopt(approved(nook, draft("toast")), "toast", { at: "t1" })).config;
    const noToasts: ProposalDraft = {
      ...draft("no-toasts"),
      title: "No toasts at all",
      inventory: [],
      rules: { add: [{ ...toastRule, id: "no-toasts", max: 0, description: "A page shows no toast." }], remove: [] },
      examples: { pass: [{ name: "plain", prototype: legal }], fail: [{ name: "one-toast-fails", prototype: oneToast, flaggedBy: { rule: "no-toasts" } }] },
    };
    const refused = refusal(adopt(approved(adopted, noToasts), "no-toasts", { at: "t2" }));
    expect(refused).toMatchObject({ code: "breaks-adopted-example", proposal: "toast", example: "one-toast" });
    expect(refused.message).toMatch(/^adopting "no-toasts" breaks passing example "one-toast" of adopted proposal "toast": fails no-toasts: Page "booking" has 1 Toast.Root, more than 0/);
  });

  it("is refused when an earlier failing example stops failing while its rule stays in force, even under a replaced rule of the same id", () => {
    const adopted = ok(adopt(approved(nook, draft("toast")), "toast", { at: "t1" })).config;
    const threeToasts = withFacts(`<Toast.Root>One</Toast.Root><Toast.Root>Two</Toast.Root><Toast.Root>Three</Toast.Root>`);
    const twoAllowed: ProposalDraft = {
      ...draft("two-toasts-ok"),
      title: "Allow two toasts",
      inventory: [],
      rules: { add: [{ ...toastRule, max: 2 }], remove: ["one-toast-per-page"] },
      examples: { pass: [{ name: "two-pass", prototype: twoToasts }], fail: [{ name: "three-fail", prototype: threeToasts, flaggedBy: { rule: "one-toast-per-page" } }] },
    };
    expect(refusal(adopt(approved(adopted, twoAllowed), "two-toasts-ok", { at: "t2" }))).toMatchObject({
      code: "breaks-adopted-example",
      proposal: "toast",
      example: "two-toasts",
      message: 'adopting "two-toasts-ok" breaks failing example "two-toasts" of adopted proposal "toast": "one-toast-per-page" passed it',
    });
  });
});

describe("the status lifecycle", () => {
  it("moves one step at a time and never out of declined or adopted", () => {
    const opened = ok(propose(nook, draft("toast"), { at: "t0" }));
    expect(refusal(propose(opened, draft("toast"), { at: "t0" })).code).toBe("duplicate-id");
    const declined = ok(decline(opened, "toast", { at: "t1", note: "not now" }));
    expect(refusal(approve(declined, "toast", { at: "t2" })).message).toBe('proposal "toast" is declined; it cannot change any more, not approved');
    expect(refusal(approve(nook, "missing", { at: "t" })).code).toBe("not-found");
  });

  it("rejects a malformed draft with the path of the problem", () => {
    const bad = { ...draft("Toast Proposal") };
    expect(refusal(propose(nook, bad, { at: "t" })).message).toContain('proposal.id: expected a lowercase slug such as "book-room", got "Toast Proposal"');
  });

  it("refuses an operation that cannot apply as written, and a change that leaves the config invalid", () => {
    const again: ProposalDraft = { ...draft("again"), inventory: [{ op: "add-component", name: "Button" }] };
    expect(refusal(adopt(approved(nook, again), "again", { at: "t" })).message).toBe('proposal "again" cannot apply: operation 1, add-component "Button": Button is already an inventoried component');
    const orphan: ProposalDraft = { ...draft("orphan"), inventory: [{ op: "remove-component", name: "Disclosure" }], rules: { add: [], remove: [] } };
    expect(refusal(adopt(approved(nook, orphan), "orphan", { at: "t" })).message).toContain('selects role "disclosure", which the library maps to Disclosure.Root, but Disclosure is not an inventoried component');
  });
});

describe("classification", () => {
  const classify = (inventory: ProposalDraft["inventory"], rules: ProposalDraft["rules"] = { add: [], remove: [] }) =>
    classifyProposal({ ...draft("x"), status: "open", history: [{ status: "open", at: "t" }], inventory, rules }, nook).class;

  it("is adds, tightens or loosens-or-removes, by the strictest reading of every change", () => {
    expect(classify([{ op: "add-layout", id: "side-panel" }])).toBe("adds");
    expect(classify([{ op: "set-cap", name: "TARGET_MIN_PX", value: 32 }])).toBe("tightens");
    expect(classify([{ op: "set-cap", name: "TARGET_MIN_PX", value: 20 }])).toBe("loosens-or-removes");
    expect(classify([{ op: "set-max-steps", task: "book-room", value: 2 }])).toBe("tightens");
    expect(classify([{ op: "set-max-steps", task: "book-room", value: 4 }])).toBe("loosens-or-removes");
    expect(classify([{ op: "add-disclosed-section", section: "Accessibility" }])).toBe("tightens");
    expect(classify([{ op: "add-layout", id: "side-panel" }, { op: "remove-layout", id: "room-cards" }])).toBe("loosens-or-removes");
    expect(classify([], { add: [], remove: ["no-raw-controls"] })).toBe("loosens-or-removes");
  });
});
