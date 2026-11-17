import { failsSpacing, headingProblems, hex, textContrast } from "../../rendered/measure";
import type { RenderedSnapshot } from "../../rendered/types";
import type { RenderedRule } from "../../rules/types";
import { bound, textOf, type CheckContext } from "../context";
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
      for (const item of measure(rule, snapshot, { width: view.width, height: view.height }, ctx)) {
        findings.push({ ...base, ...(item.element !== undefined ? { element: item.element } : {}), kind: item.kind ?? "violation", message: `${at}: ${item.message}` });
      }
    }
  }
  return { findings };
}

/** One thing a rendered rule found: its message, and the index in the snapshot's elements of the element it is about, when it is about one. */
type Measured = { readonly message: string; readonly element?: number; readonly kind?: "unverifiable" };

function measure(rule: RenderedRule, snapshot: RenderedSnapshot, view: { width: number; height: number }, ctx: CheckContext): Measured[] {
  const indexed = snapshot.elements.map((element, index) => ({ element, index }));
  const shown = indexed.filter(({ element }) => element.visible);
  const label = (name: string, role: string) => (name ? `${role} "${name}"` : `a ${role}`);
  switch (rule.check) {
    case "target-size": {
      const min = bound(rule.minPx, ctx);
      const targets = shown.filter(({ element }) => element.interactive);
      const boxes = targets.map(({ element }) => element);
      return targets
        .filter(({ element }) => !element.inline && (element.rect.width < min || element.rect.height < min) && failsSpacing(element, boxes, min))
        .map(({ element, index }) => ({ element: index, message: `${label(element.name, element.role)} is ${Math.round(element.rect.width)}×${Math.round(element.rect.height)} CSS px, under ${min}, and fails the spacing exception.` }));
    }
    case "headings": {
      const headings = indexed.filter(({ element }) => element.headingLevel !== undefined);
      return headingProblems(headings.map(({ element }) => ({ text: element.name, level: element.headingLevel ?? 2, shown: element.visible }))).map((problem) => {
        const element = problem.index === undefined ? undefined : headings[problem.index]?.index;
        return element === undefined ? { message: problem.message } : { message: problem.message, element };
      });
    }
    case "contrast":
      return shown.flatMap(({ element, index }): Measured[] => {
        // WCAG 1.4.3 exempts text in a control that is turned off.
        if (!element.text || element.name.trim() === "" || element.disabled) return [];
        if (element.text.overImage) return [{ element: index, kind: "unverifiable", message: `"${element.name}" is painted over a background image or gradient, so its contrast cannot be measured. Put the text on a background colour.` }];
        const { ratio, needs, foreground, background } = textContrast(element.text, snapshot.canvas);
        return ratio + 1e-9 < needs ? [{ element: index, message: `"${element.name}" is ${hex(foreground)} on ${hex(background)}, a contrast of ${ratio.toFixed(2)}:1, under ${needs}:1.` }] : [];
      });
    case "accessible-names":
      return shown
        .filter(({ element }) => element.interactive && element.name.trim() === "")
        .map(({ element, index }) => ({ element: index, message: `a ${element.role} (<${element.tag}>) at ${Math.round(element.rect.x)}, ${Math.round(element.rect.y)} has no accessible name.` }));
    case "first-view": {
      const action = textOf(rule.action, ctx, undefined);
      return shown
        .filter(({ element }) => element.interactive && element.name === action && element.rect.y + element.rect.height > view.height)
        .map(({ element, index }) => ({ element: index, message: `"${action}" is at ${Math.round(element.rect.y)} to ${Math.round(element.rect.y + element.rect.height)} CSS px, below the first view of ${view.height}.` }));
    }
    case "no-sideways-scroll": {
      // A vertical scrollbar beside the page narrows what it lays out in.
      const width = Math.min(view.width, snapshot.viewportWidth ?? view.width);
      const narrowed = width < view.width ? ` (${view.width} less a ${Math.round(view.width - width)} CSS px scrollbar)` : "";
      return snapshot.scrollWidth > width + 0.5 ? [{ message: `the page is ${Math.round(snapshot.scrollWidth)} CSS px wide in a ${Math.round(width)} CSS px view${narrowed}, so it scrolls sideways.` }] : [];
    }
  }
}
