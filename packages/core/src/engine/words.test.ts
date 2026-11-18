import { describe as group, expect, it } from "vitest";
import { nook } from "../../examples/nook/project";
import type { RuleSpec, RuleType } from "../rules/types";
import { describeRule } from "./words";

const words = (rule: RuleSpec) => describeRule(rule, nook);

group("a rule in plain words", () => {
  it("says what every membership subject allows, listing the inventory it reads", () => {
    expect(words({ type: "membership", id: "a", of: "components" })).toBe("Pages render only the library parts in the component inventory (Alert, Button, Card, Disclosure, EmptyState, Field, Label, Stack, Text).");
    expect(words({ type: "membership", id: "a", of: "imports" })).toBe("Files import only @tounsoo/todae, React, the page kit and the prototype's own files, by static imports.");
    expect(words({ type: "membership", id: "a", of: "page-types" })).toBe("Every page is of a page type in the inventory (booking, rooms).");
    expect(words({ type: "membership", id: "a", of: "layouts" })).toBe("Every layout the manifest registers is in the layout inventory (room-cards, room-details, select-question).");
    expect(words({ type: "membership", id: "a", of: "flow-states" })).toBe("The flow uses only flow states in the inventory (rooms, room-open, booked, held).");
  });

  it("counts in every scope, with no, at most, at least, exactly and between, and names a cap with its value", () => {
    expect(words({ type: "count", id: "a", scope: "page", select: { component: "Toast.Root" }, max: 1 })).toBe("Each page holds at most 1 Toast.Root.");
    expect(words({ type: "count", id: "a", scope: "page", select: { role: "disclosure" }, max: { cap: "MAX_DISCLOSURES_PER_PAGE" } })).toBe("Each page holds at most 1 (MAX_DISCLOSURES_PER_PAGE) disclosure.");
    expect(words({ type: "count", id: "a", scope: "page", pages: { kinds: ["collection", "content"] }, select: { role: "primary-action" }, max: 0 })).toBe("Each collection or content page holds no primary actions.");
    expect(words({ type: "count", id: "a", scope: "page", pages: { types: ["booking"] }, select: { role: "question" }, min: 1, max: 1 })).toBe('Each "booking" page holds exactly 1 question.');
    expect(words({ type: "count", id: "a", scope: "pages", select: { role: "primary-action", text: { rank: 1 } }, min: 1 })).toBe('Across all pages, the prototype holds at least 1 primary action reading the rank-1 action "Book room".');
    expect(words({ type: "count", id: "a", scope: "source", select: { component: ["button", "a"] }, min: 1, max: 3 })).toBe("The prototype's source, rendered or not, holds between 1 and 3 <button> or <a>.");
    expect(words({ type: "count", id: "a", scope: "page", select: { role: "action", inside: { role: "disclosure" } } })).toBe("Each page holds any number of actions inside a disclosure.");
  });

  it("repeats a count over each disclosed section, naming the sections", () => {
    const rule = nook.rules.find((item) => item.id === "disclosed-sections") as RuleSpec;
    expect(words(rule)).toBe('For each disclosed section (Room details), with <section> standing for it: across all pages, the prototype holds at least 1 disclosure summary reading "<section>" inside a disclosure.');
  });

  it("says where an element must or must not be, and how deep it may nest", () => {
    expect(words({ type: "containment", id: "a", select: { role: "primary-action" }, must: "not-be-inside", of: { role: "disclosure" } })).toBe("No primary action is inside a disclosure.");
    expect(words({ type: "containment", id: "a", select: { role: "question" }, must: "be-inside", of: { component: "Card.Root" }, pages: { kinds: ["collection"] } })).toBe("Every question is inside a Card.Root on collection pages.");
    expect(words({ type: "containment", id: "a", select: { role: "disclosure" }, must: "nest-at-most", depth: { cap: "MAX_DISCLOSURE_DEPTH" } })).toBe("Disclosures nest inside each other at most 1 (MAX_DISCLOSURE_DEPTH) deep; a lone one is 1 deep.");
  });

  it("lists the values a prop may take, required or not", () => {
    expect(words({ type: "prop-values", id: "a", select: { component: "Text.Root" }, prop: "as", allowed: ["h1", "p"], required: true })).toBe('Every Text.Root sets as, to one of "h1", "p".');
    expect(words({ type: "prop-values", id: "a", select: { component: "Button.Root" }, prop: "variant", allowed: ["primary", "secondary"] })).toBe('Every Button.Root that sets variant sets it to one of "primary", "secondary".');
  });

  it("says what a match must also be", () => {
    expect(words({ type: "requires", id: "a", select: { role: "action", text: { rank: 2 } }, must: { role: "secondary-action" } })).toBe('Every action reading the rank-2 action "Hold room" is also a secondary action.');
    expect(words({ type: "requires", id: "a", select: { component: "Button.Root", props: { variant: "ghost" } }, must: { notInside: { role: "disclosure" } }, pages: { types: ["rooms"] } })).toBe('Every Button.Root with variant="ghost" is also an element outside every disclosure on "rooms" pages.');
  });

  it("says what a slot holds, by name or by kind", () => {
    expect(words({ type: "slot", id: "a", slot: "$primary", holds: { role: "primary-action" }, min: 1, max: 1, only: { role: "primary-action" } })).toBe(
      "The primary slot of each action page holds exactly 1 primary action at its top level, and holds nothing at its top level but primary actions.",
    );
    expect(words({ type: "slot", id: "a", slot: "$body", only: { layout: true } })).toBe("Every body slot (neither chrome nor primary) of each page holds nothing at its top level but layouts.");
    expect(words({ type: "slot", id: "a", slot: "$chrome", holds: { role: "action" }, max: 0 })).toBe("Every chrome slot of each page holds no actions at its top level.");
    expect(words({ type: "slot", id: "a", slot: "title", pages: { types: ["booking"] }, holds: { component: "Text.Root" }, min: 1 })).toBe('The "title" slot of each "booking" page holds at least 1 Text.Root at its top level.');
    expect(words({ type: "slot", id: "a", slot: "intro" })).toBe('The "intro" slot of each page is not limited.');
  });

  it("describes the named checks: reachable, page structure, isolation, both flow checks", () => {
    expect(words({ type: "reachable", id: "a", select: { anyOf: [{ role: "action" }, { role: "question" }] } })).toBe("Every action or question written anywhere in the source is rendered from a page, so the per-page rules count it.");
    expect(words({ type: "page-structure", id: "a" })).toBe("Every page fills only its page type's slots, each at most once, and puts nothing outside them.");
    expect(words({ type: "isolation", id: "a" })).toMatch(/^Prototype code reaches only its imports and plain language built-ins/);
    expect(words({ type: "flow", id: "a", check: "state-coverage" })).toBe("Every flow state has a scenario, and every scenario shows a modeled state on a page of the prototype.");
    expect(words({ type: "flow", id: "a", check: "step-budget" })).toBe("Every route from a task's start to its success state, not only the shortest, fits the task's max steps (book-room: 3, hold-room: 2).");
  });

  it("describes every rendered check as measured in every scenario and view", () => {
    expect(words({ type: "rendered", id: "a", check: "target-size", minPx: 40 })).toBe("Measured in every scenario at every view: every visible control is at least 40 CSS px wide and high, or meets the WCAG 2.5.8 spacing exception.");
    expect(words({ type: "rendered", id: "a", check: "target-size", minPx: { cap: "TARGET_MIN_PX" } })).toContain("at least 24 (TARGET_MIN_PX) CSS px");
    expect(words({ type: "rendered", id: "a", check: "headings" })).toBe("Measured in every scenario at every view: each page has one h1, first, and no heading skips a level.");
    expect(words({ type: "rendered", id: "a", check: "contrast" })).toContain("WCAG AA contrast");
    expect(words({ type: "rendered", id: "a", check: "accessible-names" })).toBe("Measured in every scenario at every view: every visible control has an accessible name.");
    expect(words({ type: "rendered", id: "a", check: "first-view", action: { rank: 1 } })).toBe('Measured in every scenario at every view: wherever the rank-1 action "Book room" is shown, it is inside the first view, without scrolling.');
    expect(words({ type: "rendered", id: "a", check: "first-view", action: "Open Harbor" })).toBe('Measured in every scenario at every view: wherever "Open Harbor" is shown, it is inside the first view, without scrolling.');
    expect(words({ type: "rendered", id: "a", check: "no-sideways-scroll" })).toBe("Measured in every scenario at every view: nothing makes the page scroll sideways.");
  });

  it("covers every rule type of the vocabulary, never by the rule's description, and is deterministic", () => {
    const types = new Set<RuleType>(nook.rules.map((rule) => rule.type));
    expect([...types].sort()).toEqual(["containment", "count", "flow", "isolation", "membership", "page-structure", "prop-values", "reachable", "rendered", "requires", "slot"]);
    for (const rule of nook.rules) {
      const said = words(rule);
      expect(said.length).toBeGreaterThan(20);
      if (rule.description) expect(said).not.toBe(rule.description);
      expect(words(JSON.parse(JSON.stringify(rule)) as RuleSpec)).toBe(said);
    }
  });

  it("reads caps and ranks from the config it is given", () => {
    const tighter = { ...nook, inputs: { ...nook.inputs, caps: { ...nook.inputs.caps, MAX_DISCLOSURES_PER_PAGE: { value: 0, stricter: "lower" as const } } } };
    expect(describeRule({ type: "count", id: "a", scope: "page", select: { role: "disclosure" }, max: { cap: "MAX_DISCLOSURES_PER_PAGE" } }, tighter)).toBe("Each page holds no disclosures (MAX_DISCLOSURES_PER_PAGE is 0).");
  });
});
