import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nook } from "../examples/nook/project";
import { legalSnapshots } from "../examples/nook/snapshots";
import { checkPrototype } from "../src/engine/check";
import type { CheckReport } from "../src/engine/report";
import { EXAMPLES, loadCases, loadPrototype, type IllegalCase } from "./fixtures";

/**
 * The Nook prototype as json-render specs: the legal one passes every rule,
 * each illegal one fails for its named rule alone, as its TSX counterpart
 * does, and each refused one is refused by the catalog's validation, which
 * the always-on extract rule reports, and nothing else.
 */
const SPEC = join(EXAMPLES, "spec");
const legal = loadPrototype(join(SPEC, "legal", "booking"));

function failing(report: CheckReport): string[] {
  return report.rules.filter((rule) => rule.status === "fail").map((rule) => rule.rule);
}

function configFor(item: IllegalCase) {
  return item.caps ? { ...nook, inputs: { ...nook.inputs, caps: Object.fromEntries(Object.entries(nook.inputs.caps).map(([name, cap]) => [name, { ...cap, value: item.caps?.[name] ?? cap.value }])) } } : nook;
}

function expectCase(item: IllegalCase) {
  const report = checkPrototype({ config: configFor(item), prototype: item.prototype });
  expect(failing(report).sort()).toEqual([...new Set(item.expect.map((entry) => entry.rule))].sort());
  for (const entry of item.expect) {
    const messages = report.findings.filter((finding) => finding.rule === entry.rule).map((finding) => finding.message);
    expect(messages.some((message) => message.includes(entry.message)), `${entry.rule} should say "${entry.message}"; it said:\n${messages.join("\n")}`).toBe(true);
  }
}

describe("the legal Nook spec prototype", () => {
  it("is a spec prototype of JSON files only", () => {
    expect(legal.format).toBe("spec");
    expect(Object.keys(legal.files).every((path) => path.endsWith(".json"))).toBe(true);
  });

  it("passes every rule, rendered rules included", () => {
    const report = checkPrototype({ config: nook, prototype: legal, snapshots: legalSnapshots() });
    expect(report.findings).toEqual([]);
    expect(report.status).toBe("pass");
  });
});

const illegal = loadCases(legal, join(SPEC, "illegal"));
const refused = loadCases(legal, join(SPEC, "refused"));

describe("each illegal Nook spec fails for its one named reason", () => {
  it("has at least 8 cases ported from the TSX fixtures", () => expect(illegal.length).toBeGreaterThanOrEqual(8));
  for (const item of illegal) it(`${item.name}: ${item.what}`, () => expectCase(item));
});

describe("each refused Nook spec is refused by the catalog, and by nothing else", () => {
  it("has cases", () => expect(refused.length).toBeGreaterThan(5));
  for (const item of refused) {
    it(`${item.name}: ${item.what}`, () => {
      expect(item.expect.every((entry) => entry.rule === "extract")).toBe(true);
      expectCase(item);
    });
  }
});
