import { Button } from "@tounsoo/todae";
import { useId } from "react";
import type { Transition } from "@design-harness/core";
import { humanize } from "../app/words";
import { Bar } from "./parts";
import { flowMap } from "./flow-map";
import { countBar, routeSteps } from "./geometry";

/** One task's flow, as core measured it: from `flowFacts`, or from a step-budget finding's evidence. */
export type FlowTask = {
  readonly id: string;
  readonly start?: string | undefined;
  readonly success: string;
  readonly budget: number;
  readonly transitions: readonly Transition[];
  readonly longest?: readonly Transition[] | undefined;
  readonly status: "fits" | "over" | "no-route" | "too-many" | "not-modeled";
  /** How many routes reach the success state, when core counted them. */
  readonly routes?: number | undefined;
};

const clip = (text: string, most: number) => (text.length > most ? `${text.slice(0, most - 1)}…` : text);

/**
 * A task's routes as a map: the longest route along the top, each step
 * numbered against the budget, the other transitions dashed, and a state no
 * scenario shows drawn dashed too. The map is a picture for the eye; the
 * same route is the ordered list under it, which is what a screen reader
 * reads, and each state there opens its artboard when it has one.
 */
export function FlowMap({ task, scenarios, onOpenState }: { readonly task: FlowTask; /** State → the scenarios that show it. */ readonly scenarios?: Readonly<Record<string, readonly string[]>> | undefined; readonly onOpenState?: ((state: string) => void) | undefined }) {
  const id = useId();
  const longest = task.longest ?? [];
  const layout = task.start !== undefined ? flowMap({ start: task.start, success: task.success, budget: task.budget, transitions: task.transitions, ...(longest.length > 0 ? { longest } : {}) }) : null;
  const steps = routeSteps({ route: longest, budget: task.budget });
  const drawn = (state: string) => scenarios === undefined || (scenarios[state]?.length ?? 0) > 0;
  const stateName = (state: string) =>
    onOpenState && scenarios && drawn(state) ? (
      <Button.Root variant="ghost" className="flow-state" onClick={() => onOpenState(state)} aria-label={`Show ${humanize(state)} on the canvas`}>
        {humanize(state)}
      </Button.Root>
    ) : (
      <span className="flow-state-name">{humanize(state)}</span>
    );
  return (
    <div className="flow" data-task={task.id} data-status={task.status} data-testid="flow-map">
      {layout && (
        <div className="flow-scroll">
          <svg className="vis-svg flow-svg" viewBox={`0 0 ${layout.width} ${layout.height}`} style={{ maxInlineSize: `${layout.width}px`, minInlineSize: `${Math.round(layout.width * 0.8)}px` }} aria-hidden="true" data-testid="flow-svg">
            <defs>
              <pattern id={`${id}hatch`} className="vis-hatch" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
                <line x1="0" y1="0" x2="0" y2="6" />
              </pattern>
              <marker id={`${id}arrow`} className="flow-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                <path d="M 0 0 L 8 4 L 0 8 z" />
              </marker>
              <marker id={`${id}arrow-quiet`} className="flow-arrow flow-arrow-quiet" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
                <path d="M 0 0 L 8 4 L 0 8 z" />
              </marker>
            </defs>
            {layout.edges
              .filter((edge) => edge.step === undefined)
              .map((edge) => (
                <g key={`${edge.from} ${edge.event} ${edge.to}`} data-testid="flow-other">
                  <path className="flow-edge flow-edge-other" d={edge.path} markerEnd={`url(#${id}arrow-quiet)`} />
                  <text className="vis-text vis-text-muted vis-text-halo" x={edge.label.x} y={edge.label.y} textAnchor={edge.label.anchor}>
                    {clip(edge.event, 11)}
                  </text>
                </g>
              ))}
            {layout.limit && (
              <g data-testid="flow-limit">
                <line className="flow-limit" x1={layout.limit.x1} y1={layout.limit.y} x2={layout.limit.x2} y2={layout.limit.y} />
                <text className="vis-text vis-text-strong vis-text-halo" x={layout.limit.x2 + 4} y={layout.limit.y + 4}>
                  budget {task.budget}
                </text>
              </g>
            )}
            {layout.edges
              .flatMap((edge) => (edge.step !== undefined && edge.number ? [{ ...edge, at: edge.number }] : []))
              .map((edge) => (
                <g key={edge.step} data-testid="flow-step" data-over={edge.over ? "" : undefined}>
                  <path className="flow-edge" d={edge.path} markerEnd={`url(#${id}arrow)`} />
                  {/* A step that fits is a round number; a step past the budget is a square, hatched one. */}
                  {edge.over ? (
                    <>
                      <rect className="flow-number-over" x={edge.at.x - 9} y={edge.at.y - 9} width="18" height="18" rx="2" />
                      <rect className="vis-fail-area" x={edge.at.x - 9} y={edge.at.y - 9} width="18" height="18" rx="2" fill={`url(#${id}hatch)`} />
                    </>
                  ) : (
                    <circle className="flow-number" cx={edge.at.x} cy={edge.at.y} r="9" />
                  )}
                  <text className={`vis-text flow-number-text${edge.over ? " flow-number-text-over" : ""}`} x={edge.at.x} y={edge.at.y + 3.5} textAnchor="middle" data-testid="flow-step-number">
                    {edge.step}
                  </text>
                  <text className="vis-text vis-text-muted vis-text-halo" x={edge.label.x} y={edge.label.y} textAnchor={edge.label.anchor}>
                    {clip(edge.event, 11)}
                  </text>
                </g>
              ))}
            {layout.nodes.map((node) => (
              <g key={node.id} data-testid="flow-node" data-state={node.id} data-role={node.role} data-drawn={drawn(node.id) ? "" : undefined}>
                <rect className="flow-node" x={node.x} y={node.y} width={node.width} height={node.height} rx={node.role === "success" ? node.height / 2 : 6} />
                <text className="vis-text flow-node-text" x={node.x + node.width / 2} y={node.y + (scenarios ? 16 : 22)} textAnchor="middle">
                  {clip(humanize(node.id), 16)}
                </text>
                {scenarios && (
                  <text className="vis-text flow-node-sub" x={node.x + node.width / 2} y={node.y + 29} textAnchor="middle">
                    {drawn(node.id) ? `${scenarios[node.id]?.length ?? 0} ${(scenarios[node.id]?.length ?? 0) === 1 ? "scenario" : "scenarios"}` : "no scenario"}
                  </text>
                )}
              </g>
            ))}
          </svg>
        </div>
      )}
      {task.status === "fits" || task.status === "over" ? (
        <>
          <Bar bar={{ ...countBar({ count: longest.length, cap: task.budget, bound: "max" }), words: `${longest.length} ${longest.length === 1 ? "step" : "steps"} on the longest route, budget ${task.budget}` }} />
          <ol className="flow-steps" aria-label={`The longest route of ${task.id}, step by step`} data-testid="flow-steps">
            {steps.map((step) => (
              <li key={step.number} className="flow-step" data-over={step.over ? "" : undefined}>
                <span className="flow-step-number" aria-hidden="true">
                  {step.number}
                </span>
                {step.number === 1 && <>{stateName(step.from)} </>}
                <span className="flow-step-event">{step.event}</span> <span aria-hidden="true">→</span> {stateName(step.to)}
                {step.over && <span className="flow-step-over"> ✕ past the budget of {task.budget}</span>}
              </li>
            ))}
          </ol>
          {task.routes !== undefined && task.routes > 1 && (
            <p className="flow-note">
              {task.routes} routes reach {humanize(task.success).toLowerCase()}; every one must fit, so the longest is the one numbered.
            </p>
          )}
        </>
      ) : (
        <p className="flow-note" data-testid="flow-problem">
          {task.status === "no-route" ? `No route reaches ${humanize(task.success).toLowerCase()}, so the task cannot be finished.` : task.status === "too-many" ? "Too many routes to walk them all." : "The prototype's flow does not model this task, so there is no route to draw."}
        </p>
      )}
    </div>
  );
}
