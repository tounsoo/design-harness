import { describe, expect, it } from "vitest";
import { checkPrototype, flowFacts, type Prototype } from "@design-harness/core";
import { nook } from "../../../../packages/core/examples/nook/project";
import { renderedCases } from "../../../../packages/core/examples/nook/rendered-cases";
import { legalSnapshots } from "../../../../packages/core/examples/nook/snapshots";
import { frameSpecs, type FrameState } from "../runtime/session";
import { seedSpec } from "../../test/nook";
import { coverage } from "./coverage";
import { cellWords } from "./CoverageGrid";

const legal = seedSpec();

function measuredStates(prototype: Prototype, snapshots = legalSnapshots()): Record<string, FrameState> {
  return Object.fromEntries(frameSpecs(nook, prototype).map((frame) => [frame.key, { state: "measured", snapshot: snapshots.find((item) => item.scenario === frame.scenario.id && item.view === frame.view.name) ?? snapshots[0], tags: [] } as FrameState]));
}

describe("the coverage grid", () => {
  it("has a row for each scenario under its flow state, a cell for each view, and every cell passing on the legal prototype", () => {
    const report = checkPrototype({ config: nook, prototype: legal, snapshots: legalSnapshots() });
    const grid = coverage(flowFacts(nook, legal), frameSpecs(nook, legal), measuredStates(legal), report, true);
    expect(grid.views).toEqual(["desktop", "phone"]);
    expect(grid.rows.map((row) => (row.kind === "scenario" ? [row.state, row.scenario] : [row.state]))).toEqual([["rooms", "rooms-list"], ["room-open", "lantern-open"], ["booked", "lantern-booked"], ["held", "lantern-held"]]);
    expect(grid.rows.flatMap((row) => (row.kind === "scenario" ? row.cells : []))).toEqual(frameSpecs(nook, legal).map((frame) => ({ kind: "passes", key: frame.key })));
    expect([grid.covered, grid.states]).toEqual([4, 4]);
  });

  it("counts core's findings on the artboard they name", () => {
    const snapshots = renderedCases.find((item) => item.name === "small-targets-side-by-side")?.snapshots() ?? [];
    const report = checkPrototype({ config: nook, prototype: legal, snapshots });
    const grid = coverage(flowFacts(nook, legal), frameSpecs(nook, legal), measuredStates(legal, snapshots), report, true);
    const cells = grid.rows.flatMap((row) => (row.kind === "scenario" ? row.cells : []));
    expect(cells.filter((cell) => cell.kind === "to-fix")).toEqual([{ kind: "to-fix", key: "rooms-list@desktop", count: 2 }]);
    expect(cellWords({ kind: "to-fix", key: "rooms-list@desktop", count: 2 })).toBe("2 to fix");
  });

  it("counts a finding about a whole page on every artboard of that page", () => {
    const report = { status: "fail" as const, rules: [], findings: [{ rule: "one-primary-per-page", kind: "violation" as const, message: "two", page: "booking" }] };
    const grid = coverage(flowFacts(nook, legal), frameSpecs(nook, legal), measuredStates(legal), report, true);
    const kinds = grid.rows.map((row) => (row.kind === "scenario" ? row.cells.map((cell) => cell.kind) : []));
    expect(kinds).toEqual([["passes", "passes"], ["to-fix", "to-fix"], ["to-fix", "to-fix"], ["to-fix", "to-fix"]]);
  });

  it("shows a flow state with no scenario as never drawn, with nowhere to go", () => {
    const prototype: Prototype = { ...legal, flow: { ...legal.flow, states: [...legal.flow.states, "pick-time"] } };
    const grid = coverage(flowFacts(nook, prototype), frameSpecs(nook, prototype), measuredStates(prototype), checkPrototype({ config: nook, prototype, snapshots: legalSnapshots() }), true);
    expect(grid.rows.at(-1)).toEqual({ kind: "never-drawn", state: "pick-time" });
    expect([grid.covered, grid.states]).toEqual([4, 5]);
  });

  it("says measuring until every frame has answered, and why a frame failed", () => {
    const frames = frameSpecs(nook, legal);
    const states: Record<string, FrameState> = { ...measuredStates(legal), "rooms-list@phone": { state: "failed", stage: "timeout", message: "The frame did not answer." }, "lantern-open@phone": { state: "rendering" } };
    const grid = coverage(flowFacts(nook, legal), frames, states, checkPrototype({ config: nook, prototype: legal }), false);
    const cells = grid.rows.flatMap((row) => (row.kind === "scenario" ? row.cells : []));
    expect(cells.find((cell) => cell.key === "rooms-list@phone")).toEqual({ kind: "failed", key: "rooms-list@phone", why: "No answer" });
    expect(cells.filter((cell) => cell.kind === "measuring")).toHaveLength(7);
    expect(cells.some((cell) => cell.kind === "passes")).toBe(false);
  });

  it("still lists a scenario that shows a state the flow does not have", () => {
    const prototype: Prototype = { ...legal, scenarios: [...legal.scenarios, { id: "ghost", state: "nowhere", page: "rooms" }] };
    const grid = coverage(flowFacts(nook, prototype), frameSpecs(nook, prototype), {}, null, false);
    expect(grid.rows.at(-1)).toMatchObject({ kind: "scenario", state: "nowhere", scenario: "ghost" });
  });
});
