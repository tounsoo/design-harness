import type { ProjectConfig } from "../config/types";
import type { Bound, CountRule, MembershipSubject, PageFilter, RenderedRule, RuleSpec, SlotName } from "../rules/types";
import { bound, textOf, type ConfigContext } from "./context";
import { article, describe } from "./describe";

/**
 * A rule in plain words, generated from its data, never written per rule:
 * the same selector describer that writes the engine's findings names what
 * a rule selects, so the words a reviewer reads before adoption match the
 * messages the rule gives after it. A cap is named with its value in the
 * config, so `{ "cap": "MAX_DISCLOSURES_PER_PAGE" }` reads "1
 * (MAX_DISCLOSURES_PER_PAGE)". Deterministic: same rule and config, same words.
 */
export function describeRule(rule: RuleSpec, config: ProjectConfig): string {
  const ctx: ConfigContext = { config };
  switch (rule.type) {
    case "membership":
      return membershipWords(rule.of, config);
    case "count":
      return countWords(rule, ctx);
    case "containment": {
      const what = describe(rule.select, ctx);
      const where = pagesWords(rule.pages);
      if (rule.must === "nest-at-most") {
        return `${capitalize(describe(rule.select, ctx, { plural: true }))} nest inside each other at most ${boundWords(rule.depth, ctx)} deep${where}; a lone one is 1 deep.`;
      }
      const container = describe(rule.of, ctx);
      return rule.must === "be-inside" ? `Every ${what} is inside ${article(container)}${where}.` : `No ${what} is inside ${article(container)}${where}.`;
    }
    case "prop-values": {
      const values = rule.allowed.map((value) => JSON.stringify(value)).join(", ");
      const what = describe(rule.select, ctx);
      return rule.required
        ? `Every ${what} sets ${rule.prop}, to one of ${values}.`
        : `Every ${what} that sets ${rule.prop} sets it to one of ${values}.`;
    }
    case "requires":
      return `Every ${describe(rule.select, ctx)} is also ${article(describe(rule.must, ctx))}${pagesWords(rule.pages)}.`;
    case "slot": {
      const subject = `${capitalize(slotWords(rule.slot))} of ${pagesSubject(rule.pages, rule.slot === "$primary")}`;
      const parts: string[] = [];
      if (rule.holds) parts.push(`holds ${rangeWords(rule.min, rule.max, ctx, (count) => describe(rule.holds ?? {}, ctx, { plural: count !== 1 }))} at its top level`);
      if (rule.only) parts.push(`holds nothing at its top level but ${describe(rule.only, ctx, { plural: true })}`);
      if (parts.length === 0) return `${subject} is not limited.`;
      return `${subject} ${parts.join(", and ")}.`;
    }
    case "reachable":
      return `Every ${describe(rule.select, ctx)} written anywhere in the source is rendered from a page, so the per-page rules count it.`;
    case "page-structure":
      return "Every page fills only its page type's slots, each at most once, and puts nothing outside them.";
    case "isolation":
      return "Prototype code reaches only its imports and plain language built-ins: no browser globals, timers, frame plumbing, DOM handles, constructors, or property reads by a computed key.";
    case "flow":
      return rule.check === "state-coverage"
        ? "Every flow state has a scenario, and every scenario shows a modeled state on a page of the prototype."
        : `Every route from a task's start to its success state, not only the shortest, fits the task's max steps (${config.inputs.tasks.map((task) => `${task.id}: ${task.maxSteps}`).join(", ") || "no tasks yet"}).`;
    case "rendered":
      return `Measured in every scenario at every view: ${renderedWords(rule, ctx)}`;
  }
}

function membershipWords(subject: MembershipSubject, config: ProjectConfig): string {
  const { inventories } = config;
  switch (subject) {
    case "components":
      return `Pages render only the library parts in the component inventory (${listWords(inventories.components)}).`;
    case "imports":
      return `Files import only ${config.library.package}, React, the page kit and the prototype's own files, by static imports.`;
    case "page-types":
      return `Every page is of a page type in the inventory (${listWords(inventories.pageTypes.map((type) => type.id))}).`;
    case "layouts":
      return `Every layout the manifest registers is in the layout inventory (${listWords(inventories.layouts)}).`;
    case "flow-states":
      return `The flow uses only flow states in the inventory (${listWords(inventories.flowStates)}).`;
  }
}

function countWords(rule: CountRule, ctx: ConfigContext): string {
  const each = rule.each ? ctx.config.inputs[rule.each] : undefined;
  const sample = each?.[0];
  const what = (count: number) => describe(rule.select, ctx, { plural: count !== 1, ...(sample !== undefined ? { each: "<section>" } : {}) });
  const scope =
    rule.scope === "page" ? capitalize(pagesSubject(rule.pages, false)) : rule.scope === "pages" ? `Across ${pagesSubject(rule.pages, false, true)}, the prototype` : "The prototype's source, rendered or not,";
  const body = `${scope} holds ${rangeWords(rule.min, rule.max, ctx, what)}.`;
  if (!rule.each) return body;
  return `For each disclosed section (${listWords(each ?? [])}), with <section> standing for it: ${lowerFirst(body)}`;
}

/** "at most 1 Toast.Root", "no primary actions", "between 1 and 2 ...", "at least 1 ...". */
function rangeWords(min: Bound | undefined, max: Bound | undefined, ctx: ConfigContext, what: (count: number) => string): string {
  const low = min === undefined ? undefined : bound(min, ctx);
  const high = max === undefined ? undefined : bound(max, ctx);
  if (high === 0 && (low === undefined || low === 0)) return `no ${what(2)}${max !== undefined && typeof max === "object" ? ` (${max.cap} is 0)` : ""}`;
  if (low !== undefined && high !== undefined && min !== undefined && max !== undefined) {
    return low === high ? `exactly ${boundWords(min, ctx)} ${what(low)}` : `between ${boundWords(min, ctx)} and ${boundWords(max, ctx)} ${what(high)}`;
  }
  if (high !== undefined && max !== undefined) return `at most ${boundWords(max, ctx)} ${what(high)}`;
  if (low !== undefined && min !== undefined) return `at least ${boundWords(min, ctx)} ${what(low)}`;
  return `any number of ${what(2)}`;
}

function boundWords(value: Bound, ctx: ConfigContext): string {
  return typeof value === "number" ? String(value) : `${bound(value, ctx)} (${value.cap})`;
}

/** The subject of a per-page sentence: "Each page", "Each collection or content page", `Each "booking" page`. */
function pagesSubject(filter: PageFilter | undefined, actionOnly: boolean, plural = false): string {
  const kinds = filter?.kinds ?? (actionOnly ? ["action" as const] : undefined);
  const types = filter?.types;
  const qualifier = [types ? types.map((type) => `"${type}"`).join(" or ") : null, kinds ? kinds.join(" or ") : null].filter(Boolean).join(" ");
  if (plural) return qualifier ? `all ${qualifier} pages` : "all pages";
  return qualifier ? `each ${qualifier} page` : "each page";
}

/** A suffix limiting a sentence to some pages: " on collection or content pages". */
function pagesWords(filter: PageFilter | undefined): string {
  if (!filter) return "";
  const parts = [filter.types ? filter.types.map((type) => `"${type}"`).join(" or ") : null, filter.kinds ? filter.kinds.join(" or ") : null].filter(Boolean);
  return parts.length === 0 ? "" : ` on ${parts.join(" ")} pages`;
}

function slotWords(slot: SlotName): string {
  if (slot === "$primary") return "the primary slot";
  if (slot === "$body") return "every body slot (neither chrome nor primary)";
  if (slot === "$chrome") return "every chrome slot";
  return `the "${slot}" slot`;
}

function renderedWords(rule: RenderedRule, ctx: ConfigContext): string {
  switch (rule.check) {
    case "target-size":
      return `every visible control is at least ${boundWords(rule.minPx, ctx)} CSS px wide and high, or meets the WCAG 2.5.8 spacing exception.`;
    case "headings":
      return "each page has one h1, first, and no heading skips a level.";
    case "contrast":
      return "text meets WCAG AA contrast against what it is painted on: 4.5:1, or 3:1 for large text.";
    case "accessible-names":
      return "every visible control has an accessible name.";
    case "first-view": {
      const action = textOf(rule.action, ctx, undefined);
      const which = typeof rule.action === "object" && "rank" in rule.action ? `the rank-${rule.action.rank} action "${action}"` : `"${action}"`;
      return `wherever ${which} is shown, it is inside the first view, without scrolling.`;
    }
    case "no-sideways-scroll":
      return "nothing makes the page scroll sideways.";
  }
}

function listWords(items: readonly string[]): string {
  return items.length === 0 ? "none" : items.join(", ");
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}
