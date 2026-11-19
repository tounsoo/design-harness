import type { Transition } from "@design-harness/core";

/**
 * A task's flow laid out as a small map, the same way every time: the
 * longest route runs down the page as a spine, numbered step by step; a
 * transition between two spine states that is not a step of that route is
 * a dashed arc at the spine's start side; a state off the spine sits in a
 * second column, level with its shortest distance from the start. Down the
 * page, so the map fits a narrow panel at full size. The route and the
 * budget come from core (`flowFacts`, or a step-budget finding's
 * evidence); this only places them.
 */

export type FlowInput = {
  readonly start: string;
  readonly success: string;
  readonly budget: number;
  /** Sorted by from, event and to, as core gives them. */
  readonly transitions: readonly Transition[];
  /** The longest route, step by step; absent when no route reaches the success state. */
  readonly longest?: readonly Transition[];
};

export type FlowNode = { readonly id: string; readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly role: "start" | "success" | "state"; readonly onRoute: boolean };
export type FlowEdge = {
  readonly from: string;
  readonly to: string;
  readonly event: string;
  /** The step's number on the longest route; absent for any other transition. */
  readonly step?: number;
  /** True for a numbered step past the budget. */
  readonly over: boolean;
  /** An SVG path from the edge of one node to the edge of the other. */
  readonly path: string;
  /** Where the step's number sits (a numbered step), and where the event's name is written. */
  readonly number?: { readonly x: number; readonly y: number };
  readonly label: { readonly x: number; readonly y: number; readonly anchor: "start" | "middle" | "end" };
};
export type FlowMapLayout = {
  readonly width: number;
  readonly height: number;
  readonly nodes: readonly FlowNode[];
  readonly edges: readonly FlowEdge[];
  /** The budget as a line across the spine, after the last step that fits; absent when the route fits or there is none. */
  readonly limit?: { readonly x1: number; readonly x2: number; readonly y: number };
};

export const NODE = { width: 112, height: 38 } as const;
const GAP = { step: 46, column: 40 } as const;
/** Room at the spine's start side for the arcs and their names, and at its end side for a step's event name. */
const ARC_ROOM = 84;
const EVENT_ROOM = 78;
/** More states than this and the map is not drawn: the list of steps says it. */
export const MAX_MAP_STATES = 10;

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function flowMap(input: FlowInput): FlowMapLayout | null {
  const { start, success, budget, transitions } = input;
  const longest = input.longest ?? [];
  const spine = longest.length > 0 ? [start, ...longest.map((step) => step.to)] : [start];
  const all = [...new Set([start, success, ...transitions.flatMap((transition) => [transition.from, transition.to])])];
  if (all.length > MAX_MAP_STATES) return null;

  // Shortest distance from the start, breadth first, over the sorted transitions.
  const distance = new Map<string, number>([[start, 0]]);
  const queue = [start];
  while (queue.length > 0) {
    const state = queue.shift() as string;
    for (const transition of transitions) {
      if (transition.from !== state || distance.has(transition.to)) continue;
      distance.set(transition.to, (distance.get(state) ?? 0) + 1);
      queue.push(transition.to);
    }
  }

  // `level`: how far down. `column`: 0 for the spine, 1 for a state off it.
  const level = new Map<string, number>(spine.map((state, index) => [state, index]));
  const column = new Map<string, number>(spine.map((state) => [state, 0]));
  const taken = new Set<number>();
  const off = all.filter((state) => !level.has(state)).sort((a, b) => (distance.get(a) ?? Number.MAX_SAFE_INTEGER) - (distance.get(b) ?? Number.MAX_SAFE_INTEGER) || cmp(a, b));
  for (const state of off) {
    let at = Math.max(0, Math.min(distance.get(state) ?? spine.length, spine.length + off.length));
    while (taken.has(at)) at += 1;
    taken.add(at);
    level.set(state, at);
    column.set(state, 1);
  }

  const isArc = (transition: Transition) => column.get(transition.from) === 0 && column.get(transition.to) === 0 && !onRoute(transition, longest);
  const arcRoom = transitions.some(isArc) ? ARC_ROOM : 8;
  const top = 8;
  const xOf = (state: string) => arcRoom + (column.get(state) ?? 0) * (NODE.width + GAP.column);
  const yOf = (state: string) => top + (level.get(state) ?? 0) * (NODE.height + GAP.step);
  const nodes: FlowNode[] = all
    .sort((a, b) => (column.get(a) ?? 0) - (column.get(b) ?? 0) || (level.get(a) ?? 0) - (level.get(b) ?? 0))
    .map((id) => ({ id, x: xOf(id), y: yOf(id), width: NODE.width, height: NODE.height, role: id === success ? "success" : id === start ? "start" : "state", onRoute: column.get(id) === 0 && longest.length > 0 }));

  const edges: FlowEdge[] = [];
  longest.forEach((step, index) => {
    const x = xOf(step.from) + NODE.width / 2;
    const y1 = yOf(step.from) + NODE.height;
    const y2 = yOf(step.to);
    const middle = (y1 + y2) / 2;
    edges.push({ from: step.from, to: step.to, event: step.event, step: index + 1, over: index + 1 > budget, path: `M ${x} ${y1} L ${x} ${y2 - 2}`, number: { x, y: middle }, label: { x: x + 15, y: middle + 4, anchor: "start" } });
  });
  for (const transition of transitions) {
    if (onRoute(transition, longest)) continue;
    if (isArc(transition)) {
      // Between two spine states, but not a step of the longest route: an arc at the spine's start side.
      const x = xOf(transition.from);
      const down = (level.get(transition.to) ?? 0) > (level.get(transition.from) ?? 0);
      const sy = yOf(transition.from) + NODE.height / 2 + (down ? 7 : -7);
      const ey = yOf(transition.to) + NODE.height / 2 + (down ? -7 : 7);
      const reach = Math.min(34, 12 + 8 * Math.abs((level.get(transition.to) ?? 0) - (level.get(transition.from) ?? 0)));
      edges.push({ from: transition.from, to: transition.to, event: transition.event, over: false, path: `M ${x} ${sy} C ${x - reach * 1.33} ${sy}, ${x - reach * 1.33} ${ey}, ${x - 2} ${ey}`, label: { x: x - reach - 5, y: (sy + ey) / 2 + 4, anchor: "end" } });
    } else {
      // To or from a state off the spine: a straight line between the sides that face each other.
      const right = (column.get(transition.to) ?? 0) > (column.get(transition.from) ?? 0);
      const same = column.get(transition.to) === column.get(transition.from);
      const below = (level.get(transition.to) ?? 0) > (level.get(transition.from) ?? 0);
      const sx = same ? xOf(transition.from) + NODE.width / 2 + 16 : xOf(transition.from) + (right ? NODE.width : 0);
      const ex = same ? sx : xOf(transition.to) + (right ? -2 : NODE.width + 2);
      const sy = same ? yOf(transition.from) + (below ? NODE.height : 0) : yOf(transition.from) + NODE.height / 2;
      const ey = same ? yOf(transition.to) + (below ? -2 : NODE.height + 2) : yOf(transition.to) + NODE.height / 2;
      edges.push({ from: transition.from, to: transition.to, event: transition.event, over: false, path: `M ${sx} ${sy} L ${ex} ${ey}`, label: { x: (sx + ex) / 2, y: (sy + ey) / 2 + (same ? 4 : -4), anchor: "middle" } });
    }
  }

  const levels = Math.max(...level.values()) + 1;
  const columns = Math.max(...column.values()) + 1;
  const width = arcRoom + columns * NODE.width + (columns - 1) * GAP.column + (columns === 1 ? EVENT_ROOM : 8);
  const height = top + levels * NODE.height + (levels - 1) * GAP.step + 8;
  const lastFitting = spine[budget];
  const limit = longest.length > budget && lastFitting !== undefined ? { x1: xOf(lastFitting) - 10, x2: xOf(lastFitting) + NODE.width + 10, y: yOf(lastFitting) + NODE.height + 7 } : undefined;
  return { width, height, nodes, edges, ...(limit ? { limit } : {}) };
}

function onRoute(transition: Transition, longest: readonly Transition[]): boolean {
  return longest.some((step) => step.from === transition.from && step.event === transition.event && step.to === transition.to);
}
