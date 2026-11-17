import type { ContainmentRule, PropValuesRule, RequiresRule } from "../../rules/types";
import { bound, boundLabel, descendants, locate, named, pagesFor, where, type CheckContext } from "../context";
import { article, describe } from "../describe";
import type { Finding } from "../report";
import { insideOf, matches, nearestMatching, propState } from "../select";
import type { Outcome } from "./outcome";

/** Elements matching `select` must, or must not, sit inside an element matching `of`; or nest inside each other at most `depth` deep. */
export function evaluateContainment(rule: ContainmentRule, ctx: CheckContext): Outcome {
  const findings: Finding[] = [];
  const env = { ctx };
  const what = describe(rule.select, ctx);
  for (const { page } of pagesFor(rule.pages, ctx)) {
    for (const { node, ancestors } of descendants(page.root)) {
      const selected = matches(node, ancestors, rule.select, env);
      if (selected.v === false) continue;
      const base = { rule: rule.id, page: page.id, ...locate(node.at) };
      const subject = `${named(node)} at ${where(node.at)}`;
      if (rule.must === "nest-at-most") {
        const max = bound(rule.depth, ctx);
        let depth = 1;
        let possible = 1;
        ancestors.forEach((ancestor, index) => {
          const result = matches(ancestor, ancestors.slice(0, index), rule.select, env);
          if (result.v === true) depth += 1;
          if (result.v !== false) possible += 1;
        });
        if (selected.v === true && depth > max) {
          findings.push({ ...base, kind: "violation", message: `${subject} nests ${what}s ${depth} deep, more than ${boundLabel(rule.depth, ctx)}.` });
        } else if (possible > max) {
          findings.push({ ...base, kind: "unverifiable", message: `${subject} may nest ${what}s ${possible} deep, more than ${boundLabel(rule.depth, ctx)}, but ${selected.why ?? "an element above it cannot be read statically"}.` });
        }
        continue;
      }
      const container = describe(rule.of, ctx);
      const inside = insideOf(ancestors, rule.of, env);
      const wantInside = rule.must === "be-inside";
      if (selected.v === true && inside.v === !wantInside) {
        const holder = wantInside ? null : nearestMatching(ancestors, rule.of, env);
        findings.push({
          ...base,
          kind: "violation",
          message: wantInside ? `${subject} is ${article(what)} outside every ${container}.` : `${subject} is ${article(what)} inside a ${container}${holder ? `, ${named(holder)} at ${where(holder.at)}` : ""}.`,
        });
      } else if (inside.v !== wantInside && !(selected.v === null && inside.v === wantInside)) {
        const why = selected.v === null ? selected.why : inside.why;
        findings.push({ ...base, kind: "unverifiable", message: `Cannot tell whether ${subject} is ${article(what)} ${wantInside ? "inside" : "outside"} a ${container}: ${why ?? "it cannot be read statically"}.` });
      }
    }
  }
  return { findings };
}

/** Every element matching `select` also matches `must`. */
export function evaluateRequires(rule: RequiresRule, ctx: CheckContext): Outcome {
  const findings: Finding[] = [];
  const env = { ctx };
  const what = describe(rule.select, ctx);
  const must = describe(rule.must, ctx);
  for (const { page } of pagesFor(rule.pages, ctx)) {
    for (const { node, ancestors } of descendants(page.root)) {
      const selected = matches(node, ancestors, rule.select, env);
      if (selected.v === false) continue;
      const satisfied = matches(node, ancestors, rule.must, env);
      if (satisfied.v === true) continue;
      const base = { rule: rule.id, page: page.id, ...locate(node.at) };
      if (selected.v === true && satisfied.v === false) {
        findings.push({ ...base, kind: "violation", message: `${named(node)} at ${where(node.at)} is ${article(what)}, so it must be ${article(must)}, and it is not.` });
      } else {
        const why = satisfied.v === null ? satisfied.why : selected.why;
        findings.push({ ...base, kind: "unverifiable", message: `Cannot tell whether ${named(node)} at ${where(node.at)}, possibly ${article(what)}, is ${article(must)}: ${why ?? "it cannot be read statically"}.` });
      }
    }
  }
  return { findings };
}

/** A prop of every matching element takes only the listed literal values. */
export function evaluatePropValues(rule: PropValuesRule, ctx: CheckContext): Outcome {
  const findings: Finding[] = [];
  const env = { ctx };
  const allowed = rule.allowed.map((value) => JSON.stringify(value)).join(", ");
  for (const { page } of pagesFor(undefined, ctx)) {
    for (const { node, ancestors } of descendants(page.root)) {
      const selected = matches(node, ancestors, rule.select, env);
      if (selected.v === false) continue;
      const base = { rule: rule.id, page: page.id, ...locate(node.at) };
      const subject = `${named(node)} at ${where(node.at)}`;
      const state = propState(node, rule.prop);
      if (state.kind === "missing") {
        if (rule.required && selected.v === true) findings.push({ ...base, kind: "violation", message: `${subject} has no ${rule.prop}; it must be one of ${allowed}.` });
        continue;
      }
      if (state.kind === "unknown") {
        findings.push({ ...base, kind: "unverifiable", message: `Cannot tell whether ${subject} sets ${rule.prop} to one of ${allowed}: ${state.why}.` });
        continue;
      }
      const bad = state.values.filter((value) => !rule.allowed.includes(value));
      if (bad.length === 0) continue;
      const list = bad.map((value) => JSON.stringify(value)).join(" or ");
      if (selected.v === true) findings.push({ ...base, kind: "violation", message: `${subject} sets ${rule.prop} to ${list}; it must be one of ${allowed}.` });
      else findings.push({ ...base, kind: "unverifiable", message: `${subject} sets ${rule.prop} to ${list}, and whether the rule covers it cannot be told: ${selected.why ?? "it cannot be read statically"}.` });
    }
  }
  return { findings };
}
