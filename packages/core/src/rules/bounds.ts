import type { ProjectConfig } from "../config/types";
import type { Bound, RuleSpec } from "./types";

/**
 * The numeric limits of the rule vocabulary: a count's or a slot's `min` and
 * `max`, how deep a containment rule lets elements nest, and a target's
 * smallest size. Each is a `Bound`: a number, or a cap from the project's
 * inputs by name. Everything here is a pure function of the rule's data, so
 * what a limit is, which way is stricter and whether two rules differ only
 * by their limits are the same answer wherever they are asked.
 */

export const BOUND_KEYS = ["min", "max", "depth", "minPx"] as const;
export type BoundKey = (typeof BOUND_KEYS)[number];

/** One limit a rule has room for. `value` is absent when the rule does not set it, such as a count with no `min`. */
export type RuleBound = {
  readonly key: BoundKey;
  readonly value?: Bound;
  /** Which way the number moves to check more: a `max` is stricter when lower, a `min` when higher. */
  readonly stricter: "lower" | "higher";
};

const slot = (key: BoundKey, value: Bound | undefined): RuleBound => ({ key, ...(value !== undefined ? { value } : {}), stricter: key === "max" || key === "depth" ? "lower" : "higher" });

/** The limits a rule has room for, in a fixed order, set or not. A rule type with no number has none. */
export function ruleBounds(rule: RuleSpec): readonly RuleBound[] {
  switch (rule.type) {
    case "count":
      return [slot("min", rule.min), slot("max", rule.max)];
    case "slot":
      // A slot rule counts only what `holds` selects; without it there is nothing to bound.
      return rule.holds === undefined ? [] : [slot("min", rule.min), slot("max", rule.max)];
    case "containment":
      return rule.must === "nest-at-most" ? [slot("depth", rule.depth)] : [];
    case "rendered":
      return rule.check === "target-size" ? [slot("minPx", rule.minPx)] : [];
    default:
      return [];
  }
}

/**
 * The rule with one limit set to `value`, or dropped when `value` is
 * undefined, and nothing else changed: the same keys in the same order.
 * `null` when the rule has no such limit, or when dropping it is not a rule
 * the vocabulary has (a nesting depth and a target size are required).
 */
export function withRuleBound(rule: RuleSpec, key: BoundKey, value: Bound | undefined): RuleSpec | null {
  if (!ruleBounds(rule).some((item) => item.key === key)) return null;
  if (value === undefined && (key === "depth" || key === "minPx")) return null;
  const entries = Object.entries(rule).filter(([name]) => name !== key || value !== undefined).map(([name, was]) => (name === key ? [name, value] : [name, was]));
  if (value !== undefined && !(key in rule)) entries.push([key, value]);
  return Object.fromEntries(entries) as RuleSpec;
}

/** A limit as a number: itself, or its cap's value in the config. Undefined for a cap the config does not have. */
export function boundValue(value: Bound, config: ProjectConfig): number | undefined {
  return typeof value === "number" ? value : config.inputs.caps[value.cap]?.value;
}

/** A limit in words, a cap named with its value now: "at most 2", "at least 1", "at most 1 deep (MAX_DISCLOSURE_DEPTH)", "no upper limit". */
export function boundWords(key: BoundKey, value: Bound | undefined, config: ProjectConfig): string {
  if (value === undefined) return key === "min" ? "no lower limit" : "no upper limit";
  const number = boundValue(value, config);
  const cap = typeof value === "object" ? ` (${value.cap})` : "";
  const shown = String(number ?? "an unset cap");
  switch (key) {
    case "min":
      return `at least ${shown}${cap}`;
    case "max":
      return `at most ${shown}${cap}`;
    case "depth":
      return `at most ${shown} deep${cap}`;
    case "minPx":
      return `at least ${shown} px${cap}`;
  }
}

/**
 * How one limit differs between two versions of a rule. `stricter` and
 * `looser` are proven from the numbers alone; `unknown` is a move between a
 * number and a cap, or between two caps, which no number here decides.
 */
export type BoundMove = { readonly key: BoundKey; readonly before?: Bound; readonly after?: Bound; readonly direction: "stricter" | "looser" | "unknown" };

/**
 * `same`: the two rules check the same thing. `bounds`: they differ only by
 * numeric limits, each listed. `other`: something else differs (the type, a
 * selector, the scope, which pages), so nothing says which checks more.
 * A rule's `description` is words for people and is not compared.
 */
export type RuleChange = { readonly kind: "same" } | { readonly kind: "bounds"; readonly moves: readonly BoundMove[] } | { readonly kind: "other" };

/** JSON with every object's keys in order, so two rules compare by what they say. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function moveOf(key: BoundKey, stricter: "lower" | "higher", before: Bound | undefined, after: Bound | undefined): BoundMove {
  const base = { key, ...(before !== undefined ? { before } : {}), ...(after !== undefined ? { after } : {}) };
  // A limit where there was none checks more; one taken away checks less.
  if (before === undefined) return { ...base, direction: "stricter" };
  if (after === undefined) return { ...base, direction: "looser" };
  if (typeof before !== "number" || typeof after !== "number") return { ...base, direction: "unknown" };
  return { ...base, direction: (stricter === "lower") === (after < before) ? "stricter" : "looser" };
}

/** What differs between two versions of a rule, by their data alone. */
export function compareRules(before: RuleSpec, after: RuleSpec): RuleChange {
  const rest = (rule: RuleSpec) => canonical(Object.fromEntries(Object.entries(rule).filter(([name]) => name !== "description" && !(BOUND_KEYS as readonly string[]).includes(name))));
  if (rest(before) !== rest(after)) return { kind: "other" };
  const was = ruleBounds(before);
  const now = ruleBounds(after);
  // The same rule type and shape has the same limits to set; anything else is not a move of a limit.
  if (was.length !== now.length || was.some((item, index) => item.key !== now[index]?.key)) return { kind: "other" };
  const moves = was.flatMap((item, index) => {
    const next = now[index]?.value;
    return canonical(item.value ?? null) === canonical(next ?? null) ? [] : [moveOf(item.key, item.stricter, item.value, next)];
  });
  return moves.length === 0 ? { kind: "same" } : { kind: "bounds", moves };
}
