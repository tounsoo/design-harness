import type { ProjectConfig, View } from "../config/types";
import type { Prototype, Transition } from "../prototype/types";
import type { Rect, RenderedSnapshot } from "../rendered/types";
import { bound, textOf } from "./context";
import { compareStrings } from "./report";
import { routes, sortTransitions } from "./rules/flow";
import { belowFirstView, sidewaysOverflow, targetVerdicts, type TargetVerdict } from "./rules/rendered";

/**
 * Facts for pictures of a whole page or a whole flow, passing parts
 * included: every control against the target size, where the first view
 * ends and what lies past it, the view's edge, each task's routes against
 * its budget, and which states have scenarios. They are worked out by the
 * same functions the rules call, so a picture drawn from them cannot
 * disagree with the report, and an app never decides a verdict of its own.
 * Nothing here is a check: `checkPrototype` alone says pass or fail.
 */

export type ViewFacts = {
  /** Every visible control against the target size; absent when no target-size rule is in force. */
  readonly targets?: { readonly min: number; readonly controls: readonly TargetVerdict[] };
  /** Where the first view ends, and what was measured past it. */
  readonly fold: {
    readonly line: number;
    /** The page's height, when the snapshot measured it. */
    readonly pageHeight?: number;
    /** The action a first-view rule names, and each visible control with that name; absent when no such rule is in force. */
    readonly action?: { readonly name: string; readonly controls: readonly { readonly element: number; readonly box: Rect; readonly below: boolean }[] };
    /** The indexes of the visible elements that end below the first view, in document order. */
    readonly below: readonly number[];
  };
  /** The view's edge, and how far the page runs past it. */
  readonly edge: {
    readonly line: number;
    readonly scrollWidth: number;
    /** 0 when the page does not scroll sideways. */
    readonly overflow: number;
    /** The indexes of the visible elements that reach past the edge. */
    readonly crossing: readonly number[];
  };
};

/** What the rules in force measure on one snapshot, for one view of the config. */
export function viewFacts(config: ProjectConfig, view: View, snapshot: RenderedSnapshot): ViewFacts {
  const ctx = { config };
  const rules = [...config.rules].sort((a, b) => compareStrings(a.id, b.id));
  const targetRule = rules.find((rule) => rule.type === "rendered" && rule.check === "target-size");
  const firstView = rules.find((rule) => rule.type === "rendered" && rule.check === "first-view");
  const shown = snapshot.elements.map((element, index) => ({ element, index })).filter(({ element }) => element.visible && (element.rect.width > 0 || element.rect.height > 0));
  const min = targetRule?.type === "rendered" && targetRule.check === "target-size" ? bound(targetRule.minPx, ctx) : undefined;
  const name = firstView?.type === "rendered" && firstView.check === "first-view" ? textOf(firstView.action, ctx, undefined) : undefined;
  const { width, overflow } = sidewaysOverflow(snapshot, view);
  return {
    ...(min !== undefined ? { targets: { min, controls: targetVerdicts(snapshot, min) } } : {}),
    fold: {
      line: view.height,
      ...(snapshot.scrollHeight !== undefined ? { pageHeight: snapshot.scrollHeight } : {}),
      ...(name !== undefined
        ? { action: { name, controls: shown.filter(({ element }) => element.interactive && element.name === name).map(({ element, index }) => ({ element: index, box: element.rect, below: belowFirstView(element, view) })) } }
        : {}),
      below: shown.filter(({ element }) => belowFirstView(element, view)).map(({ index }) => index),
    },
    edge: {
      line: width,
      scrollWidth: snapshot.scrollWidth,
      overflow,
      crossing: overflow > 0 ? shown.filter(({ element }) => element.rect.x + element.rect.width > width + 0.5).map(({ index }) => index) : [],
    },
  };
}

/** One task's flow against its step budget. */
export type TaskFacts = {
  readonly task: string;
  readonly description?: string;
  readonly budget: number;
  readonly success: string;
  /**
   * `fits`: every route fits the budget. `over`: the longest does not.
   * `no-route`: no route reaches the success state. `too-many`: more routes
   * than can be walked. `not-modeled`: the prototype's flow has no such
   * task, has it twice, or names a state the flow does not have.
   */
  readonly status: "fits" | "over" | "no-route" | "too-many" | "not-modeled";
  readonly start?: string;
  /** The task's transitions, sorted by from, event and to. */
  readonly transitions: readonly Transition[];
  /** How many routes reach the success state without passing a state twice. */
  readonly routes?: number;
  /** The longest route, step by step: the one the step-budget rule measures. */
  readonly longest?: readonly Transition[];
};

export type FlowFacts = {
  readonly tasks: readonly TaskFacts[];
  /** Every flow state, in the flow's order, with the ids of the scenarios that show it, in the prototype's order. */
  readonly states: readonly { readonly state: string; readonly scenarios: readonly string[] }[];
};

/** Each task's routes against its budget, and each flow state's scenarios. */
export function flowFacts(config: ProjectConfig, prototype: Prototype): FlowFacts {
  const { flow, scenarios } = prototype;
  const known = new Set(flow.states);
  const tasks = [...config.inputs.tasks]
    .sort((a, b) => compareStrings(a.id, b.id))
    .map((task): TaskFacts => {
      const base = { task: task.id, ...(task.description !== undefined ? { description: task.description } : {}), budget: task.maxSteps, success: task.successState };
      const modeled = flow.tasks.filter((item) => item.task === task.id);
      const taskFlow = modeled[0];
      if (!taskFlow) return { ...base, status: "not-modeled", transitions: [] };
      const transitions = sortTransitions(taskFlow.transitions);
      const named = [taskFlow.start, task.successState, ...transitions.flatMap((transition) => [transition.from, transition.to])];
      if (modeled.length > 1 || named.some((state) => !known.has(state))) return { ...base, status: "not-modeled", start: taskFlow.start, transitions };
      const search = routes(taskFlow.start, task.successState, taskFlow.transitions);
      if (search.kind === "too-many") return { ...base, status: "too-many", start: taskFlow.start, transitions };
      if (search.longest === null || search.path === null) return { ...base, status: "no-route", start: taskFlow.start, transitions, routes: 0 };
      return { ...base, status: search.longest.length > task.maxSteps ? "over" : "fits", start: taskFlow.start, transitions, routes: search.routes, longest: search.path };
    });
  const seen = new Set<string>();
  const states = flow.states
    .filter((state) => (seen.has(state) ? false : (seen.add(state), true)))
    .map((state) => ({ state, scenarios: scenarios.filter((scenario) => scenario.state === state).map((scenario) => scenario.id) }));
  return { tasks, states };
}
