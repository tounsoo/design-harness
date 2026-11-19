import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tally } from "../examples/tally/project";
import { checkPrototype } from "../src/engine/check";
import type { CheckReport } from "../src/engine/report";
import { confirmRoles, draftRoles, type LibraryDescription, type RoleConfirmation } from "../src/library/roles";
import { parseProjectConfig } from "../src/parse";
import { specToTsx } from "../src/export/tsx";
import { specCatalog } from "../src/spec/catalog";
import { loadCases, loadPrototype, type IllegalCase } from "./fixtures";

/**
 * Tally, the second worked example, on Mantine: its config is valid, its
 * roles are core's draft as `roles.json` confirms it, its parts are
 * Mantine's description cut to what it inventories, the legal spec prototype
 * passes every rule the engine runs without a renderer (the end-to-end test
 * measures the rendered ones in Chromium), each illegal one fails for its
 * named rule alone, and each refused one is refused by the catalog alone.
 * Tally has no TSX prototype of its own: its legal spec, exported as TSX,
 * is the base its illegal TSX cases replace files of.
 */
const EXAMPLE = join(import.meta.dirname, "..", "examples", "tally");
const SPEC = join(EXAMPLE, "prototypes", "spec");
const legal = loadPrototype(join(SPEC, "legal", "expense"));
const full = JSON.parse(readFileSync(join(import.meta.dirname, "..", "libraries", "mantine-core-9.7.4.json"), "utf8")) as LibraryDescription;

function failing(report: CheckReport): string[] {
  return report.rules.filter((rule) => rule.status === "fail").map((rule) => rule.rule);
}

function expectCase(item: IllegalCase) {
  const report = checkPrototype({ config: tally, prototype: item.prototype });
  expect(failing(report).sort()).toEqual([...new Set(item.expect.map((entry) => entry.rule))].sort());
  for (const entry of item.expect) {
    const messages = report.findings.filter((finding) => finding.rule === entry.rule).map((finding) => finding.message);
    expect(messages.some((message) => message.includes(entry.message)), `${entry.rule} should say "${entry.message}"; it said:\n${messages.join("\n")}`).toBe(true);
  }
}

describe("the Tally project on Mantine", () => {
  it("is a valid config", () => {
    const parsed = parseProjectConfig(JSON.parse(JSON.stringify(tally)));
    expect(parsed.ok ? [] : parsed.error).toEqual([]);
  });

  it("carries Mantine's description of exactly the exports it inventories and its root", () => {
    const keep = new Set([...tally.inventories.components, tally.library.root?.component]);
    const expected = Object.fromEntries(Object.entries(full.parts).filter(([part]) => keep.has(part.split(".")[0])));
    expect(tally.library.parts).toEqual(expected);
    expect(full.package).toBe(tally.library.package);
    expect(full.version).toBe(tally.library.version);
  });

  it("has the roles core's draft gives, as roles.json confirms them, with its one correction", () => {
    const confirmation = JSON.parse(readFileSync(join(EXAMPLE, "roles.json"), "utf8")) as RoleConfirmation;
    const confirmed = confirmRoles(full, confirmation);
    if (!confirmed.ok) throw new Error(JSON.stringify(confirmed.error));
    expect(confirmed.value.roles).toEqual(tally.library.roles);
    expect(confirmed.value.excludedProps).toEqual(tally.library.excludedProps);
    expect(confirmed.value.exclusion.decision).toBe("accepted");
    expect(confirmed.value.record.filter((entry) => entry.decision === "corrected").map((entry) => entry.role)).toEqual(["question"]);
    // The draft is the same from the project's cut of the description: the roles depend only on the parts they name.
    const mappings = (description: LibraryDescription) => draftRoles(description).guesses.map((guess) => [guess.role, guess.mapping]);
    expect(mappings({ package: full.package, version: full.version, parts: tally.library.parts ?? {} })).toEqual(mappings(full));
  });

  it("gives a spec catalog of Mantine's parts, leaving out the props whose types cannot be read", () => {
    const catalog = specCatalog(tally);
    expect(catalog?.components.Button?.props.variant).toEqual({ type: "enum", values: ["default", "filled", "gradient", "light", "outline", "subtle", "transparent", "white"], required: false });
    expect(catalog?.components.Button?.roles).toEqual(["action", "primary-action", "secondary-action"]);
    expect(catalog?.components.Button?.unknownProps).toContain("gradient");
    // Mantine's style props are excluded: no part's catalog entry offers one.
    for (const component of Object.values(catalog?.components ?? {})) for (const prop of tally.library.excludedProps ?? []) expect(component.props[prop]).toBeUndefined();
    expect(catalog?.components.Button?.excludedProps).toEqual(expect.arrayContaining(["bg", "c", "fz", "m", "p", "w"]));
    expect(catalog?.components["Accordion.Item"]?.roles).toEqual(["disclosure"]);
    expect(catalog?.components.NumberInput?.props.label).toEqual({ type: "string", required: false });
    // The root is not inventoried, so a spec cannot draw it: the frame wraps every page in it.
    expect(catalog?.components.MantineProvider).toBeUndefined();
  });
});

describe("the legal Tally spec prototype", () => {
  it("passes every rule that runs without a renderer; the rendered ones wait for snapshots", () => {
    const report = checkPrototype({ config: tally, prototype: legal });
    expect(report.findings).toEqual([]);
    expect(report.rules.filter((rule) => rule.status !== "pass").map((rule) => [rule.rule, rule.status])).toEqual(
      tally.rules
        .filter((rule) => rule.type === "rendered")
        .map((rule) => [rule.id, "not-run"])
        .sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1)),
    );
  });
});

const illegal = loadCases(legal, join(SPEC, "illegal"));
const refused = loadCases(legal, join(SPEC, "refused"));

describe("each illegal Tally spec fails for its one named reason", () => {
  it("has at least four cases", () => expect(illegal.length).toBeGreaterThanOrEqual(4));
  for (const item of illegal) it(`${item.name}: ${item.what}`, () => expectCase(item));
});

describe("each refused Tally spec is refused by the catalog, and by nothing else", () => {
  it("has cases", () => expect(refused.length).toBeGreaterThan(0));
  for (const item of refused) {
    it(`${item.name}: ${item.what}`, () => {
      expect(item.expect.every((entry) => entry.rule === "extract")).toBe(true);
      expectCase(item);
    });
  }
});

describe("a library's root part", () => {
  it("must be a part the library has, whose scheme prop takes light and dark", () => {
    const issues = (root: unknown) => {
      const parsed = parseProjectConfig(JSON.parse(JSON.stringify({ ...tally, library: { ...tally.library, root } })));
      return parsed.ok ? [] : parsed.error.map((issue) => `${issue.path} ${issue.message}`);
    };
    expect(issues({ component: "MantineProvider", schemeProp: "forceColorScheme" })).toEqual([]);
    expect(issues({ component: "ThemeProvider" })).toEqual(['$.library.root.component is "ThemeProvider", which @mantine/core 9.7.4 has no part of']);
    expect(issues({ component: "MantineProvider", schemeProp: "withCssVariables" })).toEqual(['$.library.root.schemeProp "withCssVariables" of MantineProvider does not take "light" and "dark"']);
  });
});

describe("the Tally prototype as TSX", () => {
  it("is written with no excluded prop: a spec cannot hold one, so the export cannot write one", () => {
    const exported = specToTsx(legal, tally);
    if (!exported.ok) throw new Error(exported.error);
    const excluded = tally.library.excludedProps ?? [];
    expect(excluded.length).toBeGreaterThan(10);
    for (const [path, text] of Object.entries(exported.value.prototype.files)) {
      const attributes = new Set([...text.matchAll(/\s([A-Za-z][\w-]*)=[{"]/g)].map((match) => match[1] as string));
      for (const prop of excluded) if (!prop.includes("*")) expect(attributes.has(prop), `${path} sets ${prop}`).toBe(false);
    }
  });
});
