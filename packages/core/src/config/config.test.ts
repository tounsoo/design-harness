import { describe, expect, it } from "vitest";
import { nook } from "../../examples/nook/project";
import { BUILT_IN_RULES } from "../builtins";
import { parseProjectConfig, parsePrototype, parseSnapshots } from "../parse";
import { TSX_REFUSED } from "../prototype/schema";
import { legalSnapshots } from "../../examples/nook/snapshots";

const json = <T>(value: T): unknown => JSON.parse(JSON.stringify(value));
const issues = (result: { ok: boolean; error?: readonly { path: string; message: string }[] }) => (result.ok ? [] : (result.error ?? []).map((issue) => `${issue.path}: ${issue.message}`));

describe("the project config", () => {
  it("round-trips the worked example through JSON", () => {
    const parsed = parseProjectConfig(json(nook));
    expect(issues(parsed)).toEqual([]);
    expect(parsed.ok && parsed.value).toEqual(nook);
  });

  it("names every shape error with its path, unknown fields included", () => {
    const bad = json({ ...nook, schemaVersion: 2, extra: true, views: [{ name: "Phone", width: 0, height: 844, scheme: "dim" }] });
    expect(issues(parseProjectConfig(bad))).toEqual([
      "$.schemaVersion: expected one of 1, got 2",
      "$.views[0].name: expected a lowercase slug such as \"book-room\", got \"Phone\"",
      "$.views[0].width: expected a whole number of at least 1, got 0",
      "$.views[0].scheme: expected one of \"light\", \"dark\", got \"dim\"",
      '$: has an unknown field "extra"; expected only "schemaVersion", "id", "name", "library", "inventories", "inputs", "views", "rules", "proposals"',
    ]);
  });

  it("names the library and React by exact version, and its stylesheets by path inside the package", () => {
    const library = { ...nook.library, package: "Todae", version: "^0.10.1", react: "19", stylesheets: ["/dist/todae.css", "../secret.css"] };
    expect(issues(parseProjectConfig(json({ ...nook, library })))).toEqual([
      '$.library.package: expected an npm package name such as "@tounsoo/todae", got "Todae"',
      '$.library.version: expected an exact version such as "1.2.3", not a range, got "^0.10.1"',
      '$.library.react: expected an exact version such as "1.2.3", not a range, got "19"',
      '$.library.stylesheets[0]: expected a path inside the package such as "dist/todae.css", got "/dist/todae.css"',
      '$.library.stylesheets[1]: expected a path inside the package such as "dist/todae.css", got "../secret.css"',
    ]);
  });

  it("rejects a rule with a misspelled field instead of ignoring it", () => {
    const rules = [{ type: "count", id: "x", scope: "page", select: { role: "primary-action" }, maxx: 1 }];
    expect(issues(parseProjectConfig(json({ ...nook, rules })))).toEqual([
      '$.rules[0]: has an unknown field "maxx"; expected only "id", "type", "select", "scope", "description", "min", "max", "pages", "each"',
    ]);
  });

  it("rejects references a rule would silently check nothing with", () => {
    const rules = [
      { type: "count", id: "a", scope: "page", select: { role: "question" }, max: { cap: "MAX_QUESTIONS" } },
      { type: "count", id: "a", scope: "page", select: { text: { rank: 9 } }, max: 1 },
      { type: "slot", id: "b", slot: "footer", only: { layout: "sidebar" } },
      { type: "count", id: "c", scope: "pages", each: "disclosedSections", select: { role: "disclosure" }, min: 1 },
      { type: "requires", id: "extract", select: { text: { each: true } }, must: { role: "action" } },
    ];
    const roles = { ...nook.library.roles, question: { components: ["Input.Root"] } };
    expect(issues(parseProjectConfig(json({ ...nook, rules, library: { ...nook.library, roles } })))).toEqual([
      '$.rules[1]: rule id "a" appears twice',
      '$.rules[0].max: names cap "MAX_QUESTIONS", which is not in inputs.caps (MAX_DISCLOSURES_PER_PAGE, MAX_DISCLOSURE_DEPTH, MAX_VISIBLE_QUESTIONS, TARGET_MIN_PX)',
      '$.rules[0]: selects role "question", which the library maps to Input.Root, but Input is not an inventoried component, so the rule could never fire',
      "$.rules[1].select.text: names rank 9, which inputs.ranking does not have",
      '$.rules[2].slot: names slot "footer", which no page type has',
      '$.rules[2].only.layout: names layout "sidebar", which is not inventoried',
      '$.rules[3].each: repeats over disclosedSections, but the selector never uses { "each": true }, so every repeat counts the same thing',
      '$.rules[4].id: "extract" is reserved for what the extractor could not read',
      '$.rules[4].select.text: uses { "each": true } outside a count rule with "each"',
    ]);
  });

  it("checks page types and tasks against the inventories", () => {
    const pageTypes = [{ id: "booking", kind: "action", slots: ["title", "action"], chrome: ["title", "facts"], primarySlot: "action" }];
    const tasks = [{ id: "book-room", successState: "paid", maxSteps: 3 }];
    expect(issues(parseProjectConfig(json({ ...nook, rules: [], inventories: { ...nook.inventories, pageTypes }, inputs: { ...nook.inputs, tasks } })))).toEqual([
      '$.inventories.pageTypes[0].chrome: names slot "facts", which page type "booking" does not have',
      '$.inventories.pageTypes[0]: page type "booking" has no body slot: every slot is chrome or primary',
      '$.inputs.tasks[0].successState: is "paid", which is not an inventoried flow state',
    ]);
  });

  it("does not let a collection page type name a primary slot", () => {
    const pageTypes = [{ id: "rooms", kind: "collection", slots: ["title", "body"], chrome: ["title"], primarySlot: "body" }];
    expect(issues(parseProjectConfig(json({ ...nook, rules: [], inventories: { ...nook.inventories, pageTypes } })))).toEqual([
      '$.inventories.pageTypes[0]: has an unknown field "primarySlot"; expected only "id", "slots", "chrome", "kind"',
    ]);
  });

  it("accepts the built-in rules on their own", () => {
    expect(issues(parseProjectConfig(json({ ...nook, rules: BUILT_IN_RULES })))).toEqual([]);
  });

  it("refuses the TSX-only rule types and the imports subject, which the vocabulary no longer has", () => {
    const retired = [
      { type: "isolation", id: "no-ambient-globals" },
      { type: "style-props", id: "no-inline-styles" },
      { type: "membership", id: "imports-from-library", of: "imports" },
    ];
    expect(issues(parseProjectConfig(json({ ...nook, rules: retired })))).toEqual([
      '$.rules[0].type: expected one of "membership", "count", "containment", "prop-values", "requires", "slot", "reachable", "page-structure", "flow", "rendered", got "isolation"',
      '$.rules[1].type: expected one of "membership", "count", "containment", "prop-values", "requires", "slot", "reachable", "page-structure", "flow", "rendered", got "style-props"',
      '$.rules[2].of: expected one of "components", "page-types", "layouts", "flow-states", got "imports"',
    ]);
  });
});

describe("the prototype and snapshots", () => {
  it("rejects duplicate ids and paths that are not relative", () => {
    const prototype = {
      format: "spec",
      files: { "./pages/a.json": "", "pages/../b.json": "" },
      pages: [{ id: "a", pageType: "booking", component: { file: "pages/a.json", export: "default" } }, { id: "a", pageType: "booking", component: { file: "pages/a.json", export: "default" } }],
      layouts: [],
      scenarios: [],
      flow: { states: [], tasks: [] },
    };
    expect(issues(parsePrototype(prototype)).map((issue) => issue.split(":")[0])).toEqual(["$.files../pages/a.json", "$.files.pages/../b.json"]);
    expect(issues(parsePrototype({ ...prototype, files: {} }))).toEqual(['$.pages[1]: page id "a" appears twice']);
  });

  it("refuses a TSX prototype, said or meant by a missing format, and hands a whole one back as it was stored", () => {
    const manifest = {
      files: { "pages/a.tsx": "export const A = () => null;" },
      pages: [{ id: "a", pageType: "booking", component: { file: "pages/a.tsx", export: "A" } }],
      layouts: [],
      scenarios: [],
      flow: { states: [], tasks: [] },
    };
    for (const stored of [{ ...manifest, format: "tsx" }, manifest]) {
      const read = parsePrototype(json(stored));
      expect(issues(read)).toEqual([`$.format: ${TSX_REFUSED}`]);
      expect(!read.ok && "tsx" in read && read.tsx).toEqual({ ...manifest, format: "tsx" });
    }
    const broken = parsePrototype(json({ ...manifest, format: "tsx", pages: "none" }));
    expect(issues(broken)).toEqual([`$.format: ${TSX_REFUSED}`, "$.pages: expected an array, got a string"]);
    expect("tsx" in broken).toBe(false);
    expect(issues(parsePrototype(json({ ...manifest, format: "jsx" })))).toEqual(['$.format: expected one of "spec", got "jsx"']);
  });

  it("round-trips the example's snapshots through JSON", () => {
    const parsed = parseSnapshots(json(legalSnapshots()));
    expect(parsed.ok && parsed.value).toEqual(legalSnapshots());
  });
});
