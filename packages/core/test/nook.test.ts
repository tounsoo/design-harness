import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkPrototype } from "../src/engine/check";
import type { CheckReport } from "../src/engine/report";
import { nook } from "../examples/nook/project";
import { renderedCases } from "../examples/nook/rendered-cases";
import { legalSnapshots } from "../examples/nook/snapshots";
import { EXAMPLES, loadCases, loadPrototype } from "./fixtures";

const legal = loadPrototype(join(EXAMPLES, "legal", "booking"));

describe("the legal Nook prototype", () => {
  it("passes every rule, rendered rules included", () => {
    const report = checkPrototype({ config: nook, prototype: legal, snapshots: legalSnapshots() });
    expect(report.findings).toEqual([]);
    expect(report.status).toBe("pass");
  });
});

const cases = loadCases(legal, join(EXAMPLES, "illegal"));

function failing(report: CheckReport): string[] {
  return report.rules.filter((rule) => rule.status === "fail").map((rule) => rule.rule);
}

describe("each illegal Nook prototype fails for its one named reason", () => {
  it("has cases", () => expect(cases.length).toBeGreaterThan(25));

  for (const item of cases) {
    it(`${item.name}: ${item.what}`, () => {
      const config = item.caps ? { ...nook, inputs: { ...nook.inputs, caps: Object.fromEntries(Object.entries(nook.inputs.caps).map(([name, cap]) => [name, { ...cap, value: item.caps?.[name] ?? cap.value }])) } } : nook;
      const report = checkPrototype({ config, prototype: item.prototype });
      expect(failing(report).sort()).toEqual([...new Set(item.expect.map((entry) => entry.rule))].sort());
      for (const entry of item.expect) {
        const messages = report.findings.filter((finding) => finding.rule === entry.rule).map((finding) => finding.message);
        expect(messages.some((message) => message.includes(entry.message)), `${entry.rule} should say "${entry.message}"; it said:\n${messages.join("\n")}`).toBe(true);
      }
    });
  }

  for (const item of renderedCases) {
    it(`${item.name}: ${item.what}`, () => {
      const report = checkPrototype({ config: nook, prototype: legal, snapshots: item.snapshots() });
      expect(failing(report)).toEqual(item.expect.map((entry) => entry.rule));
      for (const entry of item.expect) {
        const messages = report.findings.filter((finding) => finding.rule === entry.rule).map((finding) => finding.message);
        expect(messages.some((message) => message.includes(entry.message)), `${entry.rule} should say "${entry.message}"; it said:\n${messages.join("\n")}`).toBe(true);
      }
    });
  }
});
