import { INVALID, arr, either, int, lazy, obj, oneOf, record, scalar, slug, str, tagged, yes, type Check } from "../validate";
import { PAGE_KINDS, ROLE_NAMES, type Bound, type RuleSpec, type Selector, type TextMatch } from "./types";

const isString = (value: unknown) => (typeof value === "string" ? "a" : "b");
const isNumber = (value: unknown) => (typeof value === "number" ? "a" : "b");

const textMatch: Check<TextMatch> = either(isString, str(), (value, path, issues) => {
  if (typeof value === "object" && value !== null && "each" in value) return obj({ each: yes })(value, path, issues);
  return obj({ rank: int({ min: 1 }) })(value, path, issues);
});

export const bound: Check<Bound> = either(isNumber, int({ min: 0 }), obj({ cap: str() }));

const componentNames: Check<string | readonly string[]> = either(isString, str(), arr(str(), { min: 1 }));

const selectorFields = obj(
  {},
  {
    component: componentNames,
    role: oneOf(ROLE_NAMES),
    props: record(scalar),
    hasProp: str(),
    text: textMatch,
    page: yes,
    layout: either((value) => (value === true ? "a" : "b"), yes, slug),
    inside: lazy(() => selector),
    notInside: lazy(() => selector),
    not: lazy(() => selector),
    anyOf: arr(lazy(() => selector), { min: 1 }),
  },
);

export const selector: Check<Selector> = (value, path, issues) => {
  const out = selectorFields(value, path, issues);
  if (out !== INVALID && Object.keys(out).length === 0) {
    issues.push({ path, message: "a selector needs at least one field; an empty one would match every element" });
    return INVALID;
  }
  return out;
};

const pageFilter = obj({}, { kinds: arr(oneOf(PAGE_KINDS), { min: 1 }), types: arr(slug, { min: 1 }) });

const base = { id: slug } as const;
const extra = { description: str() } as const;

const count = obj({ ...base, type: oneOf(["count"]), select: selector, scope: oneOf(["page", "pages", "source"]) }, { ...extra, min: bound, max: bound, pages: pageFilter, each: oneOf(["disclosedSections"]) });

const containment = tagged("must", {
  "be-inside": obj({ ...base, type: oneOf(["containment"]), select: selector, must: oneOf(["be-inside"]), of: selector }, { ...extra, pages: pageFilter }),
  "not-be-inside": obj({ ...base, type: oneOf(["containment"]), select: selector, must: oneOf(["not-be-inside"]), of: selector }, { ...extra, pages: pageFilter }),
  "nest-at-most": obj({ ...base, type: oneOf(["containment"]), select: selector, must: oneOf(["nest-at-most"]), depth: bound }, { ...extra, pages: pageFilter }),
});

const rendered = tagged("check", {
  "target-size": obj({ ...base, type: oneOf(["rendered"]), check: oneOf(["target-size"]), minPx: bound }, extra),
  headings: obj({ ...base, type: oneOf(["rendered"]), check: oneOf(["headings"]) }, extra),
  contrast: obj({ ...base, type: oneOf(["rendered"]), check: oneOf(["contrast"]) }, extra),
  "accessible-names": obj({ ...base, type: oneOf(["rendered"]), check: oneOf(["accessible-names"]) }, extra),
  "first-view": obj({ ...base, type: oneOf(["rendered"]), check: oneOf(["first-view"]), action: textMatch }, extra),
  "no-sideways-scroll": obj({ ...base, type: oneOf(["rendered"]), check: oneOf(["no-sideways-scroll"]) }, extra),
});

const ruleVariants = tagged("type", {
  membership: obj({ ...base, type: oneOf(["membership"]), of: oneOf(["components", "page-types", "layouts", "flow-states"]) }, extra),
  count,
  containment,
  "prop-values": obj({ ...base, type: oneOf(["prop-values"]), select: selector, prop: str(), allowed: arr(scalar, { min: 1 }) }, { ...extra, required: oneOf([true, false]) }),
  requires: obj({ ...base, type: oneOf(["requires"]), select: selector, must: selector }, { ...extra, pages: pageFilter }),
  slot: obj({ ...base, type: oneOf(["slot"]), slot: str() }, { ...extra, pages: pageFilter, holds: selector, min: bound, max: bound, only: selector }),
  reachable: obj({ ...base, type: oneOf(["reachable"]), select: selector }, extra),
  "page-structure": obj({ ...base, type: oneOf(["page-structure"]) }, extra),
  flow: obj({ ...base, type: oneOf(["flow"]), check: oneOf(["state-coverage", "step-budget"]) }, extra),
  rendered,
});

/** A rule spec, with the checks a shape alone can make: a slot rule says what it checks, and a count has a bound. */
export const ruleSpec: Check<RuleSpec> = (value, path, issues) => {
  const rule = ruleVariants(value, path, issues);
  if (rule === INVALID) return INVALID;
  if (rule.type === "slot" && rule.holds === undefined && rule.only === undefined) {
    issues.push({ path, message: `slot rule "${rule.id}" needs "holds" or "only"; with neither it checks nothing` });
    return INVALID;
  }
  if (rule.type === "slot" && rule.holds === undefined && (rule.min !== undefined || rule.max !== undefined)) {
    issues.push({ path, message: `slot rule "${rule.id}" gives min or max without "holds", so there is nothing to count` });
    return INVALID;
  }
  if ((rule.type === "count" || (rule.type === "slot" && rule.holds !== undefined)) && rule.min === undefined && rule.max === undefined) {
    issues.push({ path, message: `${rule.type} rule "${rule.id}" needs "min" or "max"` });
    return INVALID;
  }
  return rule;
};
