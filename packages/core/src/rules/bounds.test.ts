import { describe, expect, it } from "vitest";
import { nook } from "../../examples/nook/project";
import { BUILT_IN_RULES } from "../builtins";
import { boundWords, compareRules, ruleBounds, withRuleBound } from "./bounds";
import type { RuleSpec } from "./types";

const builtIn = (id: string): RuleSpec => {
  const rule = BUILT_IN_RULES.find((item) => item.id === id);
  if (!rule) throw new Error(`no built-in rule "${id}"`);
  return rule;
};

const onePrimary = builtIn("one-primary-per-page");

describe("a rule's numeric limits", () => {
  it("lists the limits each rule type has room for, set or not, and which way is stricter", () => {
    expect(ruleBounds(onePrimary)).toEqual([
      { key: "min", stricter: "higher" },
      { key: "max", value: 1, stricter: "lower" },
    ]);
    expect(ruleBounds(builtIn("primary-slot"))).toEqual([
      { key: "min", value: 1, stricter: "higher" },
      { key: "max", value: 1, stricter: "lower" },
    ]);
    expect(ruleBounds(builtIn("disclosure-depth"))).toEqual([{ key: "depth", value: { cap: "MAX_DISCLOSURE_DEPTH" }, stricter: "lower" }]);
    expect(ruleBounds(builtIn("target-size"))).toEqual([{ key: "minPx", value: { cap: "TARGET_MIN_PX" }, stricter: "higher" }]);
  });

  it("gives none to a rule with no number: a slot rule that counts nothing, a containment that is not a depth, every named check", () => {
    for (const id of ["body-from-layouts", "primary-outside-disclosure", "page-structure", "rank-2-secondary", "state-coverage", "text-contrast", "components-from-inventory"]) {
      expect(ruleBounds(builtIn(id)), id).toEqual([]);
    }
  });

  it("sets one limit and nothing else, keeping the rule's keys where they were", () => {
    const two = withRuleBound(onePrimary, "max", 2);
    expect(two).toEqual({ ...onePrimary, max: 2 });
    expect(Object.keys(two ?? {})).toEqual(Object.keys(onePrimary));
    expect(withRuleBound(onePrimary, "min", 1)).toEqual({ ...onePrimary, min: 1 });
    const { max: _max, ...open } = builtIn("primary-slot") as RuleSpec & { max: number };
    expect(withRuleBound(builtIn("primary-slot"), "max", undefined)).toEqual(open);
  });

  it("refuses a limit the rule has no room for, and dropping one the vocabulary requires", () => {
    expect(withRuleBound(onePrimary, "depth", 2)).toBeNull();
    expect(withRuleBound(builtIn("page-structure"), "max", 2)).toBeNull();
    expect(withRuleBound(builtIn("disclosure-depth"), "depth", undefined)).toBeNull();
    expect(withRuleBound(builtIn("target-size"), "minPx", undefined)).toBeNull();
  });

  it("says a limit in words, a cap with its value now", () => {
    expect(boundWords("max", 2, nook)).toBe("at most 2");
    expect(boundWords("min", 1, nook)).toBe("at least 1");
    expect(boundWords("max", undefined, nook)).toBe("no upper limit");
    expect(boundWords("min", undefined, nook)).toBe("no lower limit");
    expect(boundWords("depth", { cap: "MAX_DISCLOSURE_DEPTH" }, nook)).toBe("at most 1 deep (MAX_DISCLOSURE_DEPTH)");
    expect(boundWords("minPx", { cap: "TARGET_MIN_PX" }, nook)).toBe("at least 24 px (TARGET_MIN_PX)");
  });
});

describe("comparing two versions of a rule", () => {
  it("is the same when only the description or the order of keys differs", () => {
    expect(compareRules(onePrimary, { ...onePrimary, description: "Other words." })).toEqual({ kind: "same" });
    const { type, id, ...rest } = onePrimary;
    expect(compareRules(onePrimary, { ...rest, id, type } as RuleSpec)).toEqual({ kind: "same" });
  });

  it("lists each limit that moved, with the way it moved: a max is stricter lower, a min higher", () => {
    expect(compareRules(onePrimary, { ...onePrimary, max: 2 } as RuleSpec)).toEqual({ kind: "bounds", moves: [{ key: "max", before: 1, after: 2, direction: "looser" }] });
    expect(compareRules({ ...onePrimary, max: 2 } as RuleSpec, onePrimary)).toEqual({ kind: "bounds", moves: [{ key: "max", before: 2, after: 1, direction: "stricter" }] });
    const slot = builtIn("primary-slot");
    expect(compareRules(slot, { ...slot, min: 0, max: 2 } as RuleSpec)).toEqual({
      kind: "bounds",
      moves: [
        { key: "min", before: 1, after: 0, direction: "looser" },
        { key: "max", before: 1, after: 2, direction: "looser" },
      ],
    });
    const shown = builtIn("rank-1-shown");
    expect(compareRules(shown, { ...shown, min: 2 } as RuleSpec)).toEqual({ kind: "bounds", moves: [{ key: "min", before: 1, after: 2, direction: "stricter" }] });
  });

  it("reads a new limit as stricter and a dropped one as looser", () => {
    expect(compareRules(onePrimary, { ...onePrimary, min: 1 } as RuleSpec)).toEqual({ kind: "bounds", moves: [{ key: "min", after: 1, direction: "stricter" }] });
    expect(compareRules({ ...onePrimary, min: 1 } as RuleSpec, onePrimary)).toEqual({ kind: "bounds", moves: [{ key: "min", before: 1, direction: "looser" }] });
  });

  it("cannot say which way a move between a number and a cap goes", () => {
    const depth = builtIn("disclosure-depth");
    expect(compareRules(depth, { ...depth, depth: 1 } as RuleSpec)).toEqual({ kind: "bounds", moves: [{ key: "depth", before: { cap: "MAX_DISCLOSURE_DEPTH" }, after: 1, direction: "unknown" }] });
  });

  it("is another rule when anything but a limit differs: the selector, the scope, the pages, the type", () => {
    expect(compareRules(onePrimary, { ...onePrimary, select: { role: "action" } } as RuleSpec)).toEqual({ kind: "other" });
    expect(compareRules(onePrimary, { ...onePrimary, scope: "pages", max: 2 } as RuleSpec)).toEqual({ kind: "other" });
    expect(compareRules(onePrimary, { ...onePrimary, pages: { kinds: ["action"] } } as RuleSpec)).toEqual({ kind: "other" });
    expect(compareRules(onePrimary, { type: "page-structure", id: onePrimary.id })).toEqual({ kind: "other" });
  });
});
