import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nook } from "../examples/nook/project";
import { checkPrototype } from "../src/engine/check";
import type { CheckReport, Finding } from "../src/engine/report";
import type { Prototype } from "../src/prototype/types";
import { formatSpec } from "../src/spec/format";
import type { JsonValue } from "../src/spec/json";
import { findingIsOfPage, pickScope } from "../src/variants/pick-scope";
import { withPageSpec } from "../src/variants/variants";
import { EXAMPLES, loadCases, loadPrototype } from "./fixtures";

/**
 * A pick on one page answers for that page, and for what it brings or
 * changes elsewhere, never for a failure another page already had. These
 * run core's own reports on the Nook spec prototype and its illegal cases.
 */

const legal = loadPrototype(join(EXAMPLES, "spec", "legal", "booking"));
const cases = loadCases(legal, join(EXAMPLES, "spec", "illegal"));
const illegal = (name: string): Prototype => {
  const found = cases.find((item) => item.name === name);
  if (!found) throw new Error(`no illegal case "${name}"`);
  return found.prototype;
};
const check = (prototype: Prototype): CheckReport => checkPrototype({ config: nook, prototype });
const BOOKING = "pages/booking.json";
type Spec = { elements: Record<string, { props?: Record<string, JsonValue> }> };

/** The booking page with its question asked another way: a variant that breaks nothing. */
const passingBooking = (): string => {
  const spec = JSON.parse(legal.files[BOOKING] as string) as Spec;
  (spec.elements.question!.props as Record<string, JsonValue>).label = "For how long?";
  return formatSpec(spec as unknown as JsonValue);
};
/** The booking page with Hold room made a second primary action. */
const failingBooking = (): string => (legal.files[BOOKING] as string).replace('"variant": "secondary", "text": "Hold room"', '"variant": "primary", "text": "Hold room"');

describe("what a pick on one page answers for", () => {
  it("is clear when the prototype passes and the page still does", () => {
    const after = withPageSpec(legal, "booking", passingBooking());
    expect(pickScope(check(legal), check(after), after, "booking")).toEqual({ page: [], introduced: [], existing: [], stopped: [], clear: true });
  });

  it("does not answer for a failure another page already had", () => {
    const before = illegal("primary-on-collection");
    const after = withPageSpec(before, "booking", passingBooking());
    const reports = { before: check(before), after: check(after) };
    expect(reports.after.status).toBe("fail");
    const scope = pickScope(reports.before, reports.after, after, "booking");
    expect(scope.clear).toBe(true);
    expect(scope.page).toEqual([]);
    expect(scope.introduced).toEqual([]);
    expect(scope.existing.map((finding) => [finding.rule, finding.page])).toEqual([["no-primary-on-collection-or-content", "rooms"]]);
  });

  it("answers for every finding of the picked page, with the other page's failure left out of it", () => {
    const before = illegal("primary-on-collection");
    expect(failingBooking()).not.toBe(legal.files[BOOKING]);
    const after = withPageSpec(before, "booking", failingBooking());
    const scope = pickScope(check(before), check(after), after, "booking");
    expect(scope.clear).toBe(false);
    expect(scope.page.length).toBeGreaterThan(0);
    expect(new Set(scope.page.map((finding) => finding.page))).toEqual(new Set(["booking"]));
    expect(scope.page.map((finding) => finding.rule)).toContain("one-primary-per-page");
    expect(scope.existing.map((finding) => finding.page)).toEqual(["rooms"]);
  });

  it("answers for a finding the page already had: the page applied must be clean", () => {
    const before = withPageSpec(legal, "booking", failingBooking());
    const report = check(before);
    const scope = pickScope(report, report, before, "booking");
    expect(scope.clear).toBe(false);
    expect(scope.page).toEqual(report.findings);
    expect(scope.existing).toEqual([]);
  });

  it("counts a finding inside a layout the page draws as the page's, and one in another page's file as not", () => {
    const after = illegal("second-primary");
    const report = check(after);
    expect(report.findings.some((finding) => finding.message.includes("layouts/select-question.json"))).toBe(true);
    expect(pickScope(check(legal), report, after, "booking").page).toEqual(report.findings);
    expect(pickScope(check(legal), report, after, "rooms").page).toEqual([]);
    // A finding that names no page: its file, or the file that draws the layout it is in, says whose it is.
    const inLayout: Finding = { rule: "catalog", kind: "violation", message: "m", file: "layouts/select-question.json", line: 3, column: 5, via: [{ layout: "select-question", file: BOOKING, line: 9, column: 7 }] };
    expect(findingIsOfPage(inLayout, legal, "booking")).toBe(true);
    expect(findingIsOfPage(inLayout, legal, "rooms")).toBe(false);
    expect(findingIsOfPage({ rule: "catalog", kind: "violation", message: "m", file: "pages/rooms.json" }, legal, "booking")).toBe(false);
    expect(findingIsOfPage({ rule: "flow", kind: "violation", message: "m", scenario: "lantern-held", state: "held" }, legal, "booking")).toBe(true);
    expect(findingIsOfPage({ rule: "flow", kind: "violation", message: "m", scenario: "rooms-list", state: "rooms" }, legal, "booking")).toBe(false);
  });

  it("leaves a prototype-wide finding alone when it reads the same, and answers for one that is new or changed", () => {
    const noFlow = check(illegal("task-without-flow"));
    const overBudget = check(illegal("route-over-budget"));
    const wide = (report: CheckReport) => report.findings.filter((finding) => finding.rule === "step-budget");
    expect(wide(noFlow).length).toBeGreaterThan(0);
    expect(wide(noFlow).every((finding) => !findingIsOfPage(finding, legal, "booking") && !findingIsOfPage(finding, legal, "rooms"))).toBe(true);

    const same = pickScope(noFlow, noFlow, illegal("task-without-flow"), "booking");
    expect(same.clear).toBe(true);
    expect(same.existing).toEqual(wide(noFlow));

    const changed = pickScope(noFlow, overBudget, illegal("route-over-budget"), "booking");
    expect(changed.clear).toBe(false);
    expect(changed.introduced).toEqual(wide(overBudget));
    expect(changed.existing).toEqual([]);

    const brought = pickScope(check(legal), overBudget, illegal("route-over-budget"), "booking");
    expect(brought.introduced).toEqual(wide(overBudget));
  });

  it("tells one more of the same finding from the ones that were there", () => {
    const finding: Finding = { rule: "step-budget", kind: "violation", message: "Task \"hold-room\" has no flow" };
    const report = (findings: readonly Finding[]): CheckReport => ({ status: "fail", rules: [{ rule: "step-budget", type: "flow", status: "fail", findings }], findings });
    const scope = pickScope(report([finding]), report([finding, finding]), legal, "booking");
    expect(scope.existing).toEqual([finding]);
    expect(scope.introduced).toEqual([finding]);
    // The same finding with its keys in another order is the same finding.
    const reordered = { message: finding.message, kind: finding.kind, rule: finding.rule } as Finding;
    expect(pickScope(report([finding]), report([reordered]), legal, "booking").clear).toBe(true);
  });

  it("answers for a rule that ran before and did not run after", () => {
    const ran: CheckReport = { status: "pass", rules: [{ rule: "target-size", type: "rendered", status: "pass", findings: [] }], findings: [] };
    const notRun: CheckReport = { status: "incomplete", rules: [{ rule: "target-size", type: "rendered", status: "not-run", note: "no snapshots", findings: [] }], findings: [] };
    expect(pickScope(ran, notRun, legal, "booking")).toMatchObject({ stopped: ["target-size"], clear: false });
    expect(pickScope(notRun, notRun, legal, "booking")).toMatchObject({ stopped: [], clear: true });
  });

  it("is deterministic: the same lists, in core's order, whatever order the reports' findings come in", () => {
    const before = illegal("primary-on-collection");
    const after = withPageSpec(before, "booking", failingBooking());
    const reports = { before: check(before), after: check(after) };
    const shuffled: CheckReport = { ...reports.before, findings: [...reports.before.findings].reverse() };
    expect(pickScope(shuffled, reports.after, after, "booking")).toEqual(pickScope(reports.before, reports.after, after, "booking"));
  });
});
