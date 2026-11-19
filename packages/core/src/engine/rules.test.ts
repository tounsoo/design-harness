import { describe, expect, it } from "vitest";
import { check, configWith, fragment, home, messages, prototype, type TestElement } from "../../test/helpers";
import { legalSnapshots } from "../../examples/nook/snapshots";
import type { RuleSpec } from "../rules/types";
import { checkPrototype } from "./check";

const button = (text: string, variant?: unknown, extra: Partial<TestElement> = {}): TestElement => ({ type: "Button.Root", props: { text, ...(variant !== undefined ? { variant } : {}) }, ...extra });
const text = (words: string, as?: unknown): TestElement => ({ type: "Text.Root", props: { text: words, ...(as !== undefined ? { as } : {}) } });
/** A press that changes state at `path`, so whatever reads it is unknown until run time. */
const writes = (path: string) => ({ on: { press: [{ action: "setState", params: { statePath: path, value: "x" } }] } });
const at = (file = "pages/home.json") => `${file.replace(/[.]/g, "\\.")}:\\d+:\\d+`;

describe("count", () => {
  const rule: RuleSpec = { type: "count", id: "one-primary", scope: "page", select: { role: "primary-action" }, max: 1 };

  it("passes at the bound and fails over it, naming every match", () => {
    expect(check([rule], home({ action: ["book"] }, { book: button("Book room") })).status).toBe("pass");
    const report = check([rule], home({ action: ["book", "pay"] }, { book: button("Book room"), pay: button("Pay", "primary") }));
    expect(messages(report)).toEqual([expect.stringMatching(new RegExp(`^violation: Page "home" has 2 primary actions, more than 1: Button\\.Root "Book room" at ${at()}, Button\\.Root "Pay" at ${at()}\\.`))]);
  });

  it("counts an element in a list the page can change as any number", () => {
    const report = check([rule], home({ body: ["rows"] }, { rows: { type: "Stack.Root", repeat: { statePath: "/rows" }, children: ["row"] }, row: button("Book room", undefined, writes("/rows")) }, { state: { rows: [] } }));
    expect(messages(report)).toEqual([expect.stringContaining('is rendered once per item of a list, so page "home" may show more than 1 primary actions')]);
  });

  it("reports an element it cannot decide only when it could change the answer", () => {
    const tone = { $state: "/tone" };
    const one = home({ action: ["pay"] }, { pay: button("Pay", tone, writes("/tone")) }, { state: { tone: "primary" } });
    expect(check([rule], one).status).toBe("pass");
    const two = home({ action: ["book", "pay"] }, { book: button("Book room"), pay: button("Pay", tone, writes("/tone")) }, { state: { tone: "primary" } });
    expect(messages(check([rule], two))).toEqual([expect.stringMatching(/^unverifiable: Cannot tell whether Button\.Root "Pay" .* is a primary action: .*\/tone/)]);
  });

  it("reads a cap by name, and repeats over an input list", () => {
    const capped: RuleSpec = { type: "count", id: "disclosures", scope: "page", select: { role: "disclosure" }, max: { cap: "MAX_DISCLOSURES_PER_PAGE" } };
    expect(messages(check([capped], home({ body: ["a", "b"] }, { a: { type: "Disclosure.Root" }, b: { type: "Disclosure.Root" } })))).toEqual([expect.stringContaining("more than 1 (MAX_DISCLOSURES_PER_PAGE)")]);
    const sections: RuleSpec = { type: "count", id: "sections", scope: "pages", each: "disclosedSections", select: { role: "disclosure-summary", text: { each: true } }, min: 1 };
    const disclosure = (summary: string) => home({ body: ["d"] }, { d: { type: "Disclosure.Root", children: ["s"] }, s: { type: "Disclosure.Summary", props: { text: summary } } });
    expect(messages(check([sections], disclosure("Room details")))).toEqual([]);
    expect(messages(check([sections], disclosure("Other")))).toEqual([expect.stringContaining(`0 disclosure summaries reading "Room details"`)]);
  });

  it("in source scope, counts what no page draws too", () => {
    const spare: RuleSpec = { type: "count", id: "spare", scope: "source", select: { component: ["Button.Root"] }, max: 0 };
    const report = check([spare], { ...home({ title: [] }), "layouts/spare.json": fragment("spare", { spare: button("x") }) });
    expect(messages(report)).toEqual([expect.stringMatching(new RegExp(`Button\\.Root "x" at ${at("layouts/spare.json")}`))]);
  });
});

describe("excluded props in a spec", () => {
  it("are refused by the catalog, by name or pattern, as the extract rule's finding, before any rule reads the page", () => {
    const { excludedProps: _nook, ...library } = configWith([]).library;
    const config = configWith([], { library: { ...library, excludedProps: ["className", "ton*"] } });
    const report = checkPrototype({ config, prototype: prototype(home({ title: ["t"] }, { t: { type: "Text.Root", props: { as: "h1", text: "Hi", tone: "muted" } } })) });
    expect(messages(report, "extract")).toEqual([expect.stringContaining('element "t" sets "tone", a style prop the project excludes ("ton*" in library.excludedProps): a Text.Root\'s styling must come from the library\'s own variants and tokens')]);
  });
});

describe("containment", () => {
  it("must not be inside, and must be inside", () => {
    const notInside: RuleSpec = { type: "containment", id: "no-hidden-primary", select: { role: "primary-action" }, must: "not-be-inside", of: { role: "disclosure" } };
    const hidden = home({ body: ["d"] }, { d: { type: "Disclosure.Root", children: ["b"] }, b: button("Book room") });
    expect(messages(check([notInside], hidden))).toEqual([expect.stringMatching(new RegExp(`Button\\.Root "Book room" at ${at()} is a primary action inside a disclosure, Disclosure\\.Root at ${at()}\\.`))]);
    const inside: RuleSpec = { type: "containment", id: "fields-in-disclosure", select: { role: "question" }, must: "be-inside", of: { role: "disclosure" } };
    expect(messages(check([inside], home({ body: ["f"] }, { f: { type: "Field.Root" } })))).toEqual([expect.stringContaining("is a question outside every disclosure")]);
  });

  it("counts nesting depth through a layout instance", () => {
    const depth: RuleSpec = { type: "containment", id: "depth", select: { role: "disclosure" }, must: "nest-at-most", depth: 1 };
    const files = { ...home({ body: ["d"] }, { d: { type: "Disclosure.Root", children: ["inner"] }, inner: { type: "Layout", props: { id: "inner" } } }), "layouts/inner.json": fragment("box", { box: { type: "Disclosure.Root", props: {} } }) };
    expect(messages(check([depth], files, { layouts: [{ id: "inner", component: { file: "layouts/inner.json", export: "default" } }] }))).toEqual([expect.stringContaining("nests disclosures 2 deep, more than 1")]);
  });
});

describe("prop-values and requires", () => {
  const as: RuleSpec = { type: "prop-values", id: "text-as", select: { component: "Text.Root" }, prop: "as", allowed: ["h1", "p"], required: true };

  it("allows listed literals, flags others and a missing required prop, and cannot check one read from state the page changes", () => {
    expect(check([as], home({ title: ["t"] }, { t: text("T", "h1") })).status).toBe("pass");
    const report = check([as], home({ title: ["t", "u", "v"], action: ["b"] }, { t: text("T", "h4"), u: text("U"), v: text("V", { $state: "/level" }), b: button("Book room", undefined, writes("/level")) }, { state: { level: "h1" } }));
    expect(messages(report)).toEqual([
      expect.stringMatching(new RegExp(`^violation: Text\\.Root "T" at ${at()} sets as to "h4"; it must be one of "h1", "p"\\.`)),
      expect.stringMatching(new RegExp(`^violation: Text\\.Root "U" at ${at()} has no as`)),
      expect.stringContaining(`unverifiable: Cannot tell whether Text.Root "V"`),
    ]);
  });

  it("checks every value a choice can take", () => {
    const choice = { $cond: { $state: "/scenario/state", eq: "booked" }, $then: "h1", $else: "h5" };
    expect(messages(check([as], home({ title: ["t"] }, { t: text("T", choice) })))).toEqual([expect.stringContaining(`sets as to "h5"`)]);
  });

  it("requires: every match also matches the second selector", () => {
    const rank2: RuleSpec = { type: "requires", id: "rank-2", select: { role: "action", text: { rank: 2 } }, must: { role: "secondary-action" } };
    expect(check([rank2], home({ alternate: ["h"] }, { h: button("Hold room", "secondary") })).status).toBe("pass");
    expect(messages(check([rank2], home({ alternate: ["h"] }, { h: button("Hold room", "ghost") })))).toEqual([expect.stringContaining("so it must be a secondary action, and it is not")]);
  });
});

describe("slot, page structure and reachability", () => {
  const primarySlot: RuleSpec = { type: "slot", id: "primary-slot", slot: "$primary", holds: { role: "primary-action" }, min: 1, max: 1, only: { role: "primary-action" } };
  const bookLayout = { "layouts/book.json": fragment("book", { book: button("Book room") }) };
  const withBook = { layouts: [{ id: "book", component: { file: "layouts/book.json", export: "default" } }] };

  it("a primary slot holds exactly one primary action, and a layout instance there is a layout, not the action it draws", () => {
    expect(check([primarySlot], home({ action: ["b"] }, { b: button("Book room") })).status).toBe("pass");
    expect(messages(check([primarySlot], { ...home({ action: ["use"] }, { use: { type: "Layout", props: { id: "book" } } }), ...bookLayout }, withBook))).toEqual([expect.stringContaining("found 0"), expect.stringContaining("which is not a primary action")]);
    expect(messages(check([primarySlot], home({ action: ["a", "b"] }, { a: button("A"), b: button("B") })))).toEqual([expect.stringContaining(`accepts at most 1 primary actions, found 2`)]);
    expect(messages(check([primarySlot], home({ title: ["t"] }, { t: text("T", "h1") })))).toEqual([expect.stringContaining(`Page "home" does not fill its slot "action"`)]);
  });

  it("page structure: known slots only, and nothing outside them", () => {
    const structure: RuleSpec = { type: "page-structure", id: "structure" };
    const report = check([structure], home({ title: [], footer: [] }, { loose: text("loose", "p") }, { outside: ["loose"] }));
    expect(messages(report)).toEqual([
      expect.stringMatching(new RegExp(`fills slot "footer" at ${at()}, but page type "booking" has no such slot`)),
      expect.stringMatching(new RegExp(`Text\\.Root "loose" at ${at()} is outside every slot`)),
    ]);
  });

  it("reachable: an action written where no page draws it", () => {
    const reachable: RuleSpec = { type: "reachable", id: "reached", select: { role: "action" } };
    const report = check([reachable], { ...home({ action: ["b"] }, { b: button("Book room") }), "layouts/spare.json": fragment("spare", { spare: button("Spare") }) });
    expect(messages(report)).toEqual([expect.stringMatching(new RegExp(`Button\\.Root "Spare" at ${at("layouts/spare.json")} is an action that no page reaches`))]);
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
    expect(check([budget], home({ title: [] }), { flow: flow(hold) }).status).toBe("pass");
  });

  it("fails the longest route over budget even when the shortest fits", () => {
    const hold = [{ from: "rooms", event: "quick-hold", to: "held" }, { from: "rooms", event: "open", to: "room-open" }, { from: "room-open", event: "book", to: "booked" }, { from: "booked", event: "re-hold", to: "held" }];
    expect(messages(check([budget], home({ title: [] }), { flow: flow(hold) }))).toEqual([`violation: The route open → book → re-hold takes 3 steps, which exceeds max steps 2 for "hold-room". Every route that finishes the task must fit, not only the shortest.`]);
  });

  it("fails an unreachable success state and a flow for a task the project does not have", () => {
    const stuck = [{ from: "rooms", event: "open", to: "room-open" }];
    expect(messages(check([budget], home({ title: [] }), { flow: flow(stuck, [{ task: "ghost", start: "rooms", transitions: [] }]) }))).toEqual([
      expect.stringContaining(`No route from "rooms" reaches "held"`),
      expect.stringContaining(`The flow models task "ghost"`),
    ]);
  });

  it("state coverage: every state has a scenario; every scenario a state and a page", () => {
    const report = check([coverage], home({ title: [] }), {
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
  const legal = prototype(home({ title: [] }), { scenarios: [{ id: "rooms-list", state: "rooms", page: "home" }] });

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

  it("point each finding about one element at it, by its index in the snapshot", () => {
    const base = legalSnapshots().filter((item) => item.scenario === "rooms-list");
    const skipped = base.map((item) => (item.view === "phone" ? { ...item, elements: item.elements.map((element) => (element.name === "Harbor" && element.headingLevel === 2 ? { ...element, headingLevel: 4 } : element)) } : item));
    const report = checkPrototype({ config: configWith(rendered), prototype: legal, snapshots: skipped });
    const finding = report.findings.find((item) => item.rule === "headings");
    const phone = skipped.find((item) => item.view === "phone");
    expect(finding?.element).toBeDefined();
    expect(phone?.elements[finding?.element ?? -1]?.name).toBe("Harbor");
  });

  const contrast: RuleSpec[] = [{ type: "rendered", id: "text-contrast", check: "contrast" }];
  const rooms = () => legalSnapshots().filter((item) => item.scenario === "rooms-list");
  const faint = (edit: Record<string, unknown>) =>
    rooms().map((item) => ({ ...item, elements: item.elements.map((element) => (element.name.startsWith("Pick a free room") && element.text ? { ...element, ...edit, text: { ...element.text, color: [200, 200, 200, 1] as const } } : element)) }));

  it("exempt text in a control that is turned off from contrast, as WCAG 1.4.3 does", () => {
    expect(messages(checkPrototype({ config: configWith(contrast), prototype: legal, snapshots: faint({}) }), "text-contrast")).toHaveLength(2);
    expect(checkPrototype({ config: configWith(contrast), prototype: legal, snapshots: faint({ disabled: true }) }).status).toBe("pass");
  });

  it("cannot measure contrast over a background image, so it says so instead of passing", () => {
    const overImage = rooms().map((item) => ({ ...item, elements: item.elements.map((element) => (element.name.startsWith("Pick a free room") && element.text ? { ...element, text: { ...element.text, overImage: true } } : element)) }));
    expect(messages(checkPrototype({ config: configWith(contrast), prototype: legal, snapshots: overImage }), "text-contrast")).toEqual([
      `unverifiable: At 1280 by 900: "Pick a free room to book or hold." is painted over a background image or gradient, so its contrast cannot be measured. Put the text on a background colour.`,
      `unverifiable: At 390 by 844: "Pick a free room to book or hold." is painted over a background image or gradient, so its contrast cannot be measured. Put the text on a background colour.`,
    ]);
  });

  it("measure sideways scroll against the width left beside a vertical scrollbar", () => {
    const sideways: RuleSpec[] = [{ type: "rendered", id: "no-sideways-scroll", check: "no-sideways-scroll" }];
    const narrowed = rooms().map((item) => (item.view === "phone" ? { ...item, scrollWidth: 385, viewportWidth: 375 } : item));
    expect(messages(checkPrototype({ config: configWith(sideways), prototype: legal, snapshots: narrowed }), "no-sideways-scroll")).toEqual([
      "violation: At 390 by 844: the page is 385 CSS px wide in a 375 CSS px view (390 less a 15 CSS px scrollbar), so it scrolls sideways.",
    ]);
    const fits = rooms().map((item) => (item.view === "phone" ? { ...item, scrollWidth: 375, viewportWidth: 375 } : item));
    expect(checkPrototype({ config: configWith(sideways), prototype: legal, snapshots: fits }).status).toBe("pass");
  });
});
