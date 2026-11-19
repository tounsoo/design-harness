import type { Rect } from "../rendered/types";
import type { FlowRule, RenderedRule, RuleType } from "../rules/types";

/**
 * Evidence: the numbers behind a finding, so a picture of it can be drawn
 * without anyone working the verdict out a second time. Core fills it in
 * while it decides; an app only draws it. A finding's `message` stays the
 * exact finding and the picture's text alternative: evidence never says
 * more than the message's rule decided, and nothing reads it to pass or fail.
 *
 * There is a small, fixed set of kinds, and the rule *type* decides the
 * kind, never the individual rule: a count rule a proposal adds draws as
 * "2, at most 1" the day it is adopted. `RULE_EVIDENCE` declares each rule
 * type's kind, or says in words why its findings are text only.
 */

/** A measured control, the circle the spacing exception gives it, and the first other control that circle meets. */
export type BoxWithNeighbourEvidence = {
  readonly kind: "box-with-neighbour";
  /** The control's box, in page CSS px. */
  readonly box: Rect;
  /** The least width and height, which is also the circle's diameter. */
  readonly min: number;
  /** The first control, in document order, that breaks the spacing exception. */
  readonly neighbour?: {
    /** Its index in the snapshot's `elements`. */
    readonly element: number;
    readonly name: string;
    readonly role: string;
    readonly box: Rect;
    /** `in-circle`: the control's circle reaches the neighbour's box. `circles-meet`: both are undersized and their circles overlap. */
    readonly meets: "in-circle" | "circles-meet";
  };
};

/** A run of text and what it is painted on, as flattened sRGB hex, with the ratio it reaches and the ratio it needs. */
export type ColourPairEvidence = {
  readonly kind: "colour-pair";
  readonly text: string;
  readonly foreground: string;
  readonly background: string;
  readonly ratio: number;
  readonly needs: number;
  /** The text's size and weight, which decide whether it counts as large text. */
  readonly px: number;
  readonly weight: number;
  /** The view's colour scheme. */
  readonly scheme: "light" | "dark";
};

/** An ordered list with something wrong at one place: the page's heading outline, and the heading out of order. */
export type SequenceGapEvidence = {
  readonly kind: "sequence-gap";
  readonly items: readonly { readonly level: number; readonly text: string; readonly shown: boolean }[];
  /** What is wrong: a level skipped going down, a second first-level item, an item before the first, or no first item at all. */
  readonly problem: "skipped" | "second-first" | "before-first" | "no-first";
  /** The index in `items` of the item the finding is about. Absent when the problem is `no-first`. */
  readonly at?: number;
  /** For `skipped`: the index of the item it follows, and the levels left out between the two. */
  readonly after?: number;
  readonly missing?: readonly number[];
};

/** A number against its limit. */
export type CountVsCapEvidence = {
  readonly kind: "count-vs-cap";
  readonly count: number;
  readonly cap: number;
  /** `max`: the count may not exceed the cap. `min`: it may not fall below it. */
  readonly bound: "max" | "min";
  /** What is counted, in the message's own words, plural: "primary actions". */
  readonly unit: string;
};

/** A line across the page and what lies past it: the end of the first view, or the view's edge. */
export type RegionLineEvidence = {
  readonly kind: "region-line";
  /** `y`: a horizontal line `line` px down the page (the fold). `x`: a vertical line `line` px across (the view's edge). */
  readonly axis: "x" | "y";
  readonly line: number;
  /** What crosses the line or lies past it, along the axis: an element's top and bottom, or the view's edge and the page's width. */
  readonly from: number;
  readonly to: number;
  /** The element's box, when the finding is about one. */
  readonly box?: Rect;
  /** The view's size, and the page's height when the snapshot measured it. */
  readonly view: { readonly width: number; readonly height: number };
  readonly pageHeight?: number;
};

/** A task's longest route, step by step, against its step budget. */
export type RouteVsBudgetEvidence = {
  readonly kind: "route-vs-budget";
  readonly task: string;
  readonly start: string;
  readonly success: string;
  /** The longest route's steps, in order. */
  readonly route: readonly { readonly from: string; readonly event: string; readonly to: string }[];
  readonly steps: number;
  readonly budget: number;
};

/** One flow state and how many scenarios show it, among all the flow's states. */
export type CoverageEvidence = {
  readonly kind: "coverage";
  readonly state: string;
  readonly scenarios: number;
  /** How many of the flow's states have a scenario, and how many states there are. */
  readonly covered: number;
  readonly states: number;
};

export type Evidence = BoxWithNeighbourEvidence | ColourPairEvidence | SequenceGapEvidence | CountVsCapEvidence | RegionLineEvidence | RouteVsBudgetEvidence | CoverageEvidence;
export type EvidenceKind = Evidence["kind"];

/** Every evidence kind, in a fixed order. An app registers one figure per kind. */
export const EVIDENCE_KINDS = ["box-with-neighbour", "colour-pair", "sequence-gap", "count-vs-cap", "region-line", "route-vs-budget", "coverage"] as const satisfies readonly EvidenceKind[];

/** What a rule type's findings carry: an evidence kind, or nothing, with the reason in words. */
export type EvidenceDeclaration = { readonly kind: EvidenceKind } | { readonly textOnly: string };

type Declared = {
  readonly [T in Exclude<RuleType, "rendered" | "flow">]: EvidenceDeclaration;
} & {
  /** The flow and rendered types are families of named checks: each check declares its own. */
  readonly flow: { readonly [C in FlowRule["check"]]: EvidenceDeclaration };
  readonly rendered: { readonly [C in RenderedRule["check"]]: EvidenceDeclaration };
};

/**
 * The evidence kind of every rule type in the vocabulary. Adding a rule
 * type, or a check to the flow or rendered family, fails to compile until
 * it is declared here, and `test/evidence.test.ts` fails a declared kind
 * that no finding of that type ever carries.
 */
export const RULE_EVIDENCE: Declared = {
  count: { kind: "count-vs-cap" },
  slot: { kind: "count-vs-cap" },
  containment: { kind: "count-vs-cap" },
  membership: { textOnly: "A membership finding is about a name that is not on a list: an import, a part or a state. Its place is a line of code." },
  "prop-values": { textOnly: "A prop's value is a word in the source; the allowed values are words too." },
  requires: { textOnly: "It says one element lacks a role: there is no quantity to draw, and the element itself is outlined." },
  reachable: { textOnly: "It is about code no page renders, so there is nothing on a page to draw." },
  "page-structure": { textOnly: "It is about which slot an element is written in; the element is outlined where it renders." },
  isolation: { textOnly: "It is about a name the code reaches for; its place is a line of code." },
  flow: {
    "state-coverage": { kind: "coverage" },
    "step-budget": { kind: "route-vs-budget" },
  },
  rendered: {
    "target-size": { kind: "box-with-neighbour" },
    contrast: { kind: "colour-pair" },
    headings: { kind: "sequence-gap" },
    "first-view": { kind: "region-line" },
    "no-sideways-scroll": { kind: "region-line" },
    "accessible-names": { textOnly: "A missing name is words that are not there; the control is outlined on the page." },
  },
};

/** The evidence declaration of one rule, by its type and, in the flow and rendered families, its check. */
export function evidenceFor(rule: { readonly type: RuleType; readonly check?: string }): EvidenceDeclaration {
  const declared = RULE_EVIDENCE[rule.type] as EvidenceDeclaration | Readonly<Record<string, EvidenceDeclaration>>;
  if ("kind" in declared || "textOnly" in declared) return declared as EvidenceDeclaration;
  return (declared as Readonly<Record<string, EvidenceDeclaration>>)[rule.check ?? ""] ?? { textOnly: "This check is not declared." };
}
