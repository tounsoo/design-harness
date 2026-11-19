import type { View } from "../../config/types";
import { headingProblems, hex, spacingNeighbour, textContrast } from "../../rendered/measure";
import type { RenderedElement, RenderedSnapshot } from "../../rendered/types";
import type { RenderedRule } from "../../rules/types";
import { bound, textOf, type CheckContext } from "../context";
import type { BoxWithNeighbourEvidence, Evidence } from "../evidence";
import { compareStrings, type Finding } from "../report";
import type { Outcome } from "./outcome";

/**
 * Rules over what the page looked like, one snapshot per scenario and view.
 * Without snapshots a rendered rule does not run; with them, a missing
 * scenario or view is a finding, since that page was never measured.
 */
export function evaluateRendered(rule: RenderedRule, ctx: CheckContext): Outcome {
  if (ctx.snapshots === undefined) return { notRun: "no rendered snapshots were given" };
  const findings: Finding[] = [];
  const scenarios = new Map(ctx.prototype.scenarios.map((scenario) => [scenario.id, scenario]));
  const views = new Map(ctx.config.views.map((view) => [view.name, view]));
  const byKey = new Map<string, RenderedSnapshot>();
  for (const snapshot of ctx.snapshots) {
    const key = `${snapshot.scenario}@${snapshot.view}`;
    if (!scenarios.has(snapshot.scenario) || !views.has(snapshot.view)) {
      findings.push({ rule: rule.id, scenario: snapshot.scenario, view: snapshot.view, kind: "unverifiable", message: `A snapshot names scenario "${snapshot.scenario}" at view "${snapshot.view}", which ${scenarios.has(snapshot.scenario) ? "is not a view in the config" : "is not a scenario of the prototype"}.` });
      continue;
    }
    if (byKey.has(key)) findings.push({ rule: rule.id, scenario: snapshot.scenario, view: snapshot.view, kind: "unverifiable", message: `Two snapshots are given for scenario "${snapshot.scenario}" at view "${snapshot.view}".` });
    byKey.set(key, snapshot);
  }
  for (const scenario of [...scenarios.values()].sort((a, b) => compareStrings(a.id, b.id))) {
    for (const view of [...views.values()].sort((a, b) => compareStrings(a.name, b.name))) {
      const base = { rule: rule.id, scenario: scenario.id, state: scenario.state, page: scenario.page, view: view.name };
      const snapshot = byKey.get(`${scenario.id}@${view.name}`);
      if (!snapshot) {
        findings.push({ ...base, kind: "unverifiable", message: `No snapshot of scenario "${scenario.id}" at view "${view.name}", so it was not measured.` });
        continue;
      }
      const at = `At ${view.width} by ${view.height}`;
      for (const item of measure(rule, snapshot, view, ctx)) {
        findings.push({ ...base, ...(item.element !== undefined ? { element: item.element } : {}), ...(item.evidence ? { evidence: item.evidence } : {}), kind: item.kind ?? "violation", message: `${at}: ${item.message}` });
      }
    }
  }
  return { findings };
}

/** One thing a rendered rule found: its message, the index in the snapshot's elements of the element it is about, when it is about one, and the numbers behind it. */
type Measured = { readonly message: string; readonly element?: number; readonly kind?: "unverifiable"; readonly evidence?: Evidence };

/**
 * One control against the target size: `meets` the minimum, an `inline`
 * link (exempt), undersized but `spaced` (the WCAG 2.5.8 exception holds),
 * or `fails`, with the first control its circle meets. The target-size rule
 * reports exactly the ones that fail, and a picture of every control is
 * drawn from the same list (`facts.ts`).
 */
export type TargetVerdict = {
  /** The control's index in the snapshot's `elements`. */
  readonly element: number;
  readonly status: "meets" | "inline" | "spaced" | "fails";
  readonly neighbour?: NonNullable<BoxWithNeighbourEvidence["neighbour"]>;
};

export function targetVerdicts(snapshot: RenderedSnapshot, min: number): TargetVerdict[] {
  const targets = snapshot.elements.map((element, index) => ({ element, index })).filter(({ element }) => element.visible && element.interactive);
  const boxes = targets.map(({ element }) => element);
  return targets.map(({ element, index }): TargetVerdict => {
    if (element.inline) return { element: index, status: "inline" };
    if (!(element.rect.width < min || element.rect.height < min)) return { element: index, status: "meets" };
    const met = spacingNeighbour(element, boxes, min);
    const other = met ? targets[met.index] : undefined;
    if (!met || !other) return { element: index, status: "spaced" };
    return { element: index, status: "fails", neighbour: { element: other.index, name: other.element.name, role: other.element.role, box: other.element.rect, meets: met.meets } };
  });
}

/** True when the element ends below the first view. */
export function belowFirstView(element: RenderedElement, view: { readonly height: number }): boolean {
  return element.rect.y + element.rect.height > view.height;
}

/** The width the page lays out in (the view's, less a scrollbar beside it), and how far the page runs past it: 0 when it does not scroll sideways. */
export function sidewaysOverflow(snapshot: RenderedSnapshot, view: { readonly width: number }): { readonly width: number; readonly overflow: number } {
  // A vertical scrollbar beside the page narrows what it lays out in.
  const width = Math.min(view.width, snapshot.viewportWidth ?? view.width);
  return { width, overflow: snapshot.scrollWidth > width + 0.5 ? snapshot.scrollWidth - width : 0 };
}

function measure(rule: RenderedRule, snapshot: RenderedSnapshot, view: View, ctx: CheckContext): Measured[] {
  const indexed = snapshot.elements.map((element, index) => ({ element, index }));
  const shown = indexed.filter(({ element }) => element.visible);
  const label = (name: string, role: string) => (name ? `${role} "${name}"` : `a ${role}`);
  const pageHeight = snapshot.scrollHeight === undefined ? {} : { pageHeight: snapshot.scrollHeight };
  const size = { width: view.width, height: view.height };
  switch (rule.check) {
    case "target-size": {
      const min = bound(rule.minPx, ctx);
      return targetVerdicts(snapshot, min)
        .filter((verdict) => verdict.status === "fails")
        .map((verdict) => {
          const element = snapshot.elements[verdict.element] as RenderedElement;
          return {
            element: verdict.element,
            evidence: { kind: "box-with-neighbour", box: element.rect, min, ...(verdict.neighbour ? { neighbour: verdict.neighbour } : {}) },
            message: `${label(element.name, element.role)} is ${Math.round(element.rect.width)}×${Math.round(element.rect.height)} CSS px, under ${min}, and fails the spacing exception.`,
          };
        });
    }
    case "headings": {
      const headings = indexed.filter(({ element }) => element.headingLevel !== undefined);
      const items = headings.map(({ element }) => ({ text: element.name, level: element.headingLevel ?? 2, shown: element.visible }));
      return headingProblems(items).map((problem) => {
        const element = problem.index === undefined ? undefined : headings[problem.index]?.index;
        const evidence: Evidence = {
          kind: "sequence-gap",
          items: items.map(({ level, text, shown: visible }) => ({ level, text, shown: visible })),
          problem: problem.problem,
          ...(problem.index !== undefined ? { at: problem.index } : {}),
          ...(problem.after !== undefined ? { after: problem.after } : {}),
          ...(problem.missing !== undefined ? { missing: problem.missing } : {}),
        };
        return element === undefined ? { message: problem.message, evidence } : { message: problem.message, element, evidence };
      });
    }
    case "contrast":
      return shown.flatMap(({ element, index }): Measured[] => {
        // WCAG 1.4.3 exempts text in a control that is turned off.
        if (!element.text || element.name.trim() === "" || element.disabled) return [];
        if (element.text.overImage) return [{ element: index, kind: "unverifiable", message: `"${element.name}" is painted over a background image or gradient, so its contrast cannot be measured. Put the text on a background colour.` }];
        const { ratio, needs, foreground, background } = textContrast(element.text, snapshot.canvas);
        if (!(ratio + 1e-9 < needs)) return [];
        return [
          {
            element: index,
            evidence: { kind: "colour-pair", text: element.name, foreground: hex(foreground), background: hex(background), ratio: Math.round(ratio * 100) / 100, needs, px: element.text.px, weight: element.text.weight, scheme: view.scheme },
            message: `"${element.name}" is ${hex(foreground)} on ${hex(background)}, a contrast of ${ratio.toFixed(2)}:1, under ${needs}:1.`,
          },
        ];
      });
    case "accessible-names":
      return shown
        .filter(({ element }) => element.interactive && element.name.trim() === "")
        .map(({ element, index }) => ({ element: index, message: `a ${element.role} (<${element.tag}>) at ${Math.round(element.rect.x)}, ${Math.round(element.rect.y)} has no accessible name.` }));
    case "first-view": {
      const action = textOf(rule.action, ctx, undefined);
      return shown
        .filter(({ element }) => element.interactive && element.name === action && belowFirstView(element, view))
        .map(({ element, index }) => ({
          element: index,
          evidence: { kind: "region-line", axis: "y", line: view.height, from: element.rect.y, to: element.rect.y + element.rect.height, box: element.rect, view: size, ...pageHeight },
          message: `"${action}" is at ${Math.round(element.rect.y)} to ${Math.round(element.rect.y + element.rect.height)} CSS px, below the first view of ${view.height}.`,
        }));
    }
    case "no-sideways-scroll": {
      const { width, overflow } = sidewaysOverflow(snapshot, view);
      const narrowed = width < view.width ? ` (${view.width} less a ${Math.round(view.width - width)} CSS px scrollbar)` : "";
      return overflow > 0
        ? [{ evidence: { kind: "region-line", axis: "x", line: width, from: width, to: snapshot.scrollWidth, view: size, ...pageHeight }, message: `the page is ${Math.round(snapshot.scrollWidth)} CSS px wide in a ${Math.round(width)} CSS px view${narrowed}, so it scrolls sideways.` }]
        : [];
    }
  }
}
