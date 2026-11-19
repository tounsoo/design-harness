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

const legalTsx = loadPrototype(join(EXAMPLES, "legal", "booking"));
const legalSpec = loadPrototype(join(EXAMPLES, "spec", "legal", "booking"));
const tsxCases = new Map(loadCases(legalTsx, join(EXAMPLES, "illegal")).map((item) => [item.name, item]));
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

function lineOf(text: string, fragment: string): number {
  const index = text.split("\n").findIndex((line) => line.includes(fragment));
  if (index < 0) throw new Error(`no line has ${fragment}`);
  return index + 1;
}

describe("finding targets in a TSX prototype", () => {
  it("names both primary actions of a page with two, each where it is written, on its page", () => {
    const file = "pages/booking.tsx";
    const text = legalTsx.files[file]?.replace('<Button.Root variant="secondary">Hold room</Button.Root>', '<Button.Root variant="primary">Hold room</Button.Root>') ?? "";
    const report = checkPrototype({ config: nook, prototype: { ...legalTsx, files: { ...legalTsx.files, [file]: text } } });
    const finding = findingOf(report, "one-primary-per-page");
    expect(finding.targets).toEqual([
      { file, line: lineOf(text, ">Hold room<"), column: 9, page: "booking" },
      { file, line: lineOf(text, ">Book room<"), column: 9, page: "booking" },
    ]);
    // The finding's own place is still the extra one, as before.
    expect(finding).toMatchObject({ file, line: lineOf(text, ">Book room<"), column: 9 });
  });

  it("finds an element read from the source on the page that renders it", () => {
    const finding = findingOf(reportOf(tsxCases.get("raw-button")), "no-raw-controls");
    expect(finding.page).toBeUndefined();
    expect(finding.targets).toEqual([{ file: finding.file, line: finding.line, column: finding.column, page: "rooms" }]);
  });

  it("names an element no page renders with no page, so no frame can show it", () => {
    const finding = findingOf(reportOf(tsxCases.get("primary-built-in-a-handler")), "counted-parts-reached");
    expect(finding.targets?.length).toBeGreaterThan(0);
    for (const target of finding.targets ?? []) expect(target.page).toBeUndefined();
  });

  it("stands a local component for the outermost elements it renders", () => {
    // A layout component inside the primary slot: what the slot holds is the layout's own outermost part.
    const finding = findingOf(reportOf(tsxCases.get("extra-in-primary-slot")), "primary-slot");
    expect(finding.targets?.length).toBeGreaterThan(0);
    for (const target of finding.targets ?? []) expect(target.page).toBe("booking");
  });

  it("gives a finding about a whole page, a flow or an import no targets", () => {
    const missing = reportOf(tsxCases.get("state-without-scenario"));
    expect(findingOf(missing, "state-coverage").targets).toBeUndefined();
    const foreign = reportOf(tsxCases.get("foreign-module"));
    expect(findingOf(foreign, "imports-from-library").targets).toBeUndefined();
    const budget = reportOf(tsxCases.get("route-over-budget"));
    expect(findingOf(budget, "step-budget").targets).toBeUndefined();
  });
});

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

  it("gives a finding about a whole page no targets", () => {
    const missing = findingOf(reportOf(specCases.get("unknown-page-type")), "page-types-from-inventory");
    expect(missing.targets).toBeUndefined();
  });

  it("gives every finding the same targets in the same order, whatever order the files come in", () => {
    const item = specCases.get("slot-second-primary") as IllegalCase;
    const reversed = { ...item.prototype, files: Object.fromEntries(Object.entries(item.prototype.files).reverse()) };
    expect(checkPrototype({ config: nook, prototype: reversed })).toEqual(reportOf(item));
  });
});
