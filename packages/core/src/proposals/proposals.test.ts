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
import { legalSnapshots } from "../../examples/nook/snapshots";
import { parseProjectConfig } from "../parse";
import { adopt, approve, contentOf, decline, dryRunAdoption, propose, rerunExamples, revise, sendBack, tryExamples, withExampleSnapshots, type ProposalDraft, type Refusal } from "./lifecycle";

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

  it("says a moved step budget before and after in the words of a limit, with the way it moved", () => {
    const changes = (value: number) => classifyProposal({ ...draft("x"), status: "open", history: [{ status: "open", at: "t" }], inventory: [{ op: "set-max-steps", task: "book-room", value }], rules: { add: [], remove: [] } }, nook).changes;
    expect(changes(2)).toEqual([{ change: 'set-max-steps "book-room" to 2', class: "tightens", reason: "lowers max steps from 3 to 2", bounds: [{ bound: "max", before: "at most 3", after: "at most 2", direction: "stricter" }] }]);
    expect(changes(4)).toEqual([{ change: 'set-max-steps "book-room" to 4', class: "loosens-or-removes", reason: "raises max steps from 3 to 4", bounds: [{ bound: "max", before: "at most 3", after: "at most 4", direction: "looser" }] }]);
    // A task the config does not have has no budget to say.
    expect(classifyProposal({ ...draft("x"), status: "open", history: [{ status: "open", at: "t" }], inventory: [{ op: "set-max-steps", task: "no-such-task", value: 2 }], rules: { add: [], remove: [] } }, nook).changes[0]).toEqual({ change: 'set-max-steps "no-such-task" to 2', class: "loosens-or-removes", reason: "names a task the config does not have" });
  });
});

/** A rendered rule only a measurement can prove: Harbor's open button is in the first view. */
const harborRule: RuleSpec = { type: "rendered", id: "harbor-in-first-view", check: "first-view", action: "Open Harbor" };

/** The legal snapshots with Harbor's open button pushed below the fold on the phone, as a long intro would. */
function harborBelowFold() {
  return legalSnapshots().map((snapshot) =>
    snapshot.scenario === "rooms-list" && snapshot.view === "phone"
      ? { ...snapshot, elements: snapshot.elements.map((element) => (element.name === "Open Harbor" ? { ...element, rect: { ...element.rect, y: 1200 } } : element)) }
      : snapshot,
  );
}

function harborDraft(): ProposalDraft {
  return {
    ...draft("harbor"),
    title: "Keep Harbor in the first view",
    inventory: [],
    rules: { add: [harborRule], remove: [] },
    examples: { pass: [{ name: "as-is", prototype: legal }], fail: [{ name: "long-intro", prototype: legal, flaggedBy: { rule: "harbor-in-first-view" } }] },
  };
}

describe("a revision", () => {
  it("replaces an open proposal's content, keeps its status history, and keeps the version it replaced", () => {
    const opened = ok(propose(nook, draft("toast"), { at: "t0", by: "agent" }));
    const revised = ok(revise(opened, "toast", { ...draft("toast"), title: "One toast per page" }, { at: "t1", by: "agent", note: "Shorter title." }));
    const proposal = revised.proposals.find((item) => item.id === "toast");
    expect(proposal?.title).toBe("One toast per page");
    expect(proposal?.status).toBe("open");
    expect(proposal?.history).toEqual([{ status: "open", at: "t0", by: "agent" }]);
    expect(proposal?.events).toEqual([{ kind: "revised", at: "t1", by: "agent", note: "Shorter title.", previous: contentOf(draft("toast")) }]);
    const again = ok(revise(revised, "toast", { ...draft("toast"), title: "At most one toast" }, { at: "t2", by: "agent" }));
    expect(again.proposals[0]?.events?.map((event) => (event.kind === "revised" ? event.previous.title : event.note))).toEqual(["Add a toast for booking confirmations", "One toast per page"]);
  });

  it("is refused for a proposal that is not open, an id that differs, a draft that changes nothing, and an invalid draft", () => {
    const opened = ok(propose(nook, draft("toast"), { at: "t0" }));
    const approvedOne = ok(approve(opened, "toast", { at: "t1" }));
    expect(refusal(revise(approvedOne, "toast", { ...draft("toast"), title: "x" }, { at: "t2" }))).toMatchObject({ code: "wrong-status", message: 'proposal "toast" is approved; only an open proposal can be revised' });
    expect(refusal(revise(opened, "toast", draft("other"), { at: "t2" })).code).toBe("invalid-proposal");
    expect(refusal(revise(opened, "toast", draft("toast"), { at: "t2" }))).toMatchObject({ code: "unchanged" });
    expect(refusal(revise(opened, "missing", draft("missing"), { at: "t2" })).code).toBe("not-found");
    const invalid = { ...draft("toast"), examples: { pass: [{ name: "same", prototype: oneToast }], fail: [{ name: "same", prototype: twoToasts, flaggedBy: { rule: "one-toast-per-page" } }] } };
    expect(refusal(revise(opened, "toast", invalid, { at: "t2" })).message).toContain('two examples are named "same"');
  });
});

describe("sending a proposal back", () => {
  it("records the note as an event and leaves the status as it is", () => {
    const opened = ok(propose(nook, draft("toast"), { at: "t0", by: "agent" }));
    const sent = ok(sendBack(opened, "toast", { at: "t1", by: "you", note: "  Name the toast's states.  " }));
    expect(sent.proposals[0]).toMatchObject({ status: "open", history: [{ status: "open", at: "t0", by: "agent" }], events: [{ kind: "sent-back", at: "t1", by: "you", note: "Name the toast's states." }] });
  });

  it("needs a note, and an open proposal", () => {
    const opened = ok(propose(nook, draft("toast"), { at: "t0" }));
    expect(refusal(sendBack(opened, "toast", { at: "t1", by: "you", note: " " }))).toMatchObject({ code: "missing-note" });
    expect(refusal(sendBack(opened, "toast", { at: "t1", by: "you" }))).toMatchObject({ code: "missing-note" });
    expect(refusal(sendBack(ok(decline(opened, "toast", { at: "t1" })), "toast", { at: "t2", note: "x" })).code).toBe("wrong-status");
  });
});

describe("trying a proposal's examples one by one", () => {
  it("judges every example as adopt would, in core's words, without stopping at the first", () => {
    const config = ok(propose(nook, draft("toast", { pass: [{ name: "two-passing", prototype: twoToasts }], fail: [{ name: "only-one", prototype: oneToast, flaggedBy: { rule: "one-toast-per-page" } }, { name: "two-toasts", prototype: twoToasts, flaggedBy: { rule: "one-toast-per-page" } }] }), { at: "t0" }));
    const tried = ok(tryExamples(config, "toast"));
    expect(tried.config.rules.some((rule) => rule.id === "one-toast-per-page")).toBe(true);
    expect(tried.results.map((result) => [result.example, result.expect, result.ok, result.refusal?.code])).toEqual([
      ["two-passing", "pass", false, "passing-example-fails"],
      ["only-one", "fail", false, "failing-example-passes"],
      ["two-toasts", "fail", true, undefined],
    ]);
    expect(tried.results[1]?.detail).toBe('failing example "only-one" is not flagged as it must be: "one-toast-per-page" passed it');
    expect(tried.results[2]?.detail).toBe('flagged by "one-toast-per-page" and no other rule');
    // adopt's refusal is the first example that does not behave, word for word.
    expect(refusal(adopt(ok(approve(config, "toast", { at: "t1" })), "toast", { at: "t2" }))).toEqual(tried.results[0]?.refusal);
  });

  it("refuses a proposal that is adopted or declined, or cannot apply", () => {
    const adopted = ok(adopt(approved(nook, draft("toast")), "toast", { at: "t" })).config;
    expect(refusal(tryExamples(adopted, "toast")).code).toBe("wrong-status");
    const again = ok(propose(nook, { ...draft("again"), inventory: [{ op: "add-component", name: "Button" }] }, { at: "t" }));
    expect(refusal(tryExamples(again, "again")).code).toBe("cannot-apply");
  });
});

describe("a proposal that adds a rendered rule", () => {
  it("cannot be adopted on unmeasured examples, and is adopted on measured ones", () => {
    const config = approved(nook, harborDraft());
    expect(refusal(adopt(config, "harbor", { at: "t" }))).toMatchObject({ code: "unproven-rule", message: 'passing example "as-is" does not run the new rule "harbor-in-first-view": no rendered snapshots were given' });
    const measured = ok(withExampleSnapshots(config, "harbor", { "as-is": legalSnapshots(), "long-intro": harborBelowFold() }));
    const adoption = ok(adopt(measured, "harbor", { at: "t1", by: "you" }));
    const proposal = adoption.config.proposals.find((item) => item.id === "harbor");
    expect(proposal?.classification).toEqual(adoption.classification);
    expect(proposal?.examples.fail[0]?.snapshots).toEqual(harborBelowFold());
    expect(rerunExamples(adoption.config)).toEqual([
      { proposal: "harbor", example: "as-is", expect: "pass", ok: true, detail: "passes every rule" },
      { proposal: "harbor", example: "long-intro", expect: "fail", ok: true, detail: 'flagged by "harbor-in-first-view"' },
    ]);
  });

  it("gives the same results from its stored snapshots after a round trip through JSON, as a reload does", () => {
    const measured = ok(withExampleSnapshots(approved(nook, harborDraft()), "harbor", { "as-is": legalSnapshots(), "long-intro": harborBelowFold() }));
    const adoption = ok(adopt(measured, "harbor", { at: "t1", by: "you" }, [{ name: "booking", prototype: legal, snapshots: harborBelowFold() }]));
    const reloaded = JSON.parse(JSON.stringify(adoption.config)) as ProjectConfig;
    expect(rerunExamples(reloaded)).toEqual(rerunExamples(adoption.config));
    const stored = JSON.parse(JSON.stringify(measured)) as ProjectConfig;
    expect(adopt(stored, "harbor", { at: "t1", by: "you" }, [{ name: "booking", prototype: legal, snapshots: harborBelowFold() }])).toEqual({ ok: true, value: adoption });
    expect(adoption.newlyFailing.map((item) => [item.name, item.rules])).toEqual([["booking", ["harbor-in-first-view"]]]);
  });

  it("stores only a complete measurement: every example, every scenario at every view, once", () => {
    const config = approved(nook, harborDraft());
    expect(refusal(withExampleSnapshots(config, "harbor", { "as-is": legalSnapshots() }))).toMatchObject({ code: "incomplete-measurement", example: "long-intro", message: 'example "long-intro" is not measured' });
    expect(refusal(withExampleSnapshots(config, "harbor", { "as-is": legalSnapshots().slice(1), "long-intro": harborBelowFold() })).message).toBe('example "as-is" has no snapshot of scenario "rooms-list" at view "desktop"; it needs exactly one');
    expect(refusal(withExampleSnapshots(config, "harbor", { "as-is": [...legalSnapshots(), ...legalSnapshots().slice(0, 1)], "long-intro": harborBelowFold() })).message).toContain("has 2 snapshots of scenario \"rooms-list\"");
    expect(refusal(withExampleSnapshots(config, "harbor", { "as-is": legalSnapshots(), "long-intro": harborBelowFold(), other: [] })).message).toBe('snapshots are given for "other", which is not an example of "harbor"');
    const malformed = legalSnapshots().map((snapshot, index) => (index === 0 ? { ...snapshot, scrollWidth: "wide" } : snapshot)) as unknown as ReturnType<typeof legalSnapshots>;
    expect(refusal(withExampleSnapshots(config, "harbor", { "as-is": malformed, "long-intro": harborBelowFold() })).message).toContain("scrollWidth");
    const adopted = ok(adopt(ok(withExampleSnapshots(config, "harbor", { "as-is": legalSnapshots(), "long-intro": harborBelowFold() })), "harbor", { at: "t" })).config;
    expect(refusal(withExampleSnapshots(adopted, "harbor", { "as-is": legalSnapshots(), "long-intro": legalSnapshots() })).code).toBe("wrong-status");
  });

  it("is refused when its failing example's measurement does not fail it", () => {
    const measured = ok(withExampleSnapshots(approved(nook, harborDraft()), "harbor", { "as-is": legalSnapshots(), "long-intro": legalSnapshots() }));
    expect(refusal(adopt(measured, "harbor", { at: "t" }))).toMatchObject({ code: "failing-example-passes", example: "long-intro", message: 'failing example "long-intro" is not flagged as it must be: "harbor-in-first-view" passed it' });
  });
});

describe("a stored proposal", () => {
  it("parses back with its events and classification, and refuses a malformed event", () => {
    const opened = ok(propose(nook, draft("toast"), { at: "t0", by: "agent" }));
    const sent = ok(sendBack(opened, "toast", { at: "t1", by: "you", note: "Tighter." }));
    const revised = ok(revise(sent, "toast", { ...draft("toast"), title: "Tighter" }, { at: "t2", by: "agent" }));
    const adopted = ok(adopt(ok(approve(revised, "toast", { at: "t3", by: "you" })), "toast", { at: "t4", by: "you" })).config;
    const parsed = parseProjectConfig(JSON.parse(JSON.stringify(adopted)));
    expect(parsed.ok && parsed.value).toEqual(adopted);
    const broken = { ...adopted, proposals: adopted.proposals.map((proposal) => ({ ...proposal, events: [{ kind: "sent-back", at: "t" }] })) };
    const refused = parseProjectConfig(JSON.parse(JSON.stringify(broken)));
    expect(refused.ok).toBe(false);
  });
});
