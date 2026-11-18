import type { Transition } from "../../prototype/types";
import type { FlowRule } from "../../rules/types";
import type { CheckContext } from "../context";
import { compareStrings, type Finding } from "../report";
import type { Outcome } from "./outcome";

export function evaluateFlow(rule: FlowRule, ctx: CheckContext): Outcome {
  return { findings: rule.check === "state-coverage" ? stateCoverage(rule, ctx) : stepBudget(rule, ctx) };
}

/** Every flow state has a scenario, and every scenario shows a flow state on a manifest page, under an id no other scenario has. */
function stateCoverage(rule: FlowRule, ctx: CheckContext): Finding[] {
  const { flow, scenarios, pages } = ctx.prototype;
  const states = new Set(flow.states);
  const pageIds = new Set(pages.map((page) => page.id));
  const findings: Finding[] = [];
  for (const state of [...states].sort(compareStrings)) {
    if (!scenarios.some((scenario) => scenario.state === state)) {
      findings.push({ rule: rule.id, state, kind: "violation", message: `Flow state "${state}" has no scenario, so no one can open the page in that state. Add a scenario for it.` });
    }
  }
  const seen = new Set<string>();
  for (const scenario of [...scenarios].sort((a, b) => compareStrings(a.id, b.id))) {
    const base = { rule: rule.id, scenario: scenario.id, state: scenario.state };
    if (seen.has(scenario.id)) findings.push({ ...base, kind: "violation", message: `Scenario id "${scenario.id}" is used twice.` });
    seen.add(scenario.id);
    if (!states.has(scenario.state)) findings.push({ ...base, kind: "violation", message: `Scenario "${scenario.id}" shows "${scenario.state}", which is not a state of the flow.` });
    if (!pageIds.has(scenario.page)) findings.push({ ...base, page: scenario.page, kind: "violation", message: `Scenario "${scenario.id}" opens page "${scenario.page}", which is not a page in the manifest.` });
  }
  return findings;
}

/** Most routes, and most steps walked, before the search gives up and says so. */
const ROUTE_LIMIT = 10_000;
const STEP_LIMIT = 200_000;

type Search = { readonly kind: "done"; readonly routes: number; readonly longest: readonly string[] | null } | { readonly kind: "too-many" };

/**
 * Every route from the start to the success state that never returns to a
 * state it has passed. A route ends at the success state. Transitions are
 * walked in sorted order, so the longest route reported is the same however
 * the flow lists them.
 */
export function routes(start: string, success: string, transitions: readonly Transition[]): Search {
  const sorted = [...transitions].sort((a, b) => compareStrings(a.from, b.from) || compareStrings(a.event, b.event) || compareStrings(a.to, b.to));
  const out = new Map<string, Transition[]>();
  for (const transition of sorted) out.set(transition.from, [...(out.get(transition.from) ?? []), transition]);
  let count = 0;
  let longest: string[] | null = null;
  let steps = 0;
  let tooMany = false;
  const walk = (state: string, passed: Set<string>, events: string[]) => {
    steps += 1;
    if (steps > STEP_LIMIT) tooMany = true;
    if (tooMany) return;
    if (state === success) {
      count += 1;
      if (count > ROUTE_LIMIT) tooMany = true;
      if (!longest || events.length > longest.length) longest = [...events];
      return;
    }
    for (const transition of out.get(state) ?? []) {
      if (passed.has(transition.to)) continue;
      passed.add(transition.to);
      events.push(transition.event);
      walk(transition.to, passed, events);
      events.pop();
      passed.delete(transition.to);
    }
  };
  walk(start, new Set([start]), []);
  return tooMany ? { kind: "too-many" } : { kind: "done", routes: count, longest };
}

/** Every route that finishes a task fits its max steps: the longest, not only the shortest. */
function stepBudget(rule: FlowRule, ctx: CheckContext): Finding[] {
  const { flow } = ctx.prototype;
  const states = new Set(flow.states);
  const findings: Finding[] = [];
  const tasks = ctx.config.inputs.tasks;
  for (const taskFlow of flow.tasks) {
    if (!tasks.some((task) => task.id === taskFlow.task)) findings.push({ rule: rule.id, kind: "violation", message: `The flow models task "${taskFlow.task}", which is not a task in the project.` });
  }
  for (const task of [...tasks].sort((a, b) => compareStrings(a.id, b.id))) {
    const modeled = flow.tasks.filter((item) => item.task === task.id);
    const taskFlow = modeled[0];
    if (!taskFlow) {
      findings.push({ rule: rule.id, kind: "violation", message: `Task "${task.id}" has no flow, so its step budget cannot be measured. Add it to the prototype's flow tasks.` });
      continue;
    }
    if (modeled.length > 1) findings.push({ rule: rule.id, kind: "violation", message: `Task "${task.id}" has ${modeled.length} flows; it needs one.` });
    const unknownStates = [taskFlow.start, task.successState, ...taskFlow.transitions.flatMap((transition) => [transition.from, transition.to])].filter((state) => !states.has(state));
    if (unknownStates.length > 0) {
      findings.push({ rule: rule.id, kind: "violation", message: `Task "${task.id}"'s flow names ${[...new Set(unknownStates)].map((state) => `"${state}"`).join(", ")}, which ${unknownStates.length === 1 ? "is not a state" : "are not states"} of the flow.` });
      continue;
    }
    const search = routes(taskFlow.start, task.successState, taskFlow.transitions);
    if (search.kind === "too-many") {
      findings.push({ rule: rule.id, kind: "unverifiable", message: `Task "${task.id}" has more than ${ROUTE_LIMIT} routes to "${task.successState}", so not every route was measured. Cut the ways through the flow.` });
    } else if (search.longest === null) {
      findings.push({ rule: rule.id, state: task.successState, kind: "violation", message: `No route from "${taskFlow.start}" reaches "${task.successState}", so task "${task.id}" cannot be finished.` });
    } else if (search.longest.length > task.maxSteps) {
      findings.push({
        rule: rule.id,
        state: task.successState,
        kind: "violation",
        message: `The route ${search.longest.join(" → ")} takes ${search.longest.length} steps, which exceeds max steps ${task.maxSteps} for "${task.id}". Every route that finishes the task must fit, not only the shortest.`,
      });
    }
  }
  return findings;
}
