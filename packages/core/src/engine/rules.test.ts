import { describe, expect, it } from "vitest";
import { HEADER, check, configWith, messages, prototype } from "../../test/helpers";
import { legalSnapshots } from "../../examples/nook/snapshots";
import type { RuleSpec } from "../rules/types";
import { checkPrototype } from "./check";

const home = (body: string, extra = "") => ({ "pages/home.tsx": `${HEADER}${extra}\nexport function Home() {\n  return (\n    <>\n${body}\n    </>\n  );\n}\n` });
const slot = (name: string, inner: string) => `      <Slot name="${name}">${inner}</Slot>`;

describe("count", () => {
  const rule: RuleSpec = { type: "count", id: "one-primary", scope: "page", select: { role: "primary-action" }, max: 1 };

  it("passes at the bound and fails over it, naming every match", () => {
    expect(check([rule], home(slot("action", `<Button.Root>Book room</Button.Root>`))).status).toBe("pass");
    const report = check([rule], home(slot("action", `<Button.Root>Book room</Button.Root><Button.Root variant="primary">Pay</Button.Root>`)));
    expect(messages(report)).toEqual([expect.stringContaining(`violation: Page "home" has 2 primary actions, more than 1: Button.Root "Book room" at pages/home.tsx:7:27, Button.Root "Pay" at pages/home.tsx:7:63.`)]);
  });

  it("counts an element in a list of unknown length as any number", () => {
    const report = check([rule], home(slot("body", `{rows.map(() => <Button.Root>Book room</Button.Root>)}`), "const rows = useRows();"));
    expect(messages(report)).toEqual([expect.stringContaining("is rendered once per item of a list, so page \"home\" may show more than 1 primary actions")]);
  });

  it("reports an element it cannot decide only when it could change the answer", () => {
    const one = home(slot("action", `<Button.Root variant={tone}>Pay</Button.Root>`), "const tone = pick();");
    expect(check([rule], one).status).toBe("pass");
    const two = home(slot("action", `<Button.Root>Book room</Button.Root><Button.Root variant={tone}>Pay</Button.Root>`), "const tone = pick();");
    expect(messages(check([rule], two))).toEqual([expect.stringMatching(/^unverifiable: Cannot tell whether Button.Root "Pay" .* is a primary action: its variant is computed from `tone`/)]);
  });

  it("reads a cap by name, and repeats over an input list", () => {
    const capped: RuleSpec = { type: "count", id: "disclosures", scope: "page", select: { role: "disclosure" }, max: { cap: "MAX_DISCLOSURES_PER_PAGE" } };
    expect(messages(check([capped], home(slot("body", `<Disclosure.Root /><Disclosure.Root />`))))).toEqual([expect.stringContaining("more than 1 (MAX_DISCLOSURES_PER_PAGE)")]);
    const sections: RuleSpec = { type: "count", id: "sections", scope: "pages", each: "disclosedSections", select: { role: "disclosure-summary", text: { each: true } }, min: 1 };
    expect(messages(check([sections], home(slot("body", `<Disclosure.Root><Disclosure.Summary>Room details</Disclosure.Summary></Disclosure.Root>`))))).toEqual([]);
    expect(messages(check([sections], home(slot("body", `<Disclosure.Root><Disclosure.Summary>Other</Disclosure.Summary></Disclosure.Root>`))))).toEqual([expect.stringContaining(`0 disclosure summaries reading "Room details"`)]);
  });

  it("in source scope, counts what no page renders too", () => {
    const raw: RuleSpec = { type: "count", id: "raw", scope: "source", select: { component: ["button"] }, max: 0 };
    const report = check([raw], { ...home(""), "pages/unused.tsx": `export const Unused = () => <button>x</button>;` });
    expect(messages(report)).toEqual([expect.stringContaining(`<button> "x" at pages/unused.tsx:1:29`)]);
  });
});

describe("containment", () => {
  it("must not be inside, and must be inside", () => {
    const notInside: RuleSpec = { type: "containment", id: "no-hidden-primary", select: { role: "primary-action" }, must: "not-be-inside", of: { role: "disclosure" } };
    const hidden = home(slot("body", `<Disclosure.Root><Button.Root>Book room</Button.Root></Disclosure.Root>`));
    expect(messages(check([notInside], hidden))).toEqual([expect.stringContaining(`Button.Root "Book room" at pages/home.tsx:7:42 is a primary action inside a disclosure, Disclosure.Root at pages/home.tsx:7:25.`)]);
    const inside: RuleSpec = { type: "containment", id: "fields-in-disclosure", select: { role: "question" }, must: "be-inside", of: { role: "disclosure" } };
    expect(messages(check([inside], home(slot("body", `<Field.Root />`))))).toEqual([expect.stringContaining("is a question outside every disclosure")]);
  });

  it("counts nesting depth through local components", () => {
    const depth: RuleSpec = { type: "containment", id: "depth", select: { role: "disclosure" }, must: "nest-at-most", depth: 1 };
    const files = home(slot("body", `<Disclosure.Root><Inner /></Disclosure.Root>`), "const Inner = () => <Disclosure.Root>inner</Disclosure.Root>;");
    expect(messages(check([depth], files))).toEqual([expect.stringContaining("nests disclosures 2 deep, more than 1")]);
  });
});

describe("prop-values and requires", () => {
  const as: RuleSpec = { type: "prop-values", id: "text-as", select: { component: "Text.Root" }, prop: "as", allowed: ["h1", "p"], required: true };

  it("allows listed literals, flags others and a missing required prop, and cannot check a computed one", () => {
    expect(check([as], home(slot("title", `<Text.Root as="h1">T</Text.Root>`))).status).toBe("pass");
    expect(messages(check([as], home(slot("title", `<Text.Root as="h4">T</Text.Root><Text.Root>U</Text.Root><Text.Root as={level}>V</Text.Root>`), "const level = pick();")))).toEqual([
      expect.stringContaining(`violation: Text.Root "T" at pages/home.tsx:7:26 sets as to "h4"; it must be one of "h1", "p".`),
      expect.stringContaining(`violation: Text.Root "U" at pages/home.tsx:7:58 has no as`),
      expect.stringContaining(`unverifiable: Cannot tell whether Text.Root "V"`),
    ]);
  });

  it("checks every value a choice can take", () => {
    expect(messages(check([as], home(slot("title", `<Text.Root as={big ? "h1" : "h5"}>T</Text.Root>`), "const big = pick();")))).toEqual([expect.stringContaining(`sets as to "h5"`)]);
  });

  it("requires: every match also matches the second selector", () => {
    const rank2: RuleSpec = { type: "requires", id: "rank-2", select: { role: "action", text: { rank: 2 } }, must: { role: "secondary-action" } };
    expect(check([rank2], home(slot("alternate", `<Button.Root variant="secondary">Hold room</Button.Root>`))).status).toBe("pass");
    expect(messages(check([rank2], home(slot("alternate", `<Button.Root variant="ghost">Hold room</Button.Root>`))))).toEqual([expect.stringContaining("so it must be a secondary action, and it is not")]);
  });
});

describe("slot, page structure and reachability", () => {
  const primarySlot: RuleSpec = { type: "slot", id: "primary-slot", slot: "$primary", holds: { role: "primary-action" }, min: 1, max: 1, only: { role: "primary-action" } };

  it("a primary slot holds exactly one primary action, seeing through wrapper components", () => {
    expect(check([primarySlot], home(slot("action", `<Book />`), "const Book = () => <Button.Root>Book room</Button.Root>;")).status).toBe("pass");
    expect(messages(check([primarySlot], home(slot("action", `<Button.Root>A</Button.Root><Button.Root>B</Button.Root>`))))).toEqual([expect.stringContaining(`accepts at most 1 primary actions, found 2`)]);
    expect(messages(check([primarySlot], home(slot("title", `<Text.Root as="h1">T</Text.Root>`))))).toEqual([expect.stringContaining(`Page "home" does not fill its slot "action"`)]);
  });

  it("page structure: known slots, each once, nothing outside them", () => {
    const structure: RuleSpec = { type: "page-structure", id: "structure" };
    const report = check([structure], home(`${slot("title", "")}\n${slot("title", "")}\n${slot("footer", "")}\n      <Text.Root as="p">loose</Text.Root>\n      <Slot name={which} />`, "const which = pick();"));
    expect(messages(report)).toEqual([
      expect.stringContaining(`fills slot "title" twice`),
      expect.stringContaining(`fills slot "footer" at pages/home.tsx:9:7, but page type "booking" has no such slot`),
      expect.stringContaining(`Text.Root "loose" at pages/home.tsx:10:7 is outside every slot`),
      expect.stringContaining("has a computed name"),
    ]);
  });

  it("reachable: an action built where no page renders it", () => {
    const reachable: RuleSpec = { type: "reachable", id: "reached", select: { role: "action" } };
    const report = check([reachable], { ...home(slot("action", `<Button.Root>Book room</Button.Root>`)), "pages/spare.tsx": `${HEADER}export const Spare = () => <Button.Root>Spare</Button.Root>;` });
    expect(messages(report)).toEqual([expect.stringContaining(`Button.Root "Spare" at pages/spare.tsx:3:28 is an action that no page reaches`)]);
  });
});

describe("membership", () => {
  it("imports: the library and its subpaths, React, the page kit, and the prototype's files only", () => {
    const imports: RuleSpec = { type: "membership", id: "imports", of: "imports" };
    const report = check([imports], {
      "pages/home.tsx": `import "@tounsoo/todae/styles.css";\nimport { useState } from "react";\nimport { Slot, Page } from "@design-harness/page";\nimport { x } from "./missing";\nimport lodash from "lodash";\nexport const Home = () => null;`,
    });
    expect(messages(report)).toEqual([
      expect.stringContaining("imports Page from @design-harness/page, which exports only Slot and the PageProps type"),
      expect.stringContaining(`imports "./missing", which is not a file in the prototype`),
      expect.stringContaining(`imports "lodash", which is not the project's library`),
    ]);
  });
});

describe("flow", () => {
  const budget: RuleSpec = { type: "flow", id: "budget", check: "step-budget" };
  const coverage: RuleSpec = { type: "flow", id: "coverage", check: "state-coverage" };
  type Edge = { from: string; event: string; to: string };
  const book: Edge[] = [
    { from: "rooms", event: "open", to: "room-open" },
    { from: "room-open", event: "book", to: "booked" },
  ];
  const flow = (hold: Edge[], extra: { task: string; start: string; transitions: Edge[] }[] = []) => ({
    states: ["rooms", "room-open", "booked", "held"],
    tasks: [{ task: "book-room", start: "rooms", transitions: book }, { task: "hold-room", start: "rooms", transitions: hold }, ...extra],
  });

  it("passes when every route fits, ignoring routes that return to a state they passed", () => {
    const hold = [{ from: "rooms", event: "open", to: "room-open" }, { from: "room-open", event: "hold", to: "held" }, { from: "room-open", event: "back", to: "rooms" }];
    expect(check([budget], home(""), { flow: flow(hold) }).status).toBe("pass");
  });

  it("fails the longest route over budget even when the shortest fits", () => {
    const hold = [{ from: "rooms", event: "quick-hold", to: "held" }, { from: "rooms", event: "open", to: "room-open" }, { from: "room-open", event: "book", to: "booked" }, { from: "booked", event: "re-hold", to: "held" }];
    expect(messages(check([budget], home(""), { flow: flow(hold) }))).toEqual([`violation: The route open → book → re-hold takes 3 steps, which exceeds max steps 2 for "hold-room". Every route that finishes the task must fit, not only the shortest.`]);
  });

  it("fails an unreachable success state and a flow for a task the project does not have", () => {
    const stuck = [{ from: "rooms", event: "open", to: "room-open" }];
    expect(messages(check([budget], home(""), { flow: flow(stuck, [{ task: "ghost", start: "rooms", transitions: [] }]) }))).toEqual([
      expect.stringContaining(`No route from "rooms" reaches "held"`),
      expect.stringContaining(`The flow models task "ghost"`),
    ]);
  });

  it("state coverage: every state has a scenario; every scenario a state and a page", () => {
    const report = check([coverage], home(""), {
      flow: flow([]),
      scenarios: [
        { id: "a", state: "rooms", page: "home" },
        { id: "b", state: "room-open", page: "home" },
        { id: "c", state: "booked", page: "nowhere" },
        { id: "d", state: "lost", page: "home" },
      ],
    });
    expect(messages(report)).toEqual([
      expect.stringContaining(`Flow state "held" has no scenario`),
      expect.stringContaining(`Scenario "d" shows "lost", which is not a state of the flow`),
      expect.stringContaining(`Scenario "c" opens page "nowhere"`),
    ]);
  });
});

describe("rendered rules", () => {
  const rendered: RuleSpec[] = [
    { type: "rendered", id: "target-size", check: "target-size", minPx: { cap: "TARGET_MIN_PX" } },
    { type: "rendered", id: "headings", check: "headings" },
  ];
  const legal = prototype(home(""), { scenarios: [{ id: "rooms-list", state: "rooms", page: "home" }] });

  it("do not run without snapshots, and report a scenario and view with no snapshot", () => {
    const none = checkPrototype({ config: configWith(rendered), prototype: legal });
    expect(none.status).toBe("incomplete");
    expect(none.rules.filter((rule) => rule.status === "not-run").map((rule) => rule.note)).toEqual(["no rendered snapshots were given", "no rendered snapshots were given"]);
    const partial = checkPrototype({ config: configWith(rendered), prototype: legal, snapshots: legalSnapshots().filter((item) => item.scenario === "rooms-list" && item.view === "desktop") });
    expect(messages(partial, "headings")).toEqual([`unverifiable: No snapshot of scenario "rooms-list" at view "phone", so it was not measured.`]);
  });

  it("pass an undersized target that meets the spacing exception, and fail one that does not", () => {
    const base = legalSnapshots().filter((item) => item.scenario === "rooms-list");
    const link = (x: number) => ({ role: "link", name: `L${x}`, tag: "a", rect: { x, y: 600, width: 12, height: 12 }, interactive: true, visible: true });
    const spaced = base.map((item) => ({ ...item, elements: [...item.elements, link(100), link(140)] }));
    expect(checkPrototype({ config: configWith(rendered), prototype: legal, snapshots: spaced }).status).toBe("pass");
    const crowded = base.map((item) => ({ ...item, elements: [...item.elements, link(100), link(116)] }));
    expect(messages(checkPrototype({ config: configWith(rendered), prototype: legal, snapshots: crowded }), "target-size")).toHaveLength(4);
  });
});
