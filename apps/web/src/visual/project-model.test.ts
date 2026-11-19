import { describe, expect, it } from "vitest";
import { flowFacts, type Proposal, type RuleSpec } from "@design-harness/core";
import { nook } from "../../../../packages/core/examples/nook/project";
import { tally } from "../../../../packages/core/examples/tally/project";
import { seedLegal } from "../../test/nook";
import { RULE_GROUPS, budgetMeter, capDirection, capMeter, capReaders, capsRead, changeLine, groupRules, pageTypeWords, projectTimeline, proofPair, proposalPreview, proposalTrack, previewLabel, ruleBound, ruleGlyph, ruleGroup, ruleSource, slotRows, sortProposals } from "./project-model";

const proposal = (change: Partial<Proposal>): Proposal => ({ id: "p", title: "A change", reason: "Because.", states: [], inventory: [], rules: { add: [], remove: [] }, examples: { pass: [], fail: [] }, status: "open", history: [{ status: "open", at: "2026-11-01T10:00:00.000Z", by: "agent" }], ...change });
const toastRule: RuleSpec = { type: "count", id: "one-toast-per-page", select: { component: "Toast.Root" }, scope: "page", max: 1 };

describe("rule groups", () => {
  it("puts every rule of Nook and Tally in exactly one group, from its type and check alone", () => {
    for (const config of [nook, tally]) {
      const groups = groupRules(config.rules);
      expect(groups.flatMap((item) => item.rules.map((rule) => rule.id)).sort()).toEqual(config.rules.map((rule) => rule.id).sort());
      for (const { group, rules } of groups) for (const rule of rules) expect(ruleGroup(rule)).toBe(group.id);
    }
  });

  it("counts Nook's 32 rules by group, in the groups' order", () => {
    expect(groupRules(nook.rules).map((item) => [item.group.id, item.rules.length])).toEqual([
      ["count", 10],
      ["where", 4],
      ["rendered", 6],
      ["inventory", 5],
      ["flow", 2],
      ["code", 5],
    ]);
    expect(RULE_GROUPS.map((group) => group.id)).toEqual(["count", "where", "rendered", "inventory", "flow", "code"]);
  });

  it("has a group for every rule of both projects, and a glyph only for a rule about how a rendered page looks", () => {
    for (const rule of [...nook.rules, ...tally.rules]) {
      expect(RULE_GROUPS.map((group) => group.id)).toContain(ruleGroup(rule));
      expect(ruleGlyph(rule) !== null).toBe(rule.type === "rendered" && rule.check !== "accessible-names");
    }
  });

  it("groups a rule a proposal adds the day it is adopted, and draws no glyph for a count, a list, a flow or code", () => {
    expect(ruleGroup(toastRule)).toBe("count");
    expect(ruleGlyph(toastRule)).toBeNull();
    expect(ruleBound(toastRule, nook)).toBe("at most 1");
    expect(ruleGlyph({ type: "count", id: "some", select: { role: "primary-action" }, scope: "pages", min: 1 })).toBeNull();
    expect(ruleGroup({ type: "isolation", id: "no-ambient-globals" })).toBe("code");
    expect(ruleGlyph({ type: "isolation", id: "no-ambient-globals" })).toBeNull();
    expect(ruleGlyph({ type: "membership", id: "imports", of: "imports" })).toBeNull();
    expect(ruleGlyph({ type: "membership", id: "parts", of: "components" })).toBeNull();
    expect(ruleGlyph({ type: "rendered", id: "c", check: "contrast" })).toBe("contrast");
    expect(ruleGlyph({ type: "flow", id: "f", check: "step-budget" })).toBeNull();
    expect(ruleGlyph({ type: "rendered", id: "n", check: "accessible-names" })).toBeNull();
  });

  it("reads a cap's value into a rule's bound, and names the rules that read each cap", () => {
    const reader = nook.rules.find((rule) => capsRead(rule).includes("MAX_DISCLOSURES_PER_PAGE"));
    expect(reader && ruleBound(reader, nook)).toBe("at most 1");
    expect(capReaders(nook, "TARGET_MIN_PX").map((rule) => rule.id)).toEqual(["target-size"]);
    expect(capReaders(nook, "NO_SUCH_CAP")).toEqual([]);
    for (const name of Object.keys(nook.inputs.caps)) expect(capReaders(nook, name).length, name).toBeGreaterThan(0);
  });

  it("finds the adopted proposal a rule came from, and no other", () => {
    const config = { ...nook, rules: [...nook.rules, toastRule], proposals: [proposal({ id: "toast", status: "adopted", rules: { add: [toastRule], remove: [] } }), proposal({ id: "open-one", rules: { add: [{ ...toastRule, id: "another" }], remove: [] } })] };
    expect(ruleSource(config, "one-toast-per-page")?.id).toBe("toast");
    expect(ruleSource(config, "another")).toBeUndefined();
    expect(ruleSource(config, "primary-slot")).toBeUndefined();
  });
});

describe("page types, caps and budgets", () => {
  it("lays a page type's slots out in the project's order, each as chrome, body or the primary slot", () => {
    const [booking, rooms] = nook.inventories.pageTypes;
    if (!booking || !rooms) throw new Error("no page types");
    expect(slotRows(booking)).toEqual([
      { slot: "title", kind: "chrome" },
      { slot: "facts", kind: "chrome" },
      { slot: "body", kind: "body" },
      { slot: "alternate", kind: "chrome" },
      { slot: "action", kind: "primary" },
    ]);
    expect(slotRows(rooms).map((row) => row.kind)).toEqual(["chrome", "chrome", "body"]);
    expect(pageTypeWords(booking)).toEqual({ kind: "An action page: it ends in one primary action.", slots: "5 slots, 3 of them chrome. Primary slot: action." });
    expect(pageTypeWords(rooms).slots).toBe("3 slots, 2 of them chrome. No primary slot.");
  });

  it("draws a px cap at its size, leaves a count cap to its words, and says which way is stricter", () => {
    expect(capMeter("MAX_DISCLOSURES_PER_PAGE", { value: 1, stricter: "lower" })).toEqual({ kind: "number", value: 1, words: "at most 1", direction: "stricter when lower", title: "Disclosures per page" });
    expect(capMeter("TARGET_MIN_PX", { value: 24, stricter: "higher" })).toEqual({ kind: "size", value: 24, words: "at least 24 px", direction: "stricter when higher", title: "Target" });
    expect(capMeter("MAX_ROWS", { value: 40, stricter: "lower" }).kind).toBe("number");
    expect(capDirection({ stricter: "lower" }, 1, 2)).toBe("looser");
    expect(capDirection({ stricter: "lower" }, 2, 1)).toBe("stricter");
    expect(capDirection({ stricter: "higher" }, 24, 44)).toBe("stricter");
    expect(capDirection({ stricter: "higher" }, 24, 24)).toBe("the same");
  });

  it("says a budget in words, with today's longest route from core's flow facts for the open prototype, and nothing of today without one", () => {
    const facts = flowFacts(nook, seedLegal());
    const [book, hold] = nook.inputs.tasks;
    if (!book || !hold) throw new Error("no tasks");
    const booked = budgetMeter(book, facts.tasks.find((item) => item.task === book.id), "Booking");
    expect(booked).toEqual({ words: "at most 3 steps", today: { text: "Booking's longest route today: 3 steps, at the limit.", over: false } });
    expect(budgetMeter({ ...book, maxSteps: 5 }, facts.tasks.find((item) => item.task === book.id), "Booking").today?.text).toBe("Booking's longest route today: 3 steps.");
    const held = budgetMeter(hold, facts.tasks.find((item) => item.task === hold.id), "Booking");
    expect(held.today?.text).toBe("Booking's longest route today: 2 steps, at the limit.");
    // No picture of a count: a budget is its words alone.
    expect(Object.keys(booked).sort()).toEqual(["today", "words"]);
    expect(budgetMeter(book, undefined, undefined)).toEqual({ words: "at most 3 steps" });
    // Over the budget, in core's own count.
    const over = budgetMeter({ ...hold, maxSteps: 1 }, { ...(facts.tasks.find((item) => item.task === hold.id) as (typeof facts.tasks)[number]), status: "over" }, "Booking");
    expect(over).toEqual({ words: "at most 1 step", today: { text: "Booking's longest route today: 2 steps, 1 over the limit.", over: true } });
  });
});

describe("a proposal on its card and its track", () => {
  it("tracks each status, and ends a declined proposal at Declined", () => {
    const states = (status: Proposal["status"], history: Proposal["history"] = []) => proposalTrack({ status, history }).map((step) => `${step.id}:${step.state}`);
    expect(states("open")).toEqual(["drafted:done", "open:current", "approved:upcoming", "adopted:upcoming"]);
    expect(states("approved")).toEqual(["drafted:done", "open:done", "approved:current", "adopted:upcoming"]);
    expect(states("adopted")).toEqual(["drafted:done", "open:done", "approved:done", "adopted:current"]);
    expect(states("declined")).toEqual(["drafted:done", "open:done", "declined:current"]);
    expect(states("declined", [{ status: "open", at: "1" }, { status: "approved", at: "2" }, { status: "declined", at: "3" }])).toEqual(["drafted:done", "open:done", "approved:done", "declined:current"]);
  });

  it("leads with the first inventory change, else the first added rule", () => {
    expect(proposalPreview(proposal({ inventory: [{ op: "add-component", name: "Toast" }], rules: { add: [toastRule], remove: [] } }), nook)).toEqual({ kind: "component", name: "Toast", removed: false });
    expect(proposalPreview(proposal({ rules: { add: [toastRule], remove: [] } }), nook)).toEqual({ kind: "rule", rule: toastRule });
    expect(proposalPreview(proposal({ inventory: [{ op: "set-cap", name: "MAX_VISIBLE_QUESTIONS", value: 2 }] }), nook)).toMatchObject({ kind: "cap", before: 1, moved: "looser", cap: { value: 2, stricter: "lower" } });
    // Once adopted, the config already holds the new value: there is no before to draw.
    expect(proposalPreview(proposal({ status: "adopted", inventory: [{ op: "set-cap", name: "MAX_VISIBLE_QUESTIONS", value: 1 }] }), nook)).toMatchObject({ kind: "cap", moved: "the same" });
    expect(proposalPreview(proposal({ inventory: [{ op: "set-max-steps", task: "book-room", value: 2 }] }), nook)).toEqual({ kind: "budget", task: "Pick a free room and book it", before: 3, after: 2 });
    expect(proposalPreview(proposal({ inventory: [{ op: "add-flow-state", state: "waitlisted" }] }), nook)).toEqual({ kind: "flow-state", state: "waitlisted", removed: false });
    expect(proposalPreview(proposal({ inventory: [{ op: "add-page-type", pageType: { id: "search", kind: "collection", slots: ["title", "filters", "body"], chrome: ["title"] } }] }), nook).kind).toBe("page-type");
    expect(proposalPreview(proposal({ needsRuleType: { checks: "x", whyNot: "y", pass: [], fail: [] } }), nook)).toEqual({ kind: "request" });
    expect(proposalPreview(proposal({}), nook)).toEqual({ kind: "none" });
    expect(previewLabel(proposal({ inventory: [{ op: "add-component", name: "Toast" }] }))).toBe("+ component");
    expect(previewLabel(proposal({ rules: { add: [toastRule], remove: [] } }))).toBe("+ rule");
  });

  it("says what changes in a line", () => {
    expect(changeLine(proposal({ inventory: [{ op: "add-component", name: "Toast" }], rules: { add: [toastRule], remove: [] } }))).toBe("Adds 1 component and 1 rule.");
    expect(changeLine(proposal({ inventory: [{ op: "set-cap", name: "MAX_VISIBLE_QUESTIONS", value: 2 }] }))).toBe("Changes 1 cap.");
    expect(changeLine(proposal({ inventory: [{ op: "add-flow-state", state: "a" }, { op: "add-flow-state", state: "b" }, { op: "remove-component", name: "Card" }], rules: { add: [], remove: ["x"] } }))).toBe("Adds 2 flow states and removes 1 component and 1 rule.");
    expect(changeLine(proposal({}))).toBe("Changes nothing.");
  });

  it("orders the list open first, newest first in each status, and keeps the Project tab's timeline to five", () => {
    const at = (day: number) => `2026-11-${String(day).padStart(2, "0")}T10:00:00.000Z`;
    const many = [1, 2, 3, 4, 5, 6, 7].map((day) => proposal({ id: `p${day}`, status: day % 2 === 0 ? "adopted" : "open", history: [{ status: "open", at: at(day) }, ...(day % 2 === 0 ? [{ status: "adopted" as const, at: at(day + 10) }] : [])] }));
    expect(sortProposals(many, ["open", "approved", "adopted", "declined"]).map((item) => item.id)).toEqual(["p7", "p5", "p3", "p1", "p6", "p4", "p2"]);
    const timeline = projectTimeline({ ...nook, proposals: many });
    expect(timeline.items.map((item) => item.id)).toEqual(["p6", "p4", "p2", "p7", "p5"]);
    expect(timeline.more).toBe(2);
    expect(timeline.items.map((item) => item.waiting)).toEqual([false, false, false, true, true]);
    expect(projectTimeline(nook)).toEqual({ items: [], more: 0 });
  });

  it("pairs a rule with its first failing example and the first passing one, and with none when no example names it", () => {
    const examples = { pass: [{ name: "one-toast", prototype: seedLegal() }, { name: "no-toast", prototype: seedLegal() }], fail: [{ name: "other", prototype: seedLegal(), flaggedBy: { rule: "another-rule" } }, { name: "two-toasts", prototype: seedLegal(), flaggedBy: { rule: "one-toast-per-page" } }] };
    expect(proofPair({ examples }, "one-toast-per-page")).toEqual({ pass: "one-toast", fail: "two-toasts" });
    expect(proofPair({ examples }, "unproved")).toEqual({ pass: "one-toast" });
    expect(proofPair({ examples: { pass: [], fail: [] } }, "x")).toEqual({});
  });
});
