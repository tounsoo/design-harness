import type { CheckReport, FlowFacts } from "@design-harness/core";
import { frameKey, type FrameKey, type FrameSpec, type FrameState } from "../runtime/session";

/**
 * The coverage grid: every flow state down the side, every view across,
 * and in each cell what that artboard has to fix. It counts core's
 * findings that name the artboard, its scenario or its page, and shows a
 * frame's own state; it decides nothing. A finding with no place, such as
 * one about a task's routes, is on no cell: the Checks panel lists it.
 */

export type CoverageCell =
  | { readonly kind: "passes"; readonly key: FrameKey }
  | { readonly kind: "to-fix"; readonly key: FrameKey; readonly count: number }
  | { readonly kind: "measuring"; readonly key: FrameKey }
  | { readonly kind: "failed"; readonly key: FrameKey; readonly why: string };

export type CoverageRow =
  /** A scenario: one cell per view, in the views' order. */
  | { readonly kind: "scenario"; readonly state: string; readonly scenario: string; readonly page: string; readonly cells: readonly CoverageCell[] }
  /** A flow state no scenario shows: there is no artboard to go to. */
  | { readonly kind: "never-drawn"; readonly state: string };

export type Coverage = { readonly views: readonly string[]; readonly rows: readonly CoverageRow[]; readonly covered: number; readonly states: number };

export function coverage(facts: FlowFacts, frames: readonly FrameSpec[], frameStates: Readonly<Record<FrameKey, FrameState>>, report: CheckReport | null, measured: boolean): Coverage {
  const views = [...new Set(frames.map((frame) => frame.view.name))];
  const cellOf = (scenario: string, view: string, page: string): CoverageCell => {
    const key = frameKey(scenario, view);
    const state = frameStates[key];
    if (state?.state === "failed") return { kind: "failed", key, why: state.stage === "timeout" ? "No answer" : state.stage === "setup" ? "Not rendered" : `Failed to ${state.stage}` };
    // Rules about the rendered page wait for every frame, so until then a cell cannot say it passes.
    if (!measured || !report || state?.state !== "measured") return { kind: "measuring", key };
    // A finding counts here when it names this artboard, this scenario in every view, or this scenario's page as a whole.
    const count = report.findings.filter((finding) => (finding.scenario === scenario && (finding.view === view || finding.view === undefined)) || (finding.scenario === undefined && finding.page !== undefined && finding.page === page)).length;
    return count > 0 ? { kind: "to-fix", key, count } : { kind: "passes", key };
  };
  const rows: CoverageRow[] = [];
  const listed = new Set<string>();
  for (const { state, scenarios } of facts.states) {
    if (scenarios.length === 0) rows.push({ kind: "never-drawn", state });
    for (const scenario of scenarios) {
      const spec = frames.find((frame) => frame.scenario.id === scenario);
      listed.add(scenario);
      const page = spec?.scenario.page ?? "";
      rows.push({ kind: "scenario", state, scenario, page, cells: views.map((view) => cellOf(scenario, view, page)) });
    }
  }
  // A scenario that shows a state the flow does not have still has artboards: it is listed last, under its own state.
  for (const frame of frames) {
    if (listed.has(frame.scenario.id)) continue;
    listed.add(frame.scenario.id);
    rows.push({ kind: "scenario", state: frame.scenario.state, scenario: frame.scenario.id, page: frame.scenario.page, cells: views.map((view) => cellOf(frame.scenario.id, view, frame.scenario.page)) });
  }
  return { views, rows, covered: facts.states.filter((item) => item.scenarios.length > 0).length, states: facts.states.length };
}
