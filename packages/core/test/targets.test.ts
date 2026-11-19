import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nook } from "../examples/nook/project";
import { checkPrototype } from "../src/engine/check";
import type { CheckReport, Finding } from "../src/engine/report";
import { EXAMPLES, loadCases, loadPrototype, type IllegalCase } from "./fixtures";

/**
 * Where a finding's elements render (`Finding.targets`): every element-level
 * finding names each element it is about, with its page and, in a spec, its
 * key in the expanded page, so the web app can outline it in every frame
 * that draws it. A finding about a whole page names none.
 */

const legalSpec = loadPrototype(join(EXAMPLES, "spec", "legal", "booking"));
const specCases = new Map(loadCases(legalSpec, join(EXAMPLES, "spec", "illegal")).map((item) => [item.name, item]));

function configFor(item: IllegalCase) {
  return item.caps ? { ...nook, inputs: { ...nook.inputs, caps: Object.fromEntries(Object.entries(nook.inputs.caps).map(([name, cap]) => [name, { ...cap, value: item.caps?.[name] ?? cap.value }])) } } : nook;
}

function reportOf(item: IllegalCase | undefined): CheckReport {
  if (!item) throw new Error("no such case");
  return checkPrototype({ config: configFor(item), prototype: item.prototype });
}

function findingOf(report: CheckReport, rule: string): Finding {
  const found = report.findings.find((finding) => finding.rule === rule);
  if (!found) throw new Error(`${rule} found nothing`);
  return found;
}

describe("finding targets in a spec prototype", () => {
  it("names both primary actions by their keys in the expanded page, one passed into a layout's slot", () => {
    const finding = findingOf(reportOf(specCases.get("slot-second-primary")), "one-primary-per-page");
    expect(finding.targets?.map((target) => [target.page, target.key, target.file, target.via?.map((use) => use.layout)])).toEqual([
      ["booking", "book-early", "pages/booking.json", ["select-question"]],
      ["booking", "book", "pages/booking.json", undefined],
    ]);
  });

  it("names an element a layout instance draws by its key under the instance, with the page's use", () => {
    const finding = findingOf(reportOf(specCases.get("nested-disclosure")), "disclosure-depth");
    expect(finding.targets).toEqual([{ file: "layouts/room-details.json", line: finding.line, column: finding.column, via: finding.via, page: "booking", key: "details/access" }]);
    expect(finding.via?.[0]).toMatchObject({ layout: "room-details", file: "pages/booking.json" });
  });

  it("names a slot a page fills by the page's root key", () => {
    const finding = findingOf(reportOf(specCases.get("unknown-slot")), "page-structure");
    expect(finding.targets?.map((target) => target.key)).toEqual([expect.stringMatching(/^page\/slots\//)]);
  });

  it("finds an element read from a file as written on the page that draws it, under its key", () => {
    const rule = { type: "count" as const, id: "no-hold", scope: "source" as const, select: { component: "Button.Root", text: "Hold room" }, max: 0 };
    const finding = findingOf(checkPrototype({ config: { ...nook, rules: [rule] }, prototype: legalSpec }), "no-hold");
    expect(finding.page).toBeUndefined();
    expect(finding.targets).toEqual([{ file: "pages/booking.json", line: finding.line, column: finding.column, page: "booking", key: "hold" }]);
  });

  it("names an element no page draws with no page, so no frame can show it", () => {
    const spare = JSON.stringify({ root: "spare", elements: { spare: { type: "Button.Root", props: { text: "Book room" }, children: [] } } });
    const prototype = { ...legalSpec, files: { ...legalSpec.files, "layouts/spare.json": spare } };
    const finding = findingOf(checkPrototype({ config: nook, prototype }), "counted-parts-reached");
    expect(finding.targets?.length).toBeGreaterThan(0);
    for (const target of finding.targets ?? []) expect(target.page).toBeUndefined();
  });

  it("stands a layout instance for the outermost elements it draws", () => {
    // Room details moved from the body into the primary slot: what the slot holds is the instance, outlined as the layout's root.
    const file = (legalSpec.files["pages/booking.json"] as string).replace('"body": ["question", "details"]', '"body": ["question"]').replace('"action": ["book"]', '"action": ["book", "details"]');
    const report = checkPrototype({ config: nook, prototype: { ...legalSpec, files: { ...legalSpec.files, "pages/booking.json": file } } });
    const finding = report.findings.find((item) => item.rule === "primary-slot" && item.message.includes("room-details"));
    expect(finding?.targets?.map((target) => [target.page, target.key, target.file])).toEqual([["booking", "details/details", "layouts/room-details.json"]]);
  });

  it("gives a finding about a whole page or a flow no targets", () => {
    expect(findingOf(reportOf(specCases.get("unknown-page-type")), "page-types-from-inventory").targets).toBeUndefined();
    expect(findingOf(reportOf(specCases.get("state-without-scenario")), "state-coverage").targets).toBeUndefined();
    expect(findingOf(reportOf(specCases.get("route-over-budget")), "step-budget").targets).toBeUndefined();
  });

  it("gives every finding the same targets in the same order, whatever order the files come in", () => {
    const item = specCases.get("slot-second-primary") as IllegalCase;
    const reversed = { ...item.prototype, files: Object.fromEntries(Object.entries(item.prototype.files).reverse()) };
    expect(checkPrototype({ config: nook, prototype: reversed })).toEqual(reportOf(item));
  });
});
