import type { LayoutUse } from "../extract/model";
import type { RuleType } from "../rules/types";

/**
 * One element a finding is about, as a frame can find it where it renders:
 * where it is written (`file`, `line`, `column`, and `via` inside a spec
 * layout instance), the page it is on, and on a spec element its key in the
 * expanded page, which carries the layout instance's scope
 * (`details/summary`). A TSX element is found by where it is written.
 * Without `page` the element was read from the source and no page renders it.
 */
export type FindingTarget = {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly via?: readonly LayoutUse[];
  readonly page?: string;
  readonly key?: string;
};

/**
 * A finding. `violation`: the prototype breaks the rule. `unverifiable`: the
 * rule depends on something the extractor cannot read statically, so it
 * cannot say the prototype passes. Both fail the rule.
 *
 * Field names follow agent-design-loop's report (`message`, `file`, `line`,
 * `page`, `scenario`, `state`, `view`); `rule`, `kind` and `column` are new.
 */
export type Finding = {
  readonly rule: string;
  readonly kind: "violation" | "unverifiable";
  readonly message: string;
  readonly file?: string;
  readonly line?: number;
  readonly column?: number;
  readonly page?: string;
  readonly scenario?: string;
  readonly state?: string;
  readonly view?: string;
  /** On a rendered finding about one element: its index in the snapshot's `elements`, so the element can be pointed at on the page. */
  readonly element?: number;
  /**
   * On a finding about an element a spec layout draws: where the layout is
   * used, nearest first (`LayoutUse`). `file`, `line` and `column` are the
   * layout's own element; `via` is the page's use of it, or, for an element
   * a page passed into a layout's slot, where the layout places it.
   */
  readonly via?: readonly LayoutUse[];
  /**
   * On a finding about elements a page renders: every element it is about,
   * so each can be pointed at in every frame that draws it. A finding about
   * several elements, such as two primary actions, lists them all, in the
   * order its message names them. Absent on a finding about a whole page, a
   * flow, an import or a rendered snapshot (which carries `element`).
   */
  readonly targets?: readonly FindingTarget[];
};

/** `not-run`: the rule needs input the check was not given, such as rendered snapshots. */
export type RuleStatus = "pass" | "fail" | "not-run";

/** The pseudo-rule that reports what the extractor could not read. It is always in force. */
export const EXTRACT_RULE = "extract";

export type RuleReport = {
  readonly rule: string;
  readonly type: RuleType | typeof EXTRACT_RULE;
  readonly status: RuleStatus;
  readonly description?: string;
  /** Why a rule did not run. */
  readonly note?: string;
  readonly findings: readonly Finding[];
};

/** `incomplete`: nothing failed, but at least one rule did not run. */
export type CheckStatus = "pass" | "fail" | "incomplete";

export type CheckReport = {
  readonly status: CheckStatus;
  /** One report per rule in force, the extract pseudo-rule first, then by rule id. */
  readonly rules: readonly RuleReport[];
  /** Every finding, sorted. */
  readonly findings: readonly Finding[];
};

/** Plain code-unit order. `localeCompare` would make the order depend on the runtime's locale. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareFindings(a: Finding, b: Finding): number {
  return (
    compareStrings(a.rule, b.rule) ||
    compareStrings(a.file ?? "", b.file ?? "") ||
    (a.line ?? 0) - (b.line ?? 0) ||
    (a.column ?? 0) - (b.column ?? 0) ||
    compareStrings(a.page ?? "", b.page ?? "") ||
    compareStrings(a.scenario ?? "", b.scenario ?? "") ||
    compareStrings(a.view ?? "", b.view ?? "") ||
    (a.element ?? -1) - (b.element ?? -1) ||
    compareStrings(JSON.stringify(a.via ?? []), JSON.stringify(b.via ?? [])) ||
    compareStrings(JSON.stringify(a.targets ?? []), JSON.stringify(b.targets ?? [])) ||
    compareStrings(a.kind, b.kind) ||
    compareStrings(a.message, b.message)
  );
}

/** Sorted, with exact duplicates dropped: the same JSX reached twice on one page reports once. */
export function sortFindings(findings: readonly Finding[]): Finding[] {
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const finding of [...findings].sort(compareFindings)) {
    const key = JSON.stringify([finding.rule, finding.kind, finding.message, finding.file, finding.line, finding.column, finding.page, finding.scenario, finding.view, finding.element, finding.via ?? [], finding.targets ?? []]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(finding);
  }
  return out;
}

export function buildReport(rules: readonly RuleReport[]): CheckReport {
  const ordered = [...rules].sort((a, b) => (a.rule === EXTRACT_RULE ? -1 : b.rule === EXTRACT_RULE ? 1 : compareStrings(a.rule, b.rule)));
  const findings = sortFindings(ordered.flatMap((rule) => rule.findings));
  const status: CheckStatus = ordered.some((rule) => rule.status === "fail") ? "fail" : ordered.some((rule) => rule.status === "not-run") ? "incomplete" : "pass";
  return { status, rules: ordered, findings };
}
