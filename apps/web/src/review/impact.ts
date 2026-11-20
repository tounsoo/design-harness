import type { Finding, PrototypeImpact } from "@design-harness/core";

/**
 * What a change does to one prototype, sorted into the three things a
 * designer needs to know: it would need fixing, it would stop failing
 * something it fails today, or nothing changes for it. Read from core's
 * `proposalImpact`, which checks each prototype before and after; nothing
 * here checks anything.
 */
export type PrototypeEffect = {
  readonly name: string;
  /**
   * `needs-fixing`: a rule it passes today would fail, or a rule it fails
   * already would find more. `stops-failing`: a rule it fails today would no
   * longer fail, and nothing new would. `no-change`: neither; a finding that
   * only reads differently, such as "more than 2" for "more than 1", is the
   * same failure.
   */
  readonly state: "needs-fixing" | "stops-failing" | "no-change";
  /** The rules that would newly fail, by id. */
  readonly breaks: readonly string[];
  /** The rules it fails today that would no longer fail: passed, or no longer in force. */
  readonly fixes: readonly string[];
  /** Whether it would still fail a rule afterwards. */
  readonly stillFails: boolean;
  /** The findings it would carry afterwards and does not today. */
  readonly added: readonly Finding[];
};

export function prototypeEffect(item: PrototypeImpact): PrototypeEffect {
  const breaks = item.rules.filter((rule) => rule.after === "fail" && rule.before !== "fail").map((rule) => rule.rule);
  const fixes = item.rules.filter((rule) => rule.before === "fail" && rule.after !== "fail").map((rule) => rule.rule);
  const state = breaks.length > 0 || item.added.length > item.removed.length ? "needs-fixing" : fixes.length > 0 ? "stops-failing" : "no-change";
  return { name: item.name, state, breaks, fixes, stillFails: item.after === "fail", added: item.added };
}
