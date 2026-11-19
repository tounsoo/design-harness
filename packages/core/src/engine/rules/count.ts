import type { CountRule, Selector } from "../../rules/types";
import { bound, boundLabel, descendants, everyNode, isRepeated, locate, named, pagesFor, pointAt, where, type CheckContext, type Placed } from "../context";
import { article, describe } from "../describe";
import type { Finding } from "../report";
import { matches, type MatchEnv } from "../select";
import type { Outcome } from "./outcome";

/** A counted element, and the page it is on (none when it is read from the source). */
type Counted = Placed & { readonly page?: string };

/** One counted group: a page, all pages, or the source. `subject` starts a sentence and takes "has". */
type Group = { readonly label: string; readonly subject: string; readonly page?: string; readonly nodes: readonly Counted[] };

/**
 * Counts the elements matching a selector against min and max. An element in
 * a list of unknown length counts as any number; an element the selector
 * cannot decide is reported when it could change the answer.
 */
export function evaluateCount(rule: CountRule, ctx: CheckContext): Outcome {
  const groups: Group[] =
    rule.scope === "page"
      ? pagesFor(rule.pages, ctx).map(({ page }) => ({ label: `page "${page.id}"`, subject: `Page "${page.id}"`, page: page.id, nodes: descendants(page.root).map((placed) => ({ ...placed, page: page.id })) }))
      : rule.scope === "pages"
        ? [{ label: "the prototype's pages", subject: "Across its pages, the prototype", nodes: pagesFor(rule.pages, ctx).flatMap(({ page }) => descendants(page.root).map((placed) => ({ ...placed, page: page.id }))) }]
        : [{ label: "the prototype's source", subject: "The prototype's source", nodes: everyNode(ctx.model.source) }];
  const lists = rule.each ? ctx.config.inputs[rule.each] : [undefined];
  const findings: Finding[] = [];
  for (const each of lists) {
    for (const group of groups) findings.push(...countGroup(rule, ctx, group, each));
  }
  return { findings };
}

function countGroup(rule: CountRule, ctx: CheckContext, group: Group, each: string | undefined): Finding[] {
  const env: MatchEnv = each === undefined ? { ctx } : { ctx, each };
  const definite: Counted[] = [];
  const maybe: { placed: Counted; why: string }[] = [];
  for (const placed of group.nodes) {
    const result = matches(placed.node, placed.ancestors, rule.select, env);
    if (result.v === true) definite.push(placed);
    else if (result.v === null) maybe.push({ placed, why: result.why ?? "it cannot be read statically" });
  }
  const what = (count: number) => describe(rule.select, ctx, { plural: count !== 1, ...(each !== undefined ? { each } : {}) });
  const base = { rule: rule.id, ...(group.page ? { page: group.page } : {}) };
  const findings: Finding[] = [];
  const repeated = definite.find(isRepeated);
  // Every element the finding is about, each on its own page, so a frame can outline them all.
  const at = (items: readonly Counted[]) => {
    const targets = items.flatMap((item) => pointAt(ctx, [item.node], item.page).targets ?? []);
    return targets.length > 0 ? { targets } : {};
  };

  if (rule.max !== undefined) {
    const max = bound(rule.max, ctx);
    if (definite.length > max) {
      const extra = definite[max] as Counted;
      findings.push({
        ...base,
        ...locate(extra.node.at),
        ...at(definite),
        evidence: { kind: "count-vs-cap", count: definite.length, cap: max, bound: "max", unit: what(2) },
        kind: "violation",
        message: `${group.subject} has ${definite.length} ${what(definite.length)}, more than ${boundLabel(rule.max, ctx)}: ${definite.map(({ node }) => `${named(node)} at ${where(node.at)}`).join(", ")}.`,
      });
    } else if (repeated) {
      findings.push({
        ...base,
        ...locate(repeated.node.at),
        ...at([repeated]),
        kind: "violation",
        message: `${named(repeated.node)} at ${where(repeated.node.at)} is rendered once per item of a list, so ${group.label} may show more than ${boundLabel(rule.max, ctx)} ${what(2)}.`,
      });
    } else if (definite.length + maybe.length > max) {
      findings.push(...undecided(base, maybe, `${group.label} may have more than ${boundLabel(rule.max, ctx)} ${what(2)}`, ctx, rule.select, env));
    }
  }
  if (rule.min !== undefined) {
    const min = bound(rule.min, ctx);
    if (definite.length < min && !repeated) {
      if (definite.length + maybe.length >= min) {
        findings.push(...undecided(base, maybe, `${group.label} may have fewer than ${boundLabel(rule.min, ctx)} ${what(bound(rule.min, ctx))}`, ctx, rule.select, env));
      } else {
        findings.push({ ...base, evidence: { kind: "count-vs-cap", count: definite.length, cap: min, bound: "min", unit: what(2) }, kind: "violation", message: `${group.subject} has ${definite.length} ${what(definite.length)}, fewer than ${boundLabel(rule.min, ctx)}.` });
      }
    }
  }
  return findings;
}

function undecided(base: Pick<Finding, "rule" | "page">, maybe: readonly { placed: Counted; why: string }[], consequence: string, ctx: CheckContext, select: Selector, env: MatchEnv): Finding[] {
  const one = describe(select, ctx, env.each !== undefined ? { each: env.each } : {});
  return maybe.map(({ placed, why }) => ({
    ...base,
    ...locate(placed.node.at),
    ...pointAt(ctx, [placed.node], placed.page),
    kind: "unverifiable",
    message: `Cannot tell whether ${named(placed.node)} at ${where(placed.node.at)} is ${article(one)}: ${why}. Until it can, ${consequence}.`,
  }));
}
