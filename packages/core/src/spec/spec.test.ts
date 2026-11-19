import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nook } from "../../examples/nook/project";
import { EXAMPLES, loadPrototype } from "../../test/fixtures";
import { checkPrototype } from "../engine/check";
import type { ElementNode } from "../extract/model";
import { applyProposal } from "../proposals/apply";
import type { Prototype } from "../prototype/types";
import { LAYOUT_TYPE, PAGE_TYPE, specCatalog } from "./catalog";
import { parseJson } from "./json";
import { specIssues, specModel } from "./model";
import { resolvePageSpec } from "./resolve";

const legal = loadPrototype(join(EXAMPLES, "spec", "legal", "booking"));

/** A spec prototype with one booking page, `pages/home.json`, whose elements and state are given. */
function home(elements: Record<string, unknown>, extra: { state?: Record<string, unknown>; files?: Record<string, string>; layouts?: Prototype["layouts"]; scenarios?: Prototype["scenarios"] } = {}): Prototype {
  return {
    format: "spec",
    files: { "pages/home.json": JSON.stringify({ root: "page", elements, ...(extra.state ? { state: extra.state } : {}) }, null, 2), ...extra.files },
    pages: [{ id: "home", pageType: "booking", component: { file: "pages/home.json", export: "default" } }],
    layouts: extra.layouts ?? [],
    scenarios: extra.scenarios ?? [],
    flow: { states: [], tasks: [] },
  };
}

const page = (slots: Record<string, string[]>, children: string[] = []) => ({ type: "Page", props: {}, slots, children });

function tree(prototype: Prototype): ElementNode {
  const model = specModel(prototype, nook);
  const found = model.pages.find((item) => item.id === "home");
  if (!found) throw new Error(`no home page: ${JSON.stringify(model.problems)}`);
  return found.root;
}

function flat(node: ElementNode): ElementNode[] {
  return [node, ...node.children.flatMap(flat)];
}

const problems = (prototype: Prototype) => specModel(prototype, nook).problems.map((problem) => problem.message);

describe("parseJson", () => {
  it("keeps where each key starts, by JSON Pointer", () => {
    const parsed = parseJson('{\n  "root": "a",\n  "elements": {\n    "a/b": { "type": "X" }\n  }\n}');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.positions.get("/root")).toEqual({ line: 2, column: 3 });
    expect(parsed.positions.get("/elements/a~1b")).toEqual({ line: 4, column: 5 });
    expect(parsed.positions.get("/elements/a~1b/type")).toEqual({ line: 4, column: 14 });
    expect(parsed.value).toEqual({ root: "a", elements: { "a/b": { type: "X" } } });
  });

  it("refuses a key written twice, which JSON.parse would keep silently", () => {
    const parsed = parseJson('{ "slots": { "title": [], "title": ["x"] } }');
    expect(parsed).toEqual({ ok: false, message: 'has the key "title" twice in one object', at: { line: 1, column: 27 } });
  });

  it("words its own errors, the same in every engine", () => {
    expect(parseJson('{ "a": 1, }')).toMatchObject({ ok: false, message: 'expected a key in quotes, found "}"' });
    expect(parseJson('{ "a": tru }')).toMatchObject({ ok: false, message: 'expected a value, found "t"' });
    expect(parseJson('"open')).toMatchObject({ ok: false, message: "has a string that never ends" });
    expect(parseJson("[1] 2")).toMatchObject({ ok: false, message: 'has more after the value ends, at "2"' });
  });

  it("parses what JSON.parse parses, __proto__ as an own key", () => {
    const text = '{"__proto__": {"x": 1}, "n": -1.5e3, "s": "a\\u0041\\n", "l": [true, false, null]}';
    const parsed = parseJson(text);
    expect(parsed.ok && parsed.value).toEqual(JSON.parse(text));
    expect(parsed.ok && Object.getPrototypeOf(parsed.value)).toBe(Object.prototype);
    expect(parsed.ok && Object.hasOwn(parsed.value as object, "__proto__")).toBe(true);
  });
});

describe("the catalog generated from the config", () => {
  const catalog = specCatalog(nook);
  if (!catalog) throw new Error("Nook has part descriptions");

  it("holds the parts of the inventoried components, Page and Layout, and nothing else", () => {
    const names = Object.keys(catalog.components);
    const roots = new Set(names.filter((name) => name !== PAGE_TYPE && name !== LAYOUT_TYPE).map((name) => name.split(".")[0]));
    expect([...roots].sort()).toEqual([...nook.inventories.components].sort());
    expect(names).toContain("Button.Root");
    expect(names).toContain("Field.Select");
    expect(names).not.toContain("Badge.Root");
    expect(names).not.toContain("Toast.Root");
    expect(names).toEqual([...names].sort());
  });

  it("gives each part the props its types declare, text where it takes children, and its roles", () => {
    const button = catalog.components["Button.Root"];
    expect(button?.props.variant).toEqual({ type: "enum", values: ["ghost", "primary", "secondary"], required: false });
    expect(button?.props.text).toEqual({ type: "string", required: false });
    expect(button?.props.style).toBeUndefined();
    expect(button?.props.onClick).toBeUndefined();
    expect(button?.roles).toEqual(["action", "primary-action", "secondary-action"]);
    expect(button?.events).toEqual(["press"]);
    expect(button?.description).toContain('With variant "primary" (or no variant), it is a primary action.');
    expect(catalog.components["Text.Root"]?.events).toEqual([]);
    expect(catalog.components["Label.Root"]?.props.htmlFor).toEqual({ type: "string", required: true });
    expect(catalog.components["Field.Select"]).toMatchObject({ content: "options", props: { options: { type: "options", required: true }, value: { type: "string", required: true, bind: "onValueChange" } } });
    expect(catalog.components[PAGE_TYPE]?.slots).toEqual(["action", "alternate", "body", "facts", "intro", "title"]);
  });

  it("is the same whatever order the inventory lists components in", () => {
    const shuffled = { ...nook, inventories: { ...nook.inventories, components: [...nook.inventories.components].reverse() } };
    expect(JSON.stringify(specCatalog(shuffled))).toBe(JSON.stringify(catalog));
  });

  it("gains a component's parts when a proposal adds it to the inventory, leaving out the ones a spec cannot render", () => {
    const proposal = { id: "toast", title: "Toast", reason: "A toast", states: [], inventory: [{ op: "add-component" as const, name: "Toast" }], rules: { add: [], remove: [] }, examples: { pass: [], fail: [] }, status: "open" as const, history: [] };
    const applied = applyProposal(nook, proposal);
    if (!applied.ok) throw new Error(applied.error);
    const after = specCatalog(applied.value);
    expect(Object.keys(after?.components ?? {}).filter((name) => name.startsWith("Toast."))).toEqual(["Toast.Action", "Toast.Close", "Toast.Description", "Toast.Icon", "Toast.Root", "Toast.Title"]);
    expect(after?.left).toContainEqual({ component: "Toast.Region", why: 'it needs "children", "toaster", which a spec cannot give' });
  });

  it("is null for a library without part descriptions, and a spec prototype then fails extract", () => {
    const bare = { ...nook, library: { ...nook.library, parts: undefined } } as unknown as typeof nook;
    expect(specCatalog(bare)).toBeNull();
    const report = checkPrototype({ config: bare, prototype: legal });
    expect(report.rules.find((rule) => rule.rule === "extract")?.findings[0]?.message).toContain("has no part descriptions (library.parts)");
  });
});

describe("the library description", () => {
  it("is what describe-library writes from Todae's declarations", () => {
    const root = join(import.meta.dirname, "..", "..", "..", "..");
    const written = execFileSync("node", [join(root, "packages/core/scripts/describe-library.mjs"), "@tounsoo/todae", "0.10.1"], { cwd: root, encoding: "utf8" });
    expect(written).toBe(readFileSync(join(root, "packages/core/libraries/todae-0.10.1.json"), "utf8"));
  }, 30_000);
});

describe("a spec as core's page model", () => {
  it("makes the Page the page's node, each slot a Slot in the page type's order, and each part a library node", () => {
    const root = tree(home({ page: page({ action: ["book"], title: ["name"] }), book: { type: "Button.Root", props: { text: "Book room" }, children: [] }, name: { type: "Text.Root", props: { as: "h1", text: "Lantern" }, children: [] } }));
    expect(root).toMatchObject({ kind: "component", name: "Page", page: "home", text: "LanternBook room" });
    expect(root.children.map((slot) => [slot.kind, slot.name, slot.props.name])).toEqual([
      ["kit", "Slot", { kind: "literal", value: "title" }],
      ["kit", "Slot", { kind: "literal", value: "action" }],
    ]);
    const book = root.children[1]?.children[0];
    expect(book).toMatchObject({ kind: "library", name: "Button.Root", props: {}, text: "Book room", textDynamic: false, origin: "pages/home.json#book" });
    expect(book?.at).toEqual({ file: "pages/home.json", line: 17, column: 5 });
  });

  it("resolves state the page never writes, and makes state it writes dynamic", () => {
    const root = tree(
      home(
        {
          page: page({ title: ["name"], body: ["count"], action: ["book"] }),
          name: { type: "Text.Root", props: { as: { $state: "/level" }, text: { $template: "${/room/name}, ${/room/seats} seats" } }, children: [] },
          count: { type: "Field.Root", props: {}, children: ["select"] },
          select: { type: "Field.Select", props: { value: { $bindState: "/count" }, options: [{ value: "1", label: "One" }] }, children: [] },
          book: { type: "Button.Root", props: { variant: { $state: "/count" }, text: { $state: "/count" } }, children: [] },
        },
        { state: { level: "h1", room: { name: "Lantern", seats: 6 }, count: "1" } },
      ),
    );
    const [name, select, book] = ["Text.Root", "Field.Select", "Button.Root"].map((type) => flat(root).find((node) => node.name === type));
    expect(name?.props.as).toEqual({ kind: "literal", value: "h1" });
    expect(name?.text).toBe("Lantern, 6 seats");
    expect(select?.props.value).toEqual({ kind: "dynamic", reason: "bound to state /count, which the person changes" });
    expect(book?.props.variant).toEqual({ kind: "dynamic", reason: "read from state /count, which the page changes at run time" });
    expect(book?.textDynamic).toBe(true);
  });

  it("reads the scenario's flow state as one of the states its scenarios show, and a $cond as a choice", () => {
    const root = tree(
      home(
        {
          page: page({ action: ["book"] }),
          book: { type: "Button.Root", props: { variant: { $cond: { $state: "/scenario/state", eq: "held" }, $then: "secondary", $else: "primary" }, text: { $state: "/scenario/state" } }, children: [] },
        },
        { scenarios: [{ id: "b", state: "held", page: "home" }, { id: "a", state: "booked", page: "home" }, { id: "c", state: "held", page: "other" }] },
      ),
    );
    const book = flat(root).find((node) => node.name === "Button.Root");
    expect(book?.props.variant).toEqual({ kind: "choice", values: ["secondary", "primary"] });
    expect(book?.textDynamic).toBe(true);
  });

  it("expands a repeat over a list nothing writes, item by item, and marks one over a list the page changes as repeated", () => {
    const elements = {
      page: page({ body: ["list"] }),
      list: { type: "Stack.Root", props: {}, repeat: { statePath: "/rooms", key: "id" }, children: ["open"] },
      open: { type: "Button.Root", props: { variant: "secondary", text: { $template: "Open ${name}" } }, children: [] },
    };
    const known = flat(tree(home(elements, { state: { rooms: [{ id: "a", name: "Lantern" }, { id: "b", name: "Harbor" }] } }))).filter((node) => node.name === "Button.Root");
    expect(known.map((node) => [node.text, node.repeated, node.origin])).toEqual([
      ["Open Lantern", false, "pages/home.json#open"],
      ["Open Harbor", false, "pages/home.json#open"],
    ]);
    const written = { ...elements, add: { type: "Button.Root", props: { variant: "secondary", text: "Add" }, on: { press: { action: "pushState", params: { statePath: "/rooms", value: { id: "c", name: "New" } } } }, children: [] } };
    written.page = page({ body: ["list"], alternate: ["add"] });
    const unknown = flat(tree(home(written, { state: { rooms: [{ id: "a", name: "Lantern" }] } }))).filter((node) => node.name === "Button.Root" && node.text !== "Add");
    expect(unknown.map((node) => [node.textDynamic, node.repeated])).toEqual([[true, true]]);
  });

  it("draws a layout in place as a layout node, and a layout that draws itself as unresolved", () => {
    const layouts = [{ id: "room-details", component: { file: "layouts/details.json", export: "default" } }];
    const details = JSON.stringify({ root: "box", elements: { box: { type: "Disclosure.Root", props: {}, children: ["again"] }, again: { type: "Layout", props: { id: "room-details" }, children: [] } } });
    const root = tree(home({ page: page({ body: ["details"] }), details: { type: "Layout", props: { id: "room-details" }, children: [] } }, { layouts, files: { "layouts/details.json": details } }));
    const layout = root.children[0]?.children[0];
    expect(layout).toMatchObject({ kind: "component", name: "room-details", layout: "room-details", origin: "pages/home.json#details" });
    expect(layout?.children[0]).toMatchObject({ kind: "library", name: "Disclosure.Root", origin: "layouts/details.json#box" });
    expect(layout?.children[0]?.children[0]).toMatchObject({ kind: "unresolved", reason: 'layout "room-details" draws itself, so how deep it goes cannot be known' });
  });

  it("leaves out an element shown never, keeps one shown under a condition, and lists every element written in source", () => {
    const prototype = home({
      page: page({ facts: ["never", "sometimes"] }),
      never: { type: "Text.Root", props: { as: "p", text: "Never" }, visible: false, children: [] },
      sometimes: { type: "Text.Root", props: { as: "p", text: "Sometimes" }, visible: { $state: "/scenario/state", eq: "held" }, children: [] },
      orphan: { type: "Button.Root", props: { text: "Confirm" }, children: [] },
    });
    const facts = tree(prototype).children[0];
    expect(facts?.children.map((node) => [node.text, node.conditional])).toEqual([["Sometimes", true]]);
    const source = specModel(prototype, nook).source;
    expect(source.map((node) => node.origin)).toEqual(["pages/home.json#page", "pages/home.json#orphan"]);
  });

  it("is the same model however the files' keys are ordered", () => {
    const reordered: Prototype = { ...legal, files: Object.fromEntries(Object.entries(legal.files).reverse().map(([path, text]) => [path, JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(text) as object).reverse()))])) };
    const strip = (prototype: Prototype) => JSON.stringify(specModel(prototype, nook), (key, value: unknown) => (key === "at" ? undefined : value));
    expect(strip(reordered)).toBe(strip(legal));
  });
});

describe("spec validation against the catalog", () => {
  it("reports a part outside the catalog, a prop a part does not take and a value outside its type, each where it is", () => {
    const issues = specIssues(
      home({
        page: page({ title: ["badge"], action: ["book"] }),
        badge: { type: "Badge.Root", props: { text: "Free" }, children: [] },
        book: { type: "Button.Root", props: { variant: "danger", style: { color: "red" }, text: "Book room" }, children: [] },
      }),
      nook,
    );
    expect(issues.map((issue) => `${issue.at.line}:${issue.at.column} ${issue.message}`)).toEqual([
      expect.stringMatching(/^\d+:\d+ pages\/home\.json: element "badge" is a Badge\.Root, which is not in the catalog\./),
      expect.stringMatching(/element "book" sets "style", a style prop the project excludes \("style" in library\.excludedProps\): a Button\.Root.s styling must come from the library.s own variants and tokens/),
      expect.stringMatching(/element "book" sets variant to "danger"; a Button\.Root's variant is one of "ghost", "primary", "secondary"\./),
    ]);
  });

  it("refuses what would make a spec code or let it reach the harness: $computed, custom actions, watchers, the scenario's state", () => {
    const messages = problems(
      home({
        page: page({ action: ["book"] }),
        book: {
          type: "Button.Root",
          props: { text: { $computed: "label" }, pressed: { $bindState: "/scenario/state" } },
          on: { press: [{ action: "navigate", params: {} }, { action: "setState", params: { statePath: "/scenario/state", value: "booked" } }] },
          watch: { "/x": { action: "setState" } },
          children: [],
        },
      }),
    );
    expect(messages).toEqual([
      'pages/home.json: element "book" has "watch", which runs actions when state changes; a spec here may not.',
      'pages/home.json: element "book" binds pressed to /scenario/state, which the harness sets for each scenario.',
      'pages/home.json: element "book" sets text with $computed, which calls a function; a spec here registers none, so it stays data.',
      'pages/home.json: element "book" binds press to the action "navigate"; a spec here may use only "setState", "pushState", "removeState", which change the page\'s own state.',
      'pages/home.json: element "book" binds press to setState on /scenario/state, which the harness sets for each scenario.',
    ]);
  });

  it("checks the tree: keys that exist, one parent each, a Page only at a page's root, layouts the manifest has", () => {
    const messages = problems(
      home({
        page: page({ title: ["a", "missing"], body: ["a", "lay"] }),
        a: { type: "Stack.Root", props: {}, children: ["b"] },
        b: { type: "Stack.Root", props: {}, children: ["a"] },
        c: { type: "Stack.Root", props: {}, children: ["d"] },
        d: { type: "Stack.Root", props: {}, children: ["c"] },
        lay: { type: "Layout", props: { id: "nowhere" }, children: [] },
      }),
    );
    expect(messages).toContain('pages/home.json: element "page" lists "missing", which is not an element.');
    expect(messages).toContain('pages/home.json: element "page" lists "a" twice. An element is drawn once; give the copy a key of its own.');
    expect(messages).toContain('pages/home.json: element "b" lists "a", which "page" already lists. An element has one parent; give the copy a key of its own.');
    expect(messages).toContain('pages/home.json: element "c" is inside itself, so it would render forever.');
    expect(messages).toContain('pages/home.json: element "lay" draws layout "nowhere", which is not a layout of the manifest (none).');
  });

  it("reports a state path the page does not have, and $item outside a repeat", () => {
    const messages = problems(home({ page: page({ title: ["name"] }), name: { type: "Text.Root", props: { as: "h1", text: { $state: "/room/nmae" }, id: { $item: "id" } }, children: [] } }, { state: { room: { name: "Lantern" } } }));
    expect(messages).toEqual(['pages/home.json: reads { "$item": "id" } outside a repeat, so it reads nothing.', 'pages/home.json: reads state /room/nmae, which the state of page "home" does not have, so it shows nothing there.']);
  });

  it("refuses code in a spec prototype", () => {
    const prototype = { ...legal, files: { ...legal.files, "pages/extra.tsx": "export default function X() { return null; }" } };
    expect(problems(prototype)).toEqual(["pages/extra.tsx is not a JSON spec. A spec prototype holds only JSON spec files; it runs no code."]);
  });
});

describe("a page as the one spec a frame renders", () => {
  it("draws each layout in place under keys of its own, keeps only what passed, and sets the scenario in its state", () => {
    const scenario = { id: "lantern-held", state: "held", page: "booking" };
    const spec = resolvePageSpec(legal, nook, scenario);
    expect(spec?.root).toBe("page");
    expect(spec?.elements.page?.slots?.body).toEqual(["question/question", "details/details"]);
    expect(spec?.elements["details/items"]).toMatchObject({ type: "Stack.Root", repeat: { statePath: "/room/details" }, children: ["details/item"] });
    expect(spec?.elements["details/summary"]?.props).toEqual({ text: "Room details" });
    expect(spec?.elements["question/field"]?.props).toEqual({ id: "question/field" });
    expect(spec?.elements["question/label"]?.props).toEqual({ htmlFor: "question/field", text: "How long?" });
    expect(spec?.elements["question/select"]?.props).toEqual({ options: { $state: "/durations" }, value: { $bindState: "/duration" } });
    expect(Object.values(spec?.elements ?? {}).some((element) => element.type === "Layout")).toBe(false);
    expect(spec?.state.scenario).toEqual({ id: "lantern-held", state: "held" });
    expect(spec?.state.room).toMatchObject({ name: "Lantern" });

    const broken = home({ page: page({ title: ["ok", "bad"] }), ok: { type: "Text.Root", props: { as: "h1", text: "Hi", style: { color: "red" } }, children: [] }, bad: { type: "Badge.Root", props: {}, children: [] } });
    const resolved = resolvePageSpec(broken, nook, { id: "s", state: "x", page: "home" });
    expect(resolved?.elements.page?.slots?.title).toEqual(["ok"]);
    expect(resolved?.elements.ok?.props).toEqual({ as: "h1", text: "Hi" });
  });
});
