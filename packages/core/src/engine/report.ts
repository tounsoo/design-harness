import type { RuleType } from "../rules/types";

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
    compareStrings(a.kind, b.kind) ||
    compareStrings(a.message, b.message)
  );
}

/** Sorted, with exact duplicates dropped: the same JSX reached twice on one page reports once. */
export function sortFindings(findings: readonly Finding[]): Finding[] {
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const finding of [...findings].sort(compareFindings)) {
    const key = JSON.stringify([finding.rule, finding.kind, finding.message, finding.file, finding.line, finding.column, finding.page, finding.scenario, finding.view, finding.element]);
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
