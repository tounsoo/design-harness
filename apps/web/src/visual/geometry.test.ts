import { describe, expect, it } from "vitest";
import type { BoxWithNeighbourEvidence, RegionLineEvidence, SequenceGapEvidence } from "@design-harness/core";
import { cameraMove, MIN_VISIBLE_PX } from "./camera";
import { boxFigure, fitScale, outlineRows, regionFigure, routeSteps } from "./geometry";

const small: BoxWithNeighbourEvidence = { kind: "box-with-neighbour", name: "A", role: "button", box: { x: 280, y: 170, width: 12, height: 12 }, min: 24, neighbour: { element: 3, name: "B", role: "button", box: { x: 296, y: 170, width: 12, height: 12 }, meets: "in-circle" } };

describe("the target-size figure", () => {
  it("shows the control at one of the fixed scales, with its circle of the minimum's diameter centred on it", () => {
    const figure = boxFigure(small);
    expect([8, 6, 5, 4, 3, 2, 1.5, 1]).toContain(figure.scale);
    expect(figure.box.width).toBe(12 * figure.scale);
    expect(figure.circle.r).toBe(12 * figure.scale);
    expect(figure.circle.cx).toBeCloseTo(figure.box.x + figure.box.width / 2, 1);
    expect(figure.circle.cy).toBeCloseTo(figure.box.y + figure.box.height / 2, 1);
    expect(figure.measured).toEqual({ width: 12, height: 12 });
  });

  it("puts the neighbour where it was measured, at the same scale", () => {
    const figure = boxFigure(small);
    expect(figure.neighbour?.box.x).toBeCloseTo(figure.box.x + 16 * figure.scale, 1);
    expect(figure.neighbour?.box.y).toBe(figure.box.y);
    expect(figure.neighbour).toMatchObject({ name: "B", cut: false });
    expect(figure.neighbour?.circle).toBeUndefined();
  });

  it("keeps everything inside the figure, cutting a neighbour that is much larger than the control", () => {
    const wide: BoxWithNeighbourEvidence = { ...small, neighbour: { element: 3, name: "Book room", role: "button", box: { x: 296, y: 100, width: 600, height: 300 }, meets: "in-circle" } };
    const figure = boxFigure(wide);
    const box = figure.neighbour?.box;
    if (!box) throw new Error("no neighbour");
    expect(figure.neighbour?.cut).toBe(true);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(figure.size.width + 0.01);
    expect(box.y + box.height).toBeLessThanOrEqual(figure.size.height + 0.01);
    // The control is still drawn large enough to see.
    expect(figure.box.width).toBeGreaterThanOrEqual(24);
  });

  it("draws the neighbour's own circle when both are undersized and it is the circles that meet", () => {
    const figure = boxFigure({ ...small, neighbour: { element: 3, name: "B", role: "button", box: { x: 298, y: 170, width: 10, height: 10 }, meets: "circles-meet" } });
    expect(figure.neighbour?.circle?.r).toBe(figure.circle.r);
  });

  it("a control with no neighbour is the box and its circle alone", () => {
    const { neighbour: _neighbour, ...alone } = small;
    expect(boxFigure(alone).neighbour).toBeUndefined();
  });

  it("is the same figure for the same evidence", () => {
    expect(boxFigure(small)).toEqual(boxFigure(JSON.parse(JSON.stringify(small)) as BoxWithNeighbourEvidence));
  });
});

describe("fitScale", () => {
  it("picks the largest fixed scale that fits, and falls back to the exact fit below the smallest", () => {
    expect(fitScale({ width: 60, height: 36 }, { width: 254, height: 144 })).toBe(4);
    expect(fitScale({ width: 100, height: 100 }, { width: 100, height: 100 })).toBe(1);
    expect(fitScale({ width: 10000, height: 10 }, { width: 100, height: 100 })).toBe(0.01);
  });
});

describe("the heading outline", () => {
  const skipped: SequenceGapEvidence = { kind: "sequence-gap", items: [{ level: 1, text: "Rooms", shown: true }, { level: 4, text: "Lantern", shown: true }, { level: 2, text: "Harbor", shown: false }], problem: "skipped", at: 1, after: 0, missing: [2, 3] };

  it("puts an empty row for each skipped level just above the heading that skips them, and flags that heading", () => {
    expect(outlineRows(skipped)).toEqual([
      { kind: "heading", level: 1, text: "Rooms", shown: true },
      { kind: "gap", level: 2 },
      { kind: "gap", level: 3 },
      { kind: "heading", level: 4, text: "Lantern", shown: true, flag: "skips a level" },
      { kind: "heading", level: 2, text: "Harbor", shown: false },
    ]);
  });

  it("flags a second h1 and a heading before the title without inventing a gap", () => {
    expect(outlineRows({ ...skipped, problem: "second-first", missing: [] }).filter((row) => row.kind === "gap")).toEqual([]);
    expect(outlineRows({ ...skipped, problem: "second-first" }).find((row) => row.kind === "heading" && row.flag)).toMatchObject({ flag: "a second h1" });
    expect(outlineRows({ ...skipped, problem: "before-first", at: 0 })[0]).toMatchObject({ flag: "before the title" });
  });

  it("starts with an empty h1 row when the page has no title", () => {
    expect(outlineRows({ kind: "sequence-gap", items: [{ level: 2, text: "Lantern", shown: true }], problem: "no-first" })).toEqual([{ kind: "gap", level: 1 }, { kind: "heading", level: 2, text: "Lantern", shown: true }]);
  });

  it("keeps a long outline to the rows around the problem, and says how many it left out", () => {
    const items = Array.from({ length: 30 }, (_, index) => ({ level: index === 0 ? 1 : 2, text: `Heading ${index}`, shown: true }));
    const rows = outlineRows({ kind: "sequence-gap", items: items.map((item, index) => (index === 20 ? { ...item, level: 4 } : item)), problem: "skipped", at: 20, after: 19, missing: [3] }, 8);
    expect(rows.length).toBeLessThanOrEqual(10);
    expect(rows[0]).toMatchObject({ text: "Heading 0" });
    expect(rows.some((row) => row.kind === "heading" && row.flag === "skips a level")).toBe(true);
    expect(rows.some((row) => row.kind === "gap")).toBe(true);
    const left = rows.flatMap((row) => (row.kind === "more" ? [row.count] : [])).reduce((sum, count) => sum + count, 0);
    expect(left + rows.filter((row) => row.kind !== "more").length).toBe(31);
  });
});

describe("the region figure", () => {
  const below: RegionLineEvidence = { kind: "region-line", axis: "y", line: 844, from: 900, to: 944, box: { x: 16, y: 900, width: 358, height: 44 }, view: { width: 390, height: 844 }, pageHeight: 1000 };

  it("down the page: a close-up with the fold across it and the action under it, inside the figure", () => {
    const figure = regionFigure(below);
    const box = figure.box;
    if (!box) throw new Error("no box");
    expect(figure.closeUp).toBe(true);
    expect(figure.by).toBe(100);
    expect(box.y).toBeGreaterThan(figure.line.y1);
    expect(figure.past.y).toBeCloseTo(figure.line.y1, 1);
    expect(figure.view.y + figure.view.height).toBeCloseTo(figure.line.y1, 1);
    expect(box.x + box.width).toBeLessThanOrEqual(figure.size.width);
    expect(box.y + box.height).toBeLessThanOrEqual(figure.size.height);
    // Large enough to see: at least a tenth of the figure's height.
    expect(box.height).toBeGreaterThanOrEqual(8);
  });

  it("down the page, not a close-up: the whole page in miniature", () => {
    const figure = regionFigure(below, { width: 280, height: 150 }, { closeUp: false });
    expect(figure.closeUp).toBe(false);
    expect(figure.window).toEqual({ x: 0, y: 0, width: 390, height: 1000 });
    expect(figure.page.height / 1000).toBeCloseTo(figure.scale, 2);
  });

  it("an action that straddles the fold starts above the line and ends below it", () => {
    const figure = regionFigure({ ...below, from: 820, to: 864, box: { x: 16, y: 820, width: 358, height: 44 }, pageHeight: 900 });
    expect(figure.box?.y).toBeLessThan(figure.line.y1);
    expect((figure.box?.y ?? 0) + (figure.box?.height ?? 0)).toBeGreaterThan(figure.line.y1);
    expect(figure.by).toBe(20);
  });

  it("across: the view, its edge, and a strip as wide as the page runs past it", () => {
    const figure = regionFigure({ kind: "region-line", axis: "x", line: 390, from: 390, to: 520, view: { width: 390, height: 844 } });
    expect(figure.by).toBe(130);
    expect(figure.past.x).toBeCloseTo(figure.line.x1, 1);
    expect(figure.past.width / 130).toBeCloseTo(figure.scale, 2);
    expect(figure.view.width / 390).toBeCloseTo(figure.scale, 2);
    expect(figure.past.x + figure.past.width).toBeLessThan(figure.size.width - 40);
  });
});

describe("a route's steps", () => {
  it("are numbered from 1, and marked once they pass the budget", () => {
    const route = [{ from: "a", event: "x", to: "b" }, { from: "b", event: "y", to: "c" }, { from: "c", event: "z", to: "d" }];
    expect(routeSteps({ route, budget: 2 }).map((step) => [step.number, step.over])).toEqual([[1, false], [2, false], [3, true]]);
    expect(routeSteps({ route, budget: 3 }).some((step) => step.over)).toBe(false);
  });
});

describe("the camera", () => {
  it("opens the artboard when the element would be too small to see on screen, and only scrolls otherwise", () => {
    expect(MIN_VISIBLE_PX).toBe(16);
    // A 11 by 20 px control at 40% is 4 by 8 px on screen.
    expect(cameraMove({ x: 0, y: 0, width: 11, height: 20 }, 0.4)).toBe("open");
    expect(cameraMove({ x: 0, y: 0, width: 30, height: 30 }, 0.4)).toBe("open");
    // A button, and a line of text: small, but their outline is plain to see.
    expect(cameraMove({ x: 0, y: 0, width: 160, height: 44 }, 0.4)).toBe("scroll");
    expect(cameraMove({ x: 0, y: 0, width: 700, height: 24 }, 0.4)).toBe("scroll");
    expect(cameraMove({ x: 0, y: 0, width: 40, height: 40 }, 0.4)).toBe("scroll");
    // A sliver, however long.
    expect(cameraMove({ x: 0, y: 0, width: 700, height: 8 }, 0.4)).toBe("open");
  });

  it("never opens at full size already, for a finding with no box, or for a box that is not drawn", () => {
    expect(cameraMove({ x: 0, y: 0, width: 4, height: 4 }, 1)).toBe("scroll");
    expect(cameraMove(undefined, 0.25)).toBe("scroll");
    expect(cameraMove({ x: 0, y: 0, width: 0, height: 0 }, 0.25)).toBe("scroll");
  });
});
