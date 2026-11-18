import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nook } from "../../examples/nook/project";
import { EXAMPLES, loadPrototype } from "../../test/fixtures";
import { checkPrototype } from "../engine/check";
import type { ElementNode } from "../extract/model";
import type { Prototype } from "../prototype/types";
import { expandPage } from "./expand";
import { specLayouts } from "./layouts";
import { specModel } from "./model";
import { readSpecs } from "./read";
import { resolvePageSpec } from "./resolve";

/**
 * Layouts with parameters: expansion and its id scoping, parameter
 * validation, and findings inside an instance that point at both the
 * layout's element and the page's use of it.
 */
const legal = loadPrototype(join(EXAMPLES, "spec", "legal", "booking"));
const bookingFile = legal.files["pages/booking.json"] as string;

/** A prototype with layouts of its own: `files` are spec files, `layouts` their ids, and pages/home.json a booking page. */
function project(home: { elements: Record<string, unknown>; state?: Record<string, unknown> }, layouts: Record<string, unknown>): Prototype {
  const files: Record<string, string> = { "pages/home.json": JSON.stringify({ root: "page", ...home }, null, 2) };
  for (const [id, spec] of Object.entries(layouts)) files[`layouts/${id}.json`] = JSON.stringify(spec, null, 2);
  return {
    format: "spec",
    files,
    pages: [{ id: "home", pageType: "booking", component: { file: "pages/home.json", export: "default" } }],
    layouts: Object.keys(layouts).map((id) => ({ id, component: { file: `layouts/${id}.json`, export: "default" } })),
    scenarios: [{ id: "home-open", state: "room-open", page: "home" }],
    flow: { states: [], tasks: [] },
  };
}

const config = { ...nook, inventories: { ...nook.inventories, layouts: ["card", "panel", "question", "shelf"] } };
const problems = (prototype: Prototype) => specModel(prototype, config).problems.map((problem) => problem.message);
const pageRoot = (prototype: Prototype): ElementNode => {
  const found = specModel(prototype, config).pages[0];
  if (!found) throw new Error(JSON.stringify(problems(prototype)));
  return found.root;
};
const flat = (node: ElementNode): ElementNode[] => [node, ...node.children.flatMap(flat)];

const QUESTION = {
  params: { label: { type: "text" }, answer: { type: "binding" }, choices: { type: "list", of: "option" } },
  root: "box",
  elements: {
    box: { type: "Stack.Root", props: {}, children: ["label", "field"] },
    label: { type: "Label.Root", props: { htmlFor: { $scopedId: "field" }, text: { $param: "label" } }, children: [] },
    field: { type: "Field.Root", props: { id: { $scopedId: "field" } }, children: ["select"] },
    select: { type: "Field.Select", props: { value: { $param: "answer" }, options: { $param: "choices" } }, children: [] },
  },
};
const CHOICES = [{ value: "a", label: "A" }];
const page = (slots: Record<string, string[]>) => ({ type: "Page", props: {}, slots, children: [] });

describe("expansion", () => {
  const twice = project(
    {
      elements: {
        page: page({ body: ["first", "second"] }),
        first: { type: "Layout", props: { id: "question", label: "How long?", choices: CHOICES, answer: { $bindState: "/long" } }, children: [] },
        second: { type: "Layout", props: { id: "question", label: "How many?", choices: CHOICES, answer: { $bindState: "/many" } }, children: [] },
      },
    },
    { question: QUESTION },
  );

  it("keys every instance's elements under the instance, and scopes its ids, so two instances never collide", () => {
    const spec = resolvePageSpec(twice, config, { id: "home-open", state: "room-open", page: "home" });
    expect(spec?.elements.page?.slots?.body).toEqual(["first/box", "second/box"]);
    expect(spec?.elements["first/label"]?.props).toEqual({ htmlFor: "first/field", text: "How long?" });
    expect(spec?.elements["second/label"]?.props).toEqual({ htmlFor: "second/field", text: "How many?" });
    expect(spec?.elements["first/field"]?.props).toEqual({ id: "first/field" });
    expect(spec?.elements["second/select"]?.props).toEqual({ options: CHOICES, value: { $bindState: "/many" } });
    expect(problems(twice)).toEqual([]);
  });

  it("nests instance keys, passes a parameter on, and keeps a literal list for a repeat in the page's state", () => {
    const prototype = project(
      { elements: { page: page({ body: ["outer"] }), outer: { type: "Layout", props: { id: "panel", rows: ["Screen", "Desk"] }, children: [] } } },
      {
        panel: { params: { rows: { type: "list", of: "text" } }, root: "box", elements: { box: { type: "Stack.Root", props: {}, children: ["inner"] }, inner: { type: "Layout", props: { id: "shelf", items: { $param: "rows" } }, children: [] } } },
        shelf: { params: { items: { type: "list", of: "text" } }, root: "list", elements: { list: { type: "Stack.Root", props: {}, repeat: { param: "items" }, children: ["row"] }, row: { type: "Text.Root", props: { as: "p", text: { $item: "" } }, children: [] } } },
      },
    );
    const spec = resolvePageSpec(prototype, config, { id: "home-open", state: "room-open", page: "home" });
    expect(spec?.elements.page?.slots?.body).toEqual(["outer/box"]);
    expect(spec?.elements["outer/box"]?.children).toEqual(["outer/inner/list"]);
    expect(spec?.elements["outer/inner/list"]?.repeat).toEqual({ statePath: "/params/outer~1inner/items" });
    expect(spec?.state.params).toEqual({ "outer/inner": { items: ["Screen", "Desk"] } });
    expect(flat(pageRoot(prototype)).filter((node) => node.name === "Text.Root").map((node) => node.text)).toEqual(["Screen", "Desk"]);
    expect(problems(prototype)).toEqual([]);
  });

  it("makes a scoped id per item inside one keyed repeat, and refuses one inside a repeat with no key", () => {
    const card = { params: {}, root: "box", elements: { box: { type: "Card.Root", props: {}, children: ["field"] }, field: { type: "Field.Root", props: { id: { $scopedId: "f" } }, children: [] } } };
    const keyed = project({ elements: { page: page({ body: ["list"] }), list: { type: "Stack.Root", props: {}, repeat: { statePath: "/rooms", key: "id" }, children: ["card"] }, card: { type: "Layout", props: { id: "card" }, children: [] } }, state: { rooms: [{ id: "a" }, { id: "b" }] } }, { card });
    expect(resolvePageSpec(keyed, config, { id: "home-open", state: "room-open", page: "home" })?.elements["card/field"]?.props).toEqual({ id: { $template: "card/f/${id}" } });
    const ids = flat(pageRoot(keyed)).filter((node) => node.name === "Field.Root").map((node) => node.props.id);
    expect(ids).toEqual([
      { kind: "literal", value: "card/f/a" },
      { kind: "literal", value: "card/f/b" },
    ]);
    const unkeyed = project({ elements: { page: page({ body: ["list"] }), list: { type: "Stack.Root", props: {}, repeat: { statePath: "/rooms" }, children: ["card"] }, card: { type: "Layout", props: { id: "card" }, children: [] } }, state: { rooms: [{ id: "a" }] } }, { card });
    expect(problems(unkeyed)).toEqual(['layouts/card.json: element "field" sets { "$scopedId": "f" } inside a repeat with no key, so the id would repeat on the page. It is unique per item only inside one repeat that names its "key".']);
  });

  it("refuses a value that reads the page's item where the layout repeats, since it would read the layout's item", () => {
    const shelf = { params: { label: { type: "text" } }, root: "list", elements: { list: { type: "Stack.Root", props: {}, repeat: { statePath: "/things" }, children: ["row"] }, row: { type: "Text.Root", props: { as: "p", text: { $param: "label" } }, children: [] } } };
    const prototype = project({ elements: { page: page({ body: ["rooms"] }), rooms: { type: "Stack.Root", props: {}, repeat: { statePath: "/rooms" }, children: ["shelf"] }, shelf: { type: "Layout", props: { id: "shelf", label: { $item: "name" } }, children: [] } }, state: { rooms: [{ name: "a" }], things: [1] } }, { shelf });
    expect(problems(prototype)).toEqual(['layouts/shelf.json: element "row" reads parameter "label" inside a repeat of layout "shelf", but the value it was given reads the repeat item where it is used, so here it would read the layout\'s item instead. Give the value from page state, or move the repeat out of the layout.']);
  });

  it("stops a layout that draws itself, and the rules say they cannot tell", () => {
    const prototype = project({ elements: { page: page({ body: ["loop"] }), loop: { type: "Layout", props: { id: "panel" }, children: [] } } }, { panel: { root: "box", elements: { box: { type: "Stack.Root", props: {}, children: ["again"] }, again: { type: "Layout", props: { id: "panel" }, children: [] } } } });
    const nodes = flat(pageRoot(prototype));
    expect(nodes.filter((node) => node.kind === "unresolved").map((node) => node.reason)).toEqual(['layout "panel" draws itself, so how deep it goes cannot be known']);
  });

  it("is the same whatever order the files' keys come in", () => {
    /** The same JSON with every object's keys reversed. */
    const reverse = (value: unknown): unknown => (Array.isArray(value) ? value.map(reverse) : typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverse(item)])) : value);
    const reordered: Prototype = {
      ...legal,
      files: Object.fromEntries(
        Object.entries(legal.files)
          .reverse()
          .map(([path, text]) => [path, JSON.stringify(reverse(JSON.parse(text)), null, 2)]),
      ),
      layouts: [...legal.layouts].reverse(),
      pages: [...legal.pages].reverse(),
    };
    /** JSON with keys sorted, so two values compare by content alone. */
    const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => (typeof item === "object" && item !== null && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : 1))) : item));
    for (const scenario of legal.scenarios) expect(canonical(resolvePageSpec(reordered, nook, scenario))).toBe(canonical(resolvePageSpec(legal, nook, scenario)));
    const strip = (nodes: readonly ElementNode[]): unknown => nodes.map((node) => ({ ...node, at: undefined, children: strip(node.children) }));
    const a = specModel(legal, nook);
    const b = specModel(reordered, nook);
    expect(canonical(strip(b.pages.map((item) => item.root)))).toBe(canonical(strip(a.pages.map((item) => item.root))));
    const report = (prototype: Prototype) => checkPrototype({ config: nook, prototype }).rules.map((rule) => [rule.rule, rule.status]);
    expect(report(reordered)).toEqual(report(legal));
    // A finding keeps its words however the keys came in; only lines move.
    const broken = (prototype: Prototype) => ({ ...prototype, files: { ...prototype.files, "pages/booking.json": (prototype.files["pages/booking.json"] as string).replace(/"Hold room"/, '"Hold room", "variant": "primary"').replace(/"variant": "secondary", /, "") } });
    expect(checkPrototype({ config: nook, prototype: broken(legal) }).rules.find((rule) => rule.rule === "one-primary-per-page")?.status).toBe("fail");
  });
});

describe("parameter validation", () => {
  const withQuestion = (props: Record<string, unknown>, layout: Record<string, unknown> = QUESTION, slots?: Record<string, string[]>, more: Record<string, unknown> = {}) =>
    project({ elements: { page: page({ body: ["q"] }), q: { type: "Layout", props: { id: "question", ...props }, ...(slots ? { slots } : {}), children: [] }, ...more } }, { question: layout });

  it("checks each value against its parameter's type, and names what the layout takes", () => {
    expect(problems(withQuestion({ label: 30, choices: CHOICES, answer: { $bindState: "/a" } }))).toEqual(['pages/home.json: element "q" gives "label" 30; "label" is text.']);
    expect(problems(withQuestion({ label: "L", choices: [{ value: 1 }], answer: { $bindState: "/a" } }))).toEqual(['pages/home.json: element "q" gives "choices" [{"value":1}]; "choices" is a list of { "value", "label" } options.']);
    expect(problems(withQuestion({ label: "L", choices: CHOICES, answer: "/a" }))).toEqual(['pages/home.json: element "q" gives "answer" "/a"; "answer" is a binding, { "$bindState": "/path" }, where the part writes its value: give { "$bindState": "/path" }.']);
    expect(problems(withQuestion({ label: { $bindState: "/x" }, choices: CHOICES, answer: { $bindState: "/a" } }))).toEqual(['pages/home.json: element "q" gives "label" {"$bindState":"/x"}; "label" is text: a literal, or $state, $item, $cond, $template or $scopedId.']);
    expect(problems(withQuestion({ label: "L", choices: CHOICES, answer: { $bindState: "/scenario/state" } }))).toEqual(['pages/home.json: element "q" gives "answer" {"$bindState":"/scenario/state"}; "answer" is a binding, { "$bindState": "/path" }, where the part writes its value, and /scenario/state is the harness\'s, set for each scenario.']);
    expect(problems(withQuestion({ label: "L", choices: CHOICES, answer: { $bindState: "/a" }, colour: "red" }))).toEqual(['pages/home.json: element "q" sets "colour", which layout "question" does not take. It takes "answer", "choices", "label".']);
    expect(problems(withQuestion({ choices: CHOICES, answer: { $bindState: "/a" } }))).toEqual(['pages/home.json: element "q" has no "label", which layout "question" needs.']);
    // Expressions that read the page are taken, and judged where the layout uses them.
    const reading = withQuestion({ label: { $template: "Pick ${/x}" }, choices: { $state: "/c" }, answer: { $bindState: "/a" } });
    expect(problems(reading)).toEqual(['layouts/question.json: reads state /x, which the state of page "home" does not have, so it shows nothing there.', 'layouts/question.json: reads state /c, which the state of page "home" does not have, so it shows nothing there.']);
    const label = flat(pageRoot({ ...reading, files: { ...reading.files, "pages/home.json": (reading.files["pages/home.json"] as string).replace('"root": "page",', '"root": "page", "state": { "x": "a room", "c": [] },') } })).find((node) => node.name === "Label.Root");
    expect(label?.text).toBe("Pick a room");
  });

  it("checks enums, defaults and conditions", () => {
    const tone = { params: { tone: { type: "enum", values: ["secondary", "ghost"], default: "ghost" } }, root: "b", elements: { b: { type: "Button.Root", props: { variant: { $param: "tone" }, text: "Go" }, children: [] } } };
    expect(problems(withQuestion({ tone: "primary" }, tone))).toEqual(['pages/home.json: element "q" gives "tone" "primary"; "tone" is one of "secondary", "ghost".']);
    expect(problems(withQuestion({ tone: { $cond: { $state: "/scenario/state", eq: "held" }, $then: "secondary", $else: "loud" } }, tone))).toEqual(['pages/home.json: element "q" gives "tone" "loud"; "tone" is one of "secondary", "ghost".']);
    const button = flat(pageRoot(withQuestion({}, tone))).find((node) => node.name === "Button.Root");
    expect(button?.props.variant).toEqual({ kind: "literal", value: "ghost" });
  });

  it("checks a layout's own declarations and uses of its parameters", () => {
    const bad = {
      params: { "Bad name": { type: "text" }, size: { type: "colour" }, kind: { type: "enum", values: ["a", "b"] }, rows: { type: "list", of: "text" }, more: { type: "slot" }, twice: { type: "slot", required: false }, n: { type: "number", default: "x" } },
      root: "box",
      elements: {
        box: { type: "Stack.Root", props: {}, children: ["a", "b", "c", { $param: "twice" }, { $param: "twice" }] },
        c: { type: "Stack.Root", props: {}, children: [{ $param: "kind" }] },
        a: { type: "Button.Root", props: { variant: { $param: "kind" }, text: { $param: "rows" } }, children: [] },
        b: { type: "Text.Root", props: { as: "p", text: { $param: "nothing" } }, repeat: { param: "kind" }, children: [] },
      },
    };
    expect(problems(withQuestion({ kind: "a", rows: [], n: 1 }, bad, { more: ["x"] }, { x: { type: "Text.Root", props: { as: "p", text: "x" }, children: [] } })).sort()).toEqual([
      'layouts/question.json: element "a" sets text with parameter "rows", but it is a list of texts, and the prop takes text.',
      'layouts/question.json: element "a" sets variant with parameter "kind", but it can be "a", "b", which the prop does not take.',
      'layouts/question.json: element "b" repeats over parameter "kind", which is a enum, not a list.',
      'layouts/question.json: element "b" sets text with { "$param": "nothing" }, which is not a parameter of this layout ("kind", "more", "rows", "twice").',
      'layouts/question.json: element "c" lists parameter "kind" among its children, but "kind" is a enum, not a slot.',
      'layouts/question.json: declares slot "more" but places it nowhere: list { "$param": "more" } in the children of the element that holds it.',
      'layouts/question.json: places slot "twice" 2 times; the elements a page passes in are drawn once, so list it once.',
      'layouts/question.json: gives parameter "n" the default "x", which is not a number.',
      'layouts/question.json: gives parameter "size" no type it knows; a parameter is { "type": "text", "number", "boolean", "enum", "list", "binding", "slot", ... }.',
      'layouts/question.json: has a parameter named "Bad name"; a name starts with a lowercase letter, holds letters, digits and "-", and is not "id", which names the layout.',
      'pages/home.json: element "q" sets "n", which layout "question" does not take. It takes "kind", "rows".',
    ].sort());
  });

  it("checks slots: a slot the layout lacks, a required one left empty, and $param outside a layout", () => {
    const boxed = { params: { body: { type: "slot" } }, root: "box", elements: { box: { type: "Card.Root", props: {}, children: [{ $param: "body" }] } } };
    const text = { x: { type: "Text.Root", props: { as: "p", text: "x" }, children: [] } };
    expect(problems(withQuestion({}, boxed, { other: ["x"] }, text))).toEqual(['pages/home.json: element "q" fills slot "other", which layout "question" does not have; its slots are "body".', 'pages/home.json: element "q" has nothing in slot "body", which layout "question" needs.']);
    expect(problems(project({ elements: { page: page({ title: ["t"] }), t: { type: "Text.Root", props: { as: "h1", text: { $param: "x" } }, children: [] } } }, {}))).toEqual(['pages/home.json: element "t" sets text with { "$param": "x" }, but only a layout has parameters.']);
    expect(problems(project({ elements: { page: page({ body: ["q"] }), q: { type: "Layout", props: { id: "nowhere" }, children: [] } } }, {}))).toEqual(['pages/home.json: element "q" draws layout "nowhere", which is not a layout of the manifest (none).']);
  });
});

describe("findings inside an instance", () => {
  it("point at the layout's element and at the page's use of it", () => {
    const second = { ...legal, files: { ...legal.files, "layouts/room-details.json": (legal.files["layouts/room-details.json"] as string).replace('"children": ["summary", "items"]', '"children": ["summary", "items", "go"]').replace('    "item":', '    "go": { "type": "Button.Root", "props": { "text": "Book room" }, "children": [] },\n    "item":') } };
    const report = checkPrototype({ config: nook, prototype: second });
    expect(report.findings.find((item) => item.rule === "one-primary-per-page")?.message).toContain('Button.Root "Book room" at layouts/room-details.json:11:5 (in layout "room-details" used at pages/booking.json:21:5)');
    const outside = report.findings.find((item) => item.rule === "primary-outside-disclosure");
    expect(outside).toMatchObject({ file: "layouts/room-details.json", line: 11, column: 5, via: [{ layout: "room-details", file: "pages/booking.json", line: 21, column: 5 }] });
    expect(outside?.message).toContain("at layouts/room-details.json:11:5 (in layout \"room-details\" used at pages/booking.json:21:5)");
  });

  it("point at a page's element passed into a slot, and at where the layout places it", () => {
    const passed = { ...legal, files: { ...legal.files, "pages/booking.json": bookingFile.replace('"answer": { "$bindState": "/duration" } }, "children": []', '"answer": { "$bindState": "/duration" } }, "slots": { "hint": ["book-early"] }, "children": []').replace('    "hold":', '    "book-early": { "type": "Button.Root", "props": { "text": "Book early" }, "children": [] },\n    "hold":') } };
    const report = checkPrototype({ config: nook, prototype: passed });
    expect(report.rules.filter((rule) => rule.status === "fail").map((rule) => rule.rule)).toEqual(["one-primary-per-page", "primary-is-rank-1"]);
    const finding = report.findings.find((item) => item.rule === "primary-is-rank-1");
    expect(finding).toMatchObject({ file: "pages/booking.json", line: 22, column: 5, via: [{ layout: "select-question", slot: "hint", file: "layouts/select-question.json", line: 10, column: 5 }] });
    expect(finding?.message).toContain('Button.Root "Book early" at pages/booking.json:22:5 (in slot "hint" of layout "select-question" at layouts/select-question.json:10:5)');
  });

  it("name every use, nearest first, through nested layouts", () => {
    const prototype = project(
      { elements: { page: page({ body: ["outer"], action: ["go"] }), outer: { type: "Layout", props: { id: "panel" }, children: [] }, go: { type: "Button.Root", props: { text: "Book room" }, children: [] } } },
      { panel: { root: "box", elements: { box: { type: "Stack.Root", props: {}, children: ["inner"] }, inner: { type: "Layout", props: { id: "card" }, children: [] } } }, card: { root: "b", elements: { b: { type: "Button.Root", props: { text: "Reserve" }, children: [] } } } },
    );
    const finding = checkPrototype({ config, prototype }).findings.find((item) => item.rule === "primary-is-rank-1");
    expect(finding?.via?.map((use) => `${use.layout}@${use.file}`)).toEqual(["card@layouts/panel.json", "panel@pages/home.json"]);
    expect(finding?.message).toMatch(/at layouts\/card\.json:4:5 \(in layout "card" used at layouts\/panel\.json:11:5, in layout "panel" used at pages\/home\.json:\d+:5\)/);
  });
});

describe("the layouts of a prototype", () => {
  it("lists each with its parameters, from the layout files", () => {
    const layouts = specLayouts(legal, nook);
    expect(layouts.map((layout) => layout.id)).toEqual(["room-cards", "room-details", "select-question"]);
    const question = layouts.find((layout) => layout.id === "select-question");
    expect(question?.params.map((param) => [param.name, param.type, param.required])).toEqual([
      ["answer", "binding", true],
      ["choices", "list", true],
      ["hint", "slot", false],
      ["label", "text", true],
    ]);
    expect(question?.uses).toEqual([{ file: "pages/booking.json", key: "question", line: 20 }]);
    expect(layouts.find((layout) => layout.id === "room-details")?.params.find((param) => param.name === "summary")).toMatchObject({ default: "Room details", words: "text" });
  });

  it("expands for one scenario without a manifest page of its own", () => {
    const read = readSpecs(legal, nook);
    const expanded = expandPage({ id: "booking", pageType: "booking", component: { file: "pages/booking.json", export: "default" } }, read, legal);
    expect([...(expanded.page?.elements.keys() ?? [])].filter((key) => key.startsWith("details/"))).toEqual(["details/details", "details/summary", "details/items", "details/item"]);
  });
});
