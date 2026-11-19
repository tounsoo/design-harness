import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkPrototype } from "../src/engine/check";
import type { CheckReport } from "../src/engine/report";
import { nook } from "../examples/nook/project";
import { renderedCases } from "../examples/nook/rendered-cases";
import { EXAMPLES, loadPrototype } from "./fixtures";

/**
 * The rendered rules on Nook: each rendered case changes the legal spec
 * prototype's snapshots in one way and fails for its one named rule. The
 * legal, illegal and refused spec prototypes are spec-fixtures.test.ts.
 */
const legal = loadPrototype(join(EXAMPLES, "spec", "legal", "booking"));

function failing(report: CheckReport): string[] {
  return report.rules.filter((rule) => rule.status === "fail").map((rule) => rule.rule);
}

describe("each rendered Nook case fails for its one named reason", () => {
  it("has cases", () => expect(renderedCases.length).toBeGreaterThan(5));

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
