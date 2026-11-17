import type { RuleSpec } from "./rules/types";

/**
 * The built-in rules, equivalent in intent to agent-design-loop's checks and
 * written in the rule vocabulary wherever it reaches. A project lists the
 * rules it puts in force; this is a starting set to copy. The caps they name
 * (MAX_DISCLOSURES_PER_PAGE, MAX_DISCLOSURE_DEPTH, MAX_VISIBLE_QUESTIONS,
 * TARGET_MIN_PX) must be in the project's inputs.
 *
 * Every rule here is data. The ones whose type is a named check rather than a
 * selector rule are `page-structure`, `isolation`, the two `flow` checks, the six
 * `rendered` checks and the five membership subjects: each reads something a
 * selector cannot (the page kit's slots, the flow graph, a rendered snapshot,
 * the manifest and the import list, what the source reaches).
 */
export const BUILT_IN_RULES: readonly RuleSpec[] = [
  // lint:product-ui and check:inventories
  { type: "membership", id: "components-from-inventory", of: "components", description: "Render only the library parts the inventory lists." },
  { type: "membership", id: "imports-from-library", of: "imports", description: "Import only the project's library, React, the page kit and the prototype's own files, by static imports." },
  { type: "membership", id: "page-types-from-inventory", of: "page-types", description: "Every page is of an inventoried page type." },
  { type: "membership", id: "layouts-from-inventory", of: "layouts", description: "Every registered layout is inventoried." },
  { type: "membership", id: "flow-states-from-inventory", of: "flow-states", description: "The flow uses only inventoried states." },
  { type: "count", id: "no-raw-controls", scope: "source", select: { component: ["button", "input", "select", "textarea", "a"] }, max: 0, description: "Controls come from the library, never raw HTML." },
  { type: "count", id: "no-inline-styles", scope: "source", select: { hasProp: "style" }, max: 0, description: "A style prop is a raw escape hatch; layout comes from library parts." },
  // lint:slots and the page shells
  { type: "page-structure", id: "page-structure", description: "Pages fill only their page type's slots, each once, with nothing outside them." },
  { type: "slot", id: "primary-slot", slot: "$primary", holds: { role: "primary-action" }, min: 1, max: 1, only: { role: "primary-action" }, description: "An action page's primary slot holds exactly one primary action and nothing else." },
  { type: "slot", id: "body-from-layouts", slot: "$body", only: { layout: true }, description: "A page's body is built from registered layouts." },
  // check:priority
  { type: "count", id: "one-primary-per-page", scope: "page", select: { role: "primary-action" }, max: 1, description: "A page holds at most one primary action." },
  { type: "count", id: "primary-is-rank-1", scope: "page", select: { role: "primary-action", not: { text: { rank: 1 } } }, max: 0, description: "The only primary action is the rank-1 action." },
  { type: "count", id: "rank-1-shown", scope: "pages", select: { role: "primary-action", text: { rank: 1 } }, min: 1, description: "Some page holds the rank-1 action as its primary action." },
  { type: "requires", id: "rank-2-secondary", select: { role: "action", text: { rank: 2 } }, must: { role: "secondary-action" }, description: "The rank-2 action is secondary wherever it appears." },
  { type: "containment", id: "primary-outside-disclosure", select: { role: "primary-action" }, must: "not-be-inside", of: { role: "disclosure" }, description: "A primary action is never hidden behind a disclosure." },
  { type: "count", id: "disclosed-sections", scope: "pages", each: "disclosedSections", select: { role: "disclosure-summary", text: { each: true }, inside: { role: "disclosure" } }, min: 1, description: "Each section the inputs name sits behind a disclosure." },
  // check:disclosure
  { type: "count", id: "disclosures-per-page", scope: "page", select: { role: "disclosure" }, max: { cap: "MAX_DISCLOSURES_PER_PAGE" }, description: "A page holds at most MAX_DISCLOSURES_PER_PAGE disclosures." },
  { type: "containment", id: "disclosure-depth", select: { role: "disclosure" }, must: "nest-at-most", depth: { cap: "MAX_DISCLOSURE_DEPTH" }, description: "Disclosures nest at most MAX_DISCLOSURE_DEPTH deep." },
  // check:one-thing
  { type: "count", id: "no-page-inside-a-page", scope: "page", select: { page: true }, max: 0, description: "One page does one job: it never renders another page." },
  { type: "count", id: "no-primary-on-collection-or-content", scope: "page", pages: { kinds: ["collection", "content"] }, select: { role: "primary-action" }, max: 0, description: "A collection or content page holds no primary action." },
  { type: "count", id: "visible-questions", scope: "page", select: { role: "question", notInside: { role: "disclosure" } }, max: { cap: "MAX_VISIBLE_QUESTIONS" }, description: "A page asks at most MAX_VISIBLE_QUESTIONS questions outside a disclosure." },
  // A prototype runs in the frame that measures it: it reaches only its imports and plain built-ins.
  { type: "isolation", id: "no-ambient-globals", description: "Prototype code reaches only its imports and plain language built-ins: no browser globals, frame plumbing, DOM handles or computed property reads." },
  // The fail-closed net under every per-page count: what no page reaches cannot be counted.
  { type: "reachable", id: "counted-parts-reached", select: { anyOf: [{ role: "action" }, { role: "disclosure" }, { role: "question" }] }, description: "Every action, disclosure and question is rendered from a page, so the per-page rules count it." },
  // check:state-coverage and check:step-budget
  { type: "flow", id: "state-coverage", check: "state-coverage", description: "Every flow state has a scenario." },
  { type: "flow", id: "step-budget", check: "step-budget", description: "Every route that finishes a task fits its max steps." },
  // check:target-size, check:accessible-names and check:rendered-page
  { type: "rendered", id: "target-size", check: "target-size", minPx: { cap: "TARGET_MIN_PX" }, description: "Every control meets TARGET_MIN_PX or the WCAG 2.5.8 spacing exception." },
  { type: "rendered", id: "accessible-names", check: "accessible-names", description: "Every control has an accessible name." },
  { type: "rendered", id: "heading-structure", check: "headings", description: "One h1, first, and no skipped heading level." },
  { type: "rendered", id: "text-contrast", check: "contrast", description: "Text meets WCAG AA contrast." },
  { type: "rendered", id: "rank-1-in-first-view", check: "first-view", action: { rank: 1 }, description: "The rank-1 action is in the first view." },
  { type: "rendered", id: "no-sideways-scroll", check: "no-sideways-scroll", description: "Nothing scrolls sideways." },
];
