import type { CheckReport, Finding } from "../engine/report";
import type { Prototype } from "../prototype/types";

/**
 * What a pick on one page has to answer for. A pick changes one page, so
 * whether it can be applied depends on that page, not on the whole
 * prototype: a failure that was already on another page is not the pick's.
 *
 * Given core's report of the prototype as it is (`before`) and of the
 * prototype with the page replaced (`after`), every finding of `after` is
 * one of three things:
 *
 * - `page`: about the picked page. It names the page, one of the page's
 *   scenarios, the page's file, or a layout the page's file draws. Static
 *   or rendered, in any scenario and view. Each one blocks, whether or not
 *   the page already had it: the page the person applies must be clean.
 * - `introduced`: not about the page, and not in `before` word for word.
 *   The replacement brought it or changed it, as a flow, step-budget or
 *   whole-prototype count finding that reads differently now. Each one
 *   blocks.
 * - `existing`: not about the page, and in `before` exactly as it is in
 *   `after`. It was there without the pick and stays without it. It never
 *   blocks.
 *
 * A rule that ran in `before` and did not run in `after` (`stopped`) blocks
 * too: nothing can be said about what the pick does to it.
 *
 * Pure and deterministic: the lists keep the order of `after.findings`,
 * which core sorts.
 */
export type PickScope = {
  readonly page: readonly Finding[];
  readonly introduced: readonly Finding[];
  readonly existing: readonly Finding[];
  /** Rules `after` did not run that `before` did, by id, in `after`'s order. */
  readonly stopped: readonly string[];
  /** Whether nothing blocks: no finding of the page, none introduced, and no rule stopped. */
  readonly clear: boolean;
};

/** A finding as one string, its keys in a fixed order, so the same finding compares equal whatever order its keys came in. */
function identity(finding: Finding): string {
  return JSON.stringify([
    finding.rule,
    finding.kind,
    finding.message,
    finding.file ?? null,
    finding.line ?? null,
    finding.column ?? null,
    finding.page ?? null,
    finding.scenario ?? null,
    finding.state ?? null,
    finding.view ?? null,
    finding.element ?? null,
    (finding.via ?? []).map((use) => [use.layout, use.file, use.line, use.column, use.slot ?? null]),
  ]);
}

/**
 * Whether a finding is about a page of the prototype: it names the page,
 * one of its scenarios, its file, or a layout its file draws.
 */
export function findingIsOfPage(finding: Finding, prototype: Prototype, page: string): boolean {
  if (finding.page !== undefined) return finding.page === page;
  if (finding.scenario !== undefined) return prototype.scenarios.some((scenario) => scenario.id === finding.scenario && scenario.page === page);
  const file = prototype.pages.find((item) => item.id === page)?.component.file;
  if (file === undefined) return false;
  return finding.file === file || (finding.via ?? []).some((use) => use.file === file);
}

/**
 * Sorts the findings of `after` for a pick on `page`. `prototype` is the
 * one `after` reports on; its manifest says which scenarios and which file
 * are the page's.
 */
export function pickScope(before: CheckReport, after: CheckReport, prototype: Prototype, page: string): PickScope {
  // A multiset: two findings that read the same are two findings, and one more of them is introduced.
  const had = new Map<string, number>();
  for (const finding of before.findings) had.set(identity(finding), (had.get(identity(finding)) ?? 0) + 1);
  const ofPage: Finding[] = [];
  const introduced: Finding[] = [];
  const existing: Finding[] = [];
  for (const finding of after.findings) {
    if (findingIsOfPage(finding, prototype, page)) {
      ofPage.push(finding);
      continue;
    }
    const key = identity(finding);
    const left = had.get(key) ?? 0;
    if (left > 0) {
      had.set(key, left - 1);
      existing.push(finding);
    } else introduced.push(finding);
  }
  const ran = new Set(before.rules.filter((rule) => rule.status !== "not-run").map((rule) => rule.rule));
  const stopped = after.rules.filter((rule) => rule.status === "not-run" && ran.has(rule.rule)).map((rule) => rule.rule);
  return { page: ofPage, introduced, existing, stopped, clear: ofPage.length === 0 && introduced.length === 0 && stopped.length === 0 };
}
