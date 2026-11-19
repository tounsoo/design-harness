import { describe, expect, it } from "vitest";
import { viewFacts, type RenderedElement, type RenderedSnapshot, type View } from "@design-harness/core";
import { nook } from "../../../../packages/core/examples/nook/project";
import { button, legalSnapshots, text } from "../../../../packages/core/examples/nook/snapshots";
import { GHOST_GUTTER, LABEL, LENSES, STRIP_MAX_PX, lensDrawing, placeLens, type LensShape } from "./lens";

const phone = nook.views.find((view) => view.name === "phone") as View;
const desktop = nook.views.find((view) => view.name === "desktop") as View;
const snapshotOf = (scenario: string, view: string) => legalSnapshots().find((item) => item.scenario === scenario && item.view === view) as RenderedSnapshot;
const withElements = (snapshot: RenderedSnapshot, more: readonly RenderedElement[], patch: Partial<RenderedSnapshot> = {}): RenderedSnapshot => ({ ...snapshot, ...patch, elements: [...snapshot.elements, ...more] });
const draw = (lens: "targets" | "first-view", snapshot: RenderedSnapshot, view: View) => lensDrawing(lens, viewFacts(nook, view, snapshot), snapshot, view);
const of = <K extends LensShape["kind"]>(shapes: readonly LensShape[], kind: K) => shapes.filter((shape): shape is Extract<LensShape, { kind: K }> => shape.kind === kind);

describe("the lenses", () => {
  it("are two, one at a time: tap targets and first view", () => {
    expect(LENSES.map((lens) => lens.id)).toEqual(["targets", "first-view"]);
  });
});

describe("the tap-target lens", () => {
  it("draws every control quietly on a page that passes, and says so", () => {
    const snapshot = snapshotOf("lantern-open", "desktop");
    const drawing = draw("targets", snapshot, desktop);
    const controls = snapshot.elements.filter((element) => element.visible && element.interactive);
    expect(of(drawing.shapes, "box").map((box) => box.tone)).toEqual(controls.map(() => "quiet"));
    expect(of(drawing.shapes, "circle")).toEqual([]);
    expect(drawing).toMatchObject({ tone: "ok", words: "4 controls, all 24 px or more.", below: 0 });
  });

  it("gives each control core fails a solid box, its hatched circle and its size, and leaves the rest quiet", () => {
    const base = snapshotOf("rooms-list", "desktop");
    const snapshot = withElements(base, [button("A", { x: 280, y: 600, width: 11, height: 20 }), button("B", { x: 293, y: 600, width: 10, height: 20 })]);
    const drawing = draw("targets", snapshot, desktop);
    const boxes = of(drawing.shapes, "box");
    expect(boxes.filter((box) => box.tone === "fail").map((box) => box.rect.width)).toEqual([11, 10]);
    expect(boxes.filter((box) => box.tone === "quiet")).toHaveLength(2);
    expect(of(drawing.shapes, "circle")).toEqual([
      { kind: "circle", cx: 285.5, cy: 610, r: 12 },
      { kind: "circle", cx: 298, cy: 610, r: 12 },
    ]);
    expect(of(drawing.shapes, "label").map((label) => label.text)).toEqual(["A · 11 × 20", "B · 10 × 20"]);
    expect(drawing).toMatchObject({ tone: "fail", words: "2 of 4 controls are under 24 px and too close to another." });
  });

  it("lists a cluster's sizes beside it, never over it: both labels start past the cluster's far edge", () => {
    const snapshot = withElements(snapshotOf("rooms-list", "desktop"), [button("A", { x: 280, y: 600, width: 11, height: 20 }), button("B", { x: 293, y: 600, width: 10, height: 20 })]);
    const labels = of(draw("targets", snapshot, desktop).shapes, "label");
    // The cluster runs from A's circle to B's circle: 273.5 to 310.
    expect(labels.map((label) => [label.x, label.flip, label.side])).toEqual([[310, 273.5, "beside"], [310, 273.5, "beside"]]);
  });

  it("an undersized control clear of the rest stays quiet, and the words say it is there", () => {
    const snapshot = withElements(snapshotOf("rooms-list", "desktop"), [button("Lone", { x: 1000, y: 700, width: 12, height: 12 })]);
    const drawing = draw("targets", snapshot, desktop);
    expect(of(drawing.shapes, "circle")).toEqual([]);
    expect(drawing).toMatchObject({ tone: "ok", words: "3 controls, none too small and too close. 1 is under 24 px but clear of the rest." });
  });

  it("says when a page has no controls, and when the project has no target-size rule", () => {
    const empty = { ...snapshotOf("rooms-list", "desktop"), elements: [] };
    expect(draw("targets", empty, desktop)).toMatchObject({ tone: "none", words: "No controls on this page.", shapes: [] });
    const none = lensDrawing("targets", viewFacts({ ...nook, rules: [] }, desktop, empty), empty, desktop);
    expect(none).toMatchObject({ tone: "none", shapes: [] });
  });
});

describe("the first-view lens", () => {
  it("on a page that fits: the fold and the view's edge, quiet, and nothing under the artboard", () => {
    const snapshot = { ...snapshotOf("lantern-open", "phone"), scrollHeight: 844 };
    const drawing = draw("first-view", snapshot, phone);
    expect(of(drawing.shapes, "line")).toEqual([
      { kind: "line", axis: "y", at: 844, tone: "quiet" },
      { kind: "line", axis: "x", at: 390, tone: "quiet" },
    ]);
    expect(of(drawing.shapes, "ghost")).toEqual([]);
    expect(of(drawing.shapes, "strip")).toEqual([]);
    expect(drawing).toMatchObject({ tone: "ok", below: 0, words: '"Book room" is in the first view. The whole page fits it.' });
  });

  it("an action below the fold: the fold fails, and the action is a marked ghost where it was measured", () => {
    const base = snapshotOf("lantern-open", "phone");
    const snapshot: RenderedSnapshot = { ...base, scrollHeight: 960, elements: base.elements.map((element) => (element.name === "Book room" ? button("Book room", { ...element.rect, y: 900 }, true) : element)) };
    const drawing = draw("first-view", snapshot, phone);
    expect(of(drawing.shapes, "line")[0]).toEqual({ kind: "line", axis: "y", at: 844, tone: "fail" });
    expect(of(drawing.shapes, "ghost")).toEqual([{ kind: "ghost", rect: { x: 16, y: 900, width: 358, height: 44 }, tone: "fail" }]);
    expect(of(drawing.shapes, "label").map((label) => [label.text, label.tone, label.layer])).toEqual([["Book room", "fail", "ghost"], ["First view ends · 844 px", "fail", "page"]]);
    expect(drawing).toMatchObject({ tone: "fail", below: 116, words: '"Book room" ends 100 px below the first view. The page runs 116 px past it.' });
  });

  it("only the part of a box below the fold is a ghost, and the ghost stops after one more view", () => {
    const base = snapshotOf("rooms-list", "phone");
    const snapshot = withElements(base, [text("Straddles", { x: 16, y: 824, width: 100, height: 40 }), text("Far down", { x: 16, y: 3000, width: 100, height: 24 })], { scrollHeight: 4000 });
    const drawing = draw("first-view", snapshot, phone);
    expect(of(drawing.shapes, "ghost")).toEqual([{ kind: "ghost", rect: { x: 16, y: 844, width: 100, height: 20 }, tone: "quiet" }]);
    expect(drawing.below).toBe(844);
    expect(drawing.words).toBe('"Book room" is not on this page. The page runs 3156 px past it.');
  });

  it("a page wider than the view: the edge fails, with a strip as wide as it runs past and what crosses the edge", () => {
    const base = snapshotOf("rooms-list", "phone");
    const snapshot = withElements(base, [text("A very long line", { x: 16, y: 300, width: 500, height: 24 })], { scrollWidth: 516, scrollHeight: 844 });
    const drawing = draw("first-view", snapshot, phone);
    expect(of(drawing.shapes, "line")[1]).toEqual({ kind: "line", axis: "x", at: 390, tone: "fail" });
    expect(of(drawing.shapes, "strip")).toEqual([{ kind: "strip", rect: { x: 390, y: 0, width: 126, height: 844 } }]);
    expect(of(drawing.shapes, "box")).toEqual([{ kind: "box", rect: { x: 16, y: 300, width: 500, height: 24 }, tone: "fail" }]);
    expect(of(drawing.shapes, "label").map((label) => label.text)).toContain("+126 px");
    expect(drawing).toMatchObject({ tone: "fail", words: '"Book room" is not on this page. The page is 126 px wider than the view.' });
  });
});

describe("placing a lens on an artboard", () => {
  const failing = () => {
    const snapshot = withElements(snapshotOf("rooms-list", "desktop"), [button("A", { x: 280, y: 600, width: 11, height: 20 }), button("B", { x: 293, y: 600, width: 10, height: 20 })]);
    return draw("targets", snapshot, desktop);
  };

  it("scales the shapes with the artboard and keeps the labels their own size", () => {
    const half = placeLens(failing(), desktop, 0.5);
    const full = placeLens(failing(), desktop, 1);
    expect(half).toMatchObject({ width: 640, height: 450, below: 0, beside: 0 });
    const box = (placed: typeof half) => placed.shapes.find((shape) => shape.kind === "box" && shape.tone === "fail");
    expect(box(half)).toMatchObject({ rect: { x: 140, y: 300, width: 5.5, height: 10 } });
    expect(box(full)).toMatchObject({ rect: { x: 280, y: 600, width: 11, height: 20 } });
    expect(half.labels.map((label) => label.height)).toEqual([LABEL.height, LABEL.height]);
    expect(half.labels.map((label) => label.width)).toEqual(full.labels.map((label) => label.width));
  });

  it("never lets two labels overlap: the second steps down under the first", () => {
    for (const scale of [0.25, 0.47, 1]) {
      const [first, second] = placeLens(failing(), desktop, scale).labels;
      if (!first || !second) throw new Error("two labels");
      expect(second.x).toBe(first.x);
      expect(second.y).toBeGreaterThanOrEqual(first.y + first.height);
    }
  });

  it("puts a cluster's labels after it, or before it when there is no room after", () => {
    const [label] = placeLens(failing(), desktop, 1).labels;
    expect(label?.x).toBe(315);
    const atEdge = withElements(snapshotOf("rooms-list", "phone"), [button("A", { x: 350, y: 600, width: 11, height: 20 }), button("B", { x: 363, y: 600, width: 10, height: 20 })]);
    const [flipped] = placeLens(draw("targets", atEdge, phone), phone, 1).labels;
    if (!flipped) throw new Error("a label");
    expect(flipped.x + flipped.width).toBeLessThanOrEqual(343.5);
  });

  it("keeps a gutter between the artboard and the ghost, names the first view's end there, and makes room for it", () => {
    const base = snapshotOf("lantern-open", "phone");
    const snapshot: RenderedSnapshot = { ...base, scrollHeight: 960, elements: base.elements.map((element) => (element.name === "Book room" ? button("Book room", { ...element.rect, y: 900 }, true) : element)) };
    const placed = placeLens(draw("first-view", snapshot, phone), phone, 0.5);
    expect(placed.gutter).toBe(GHOST_GUTTER);
    expect(placed.below).toBe(116 * 0.5 + GHOST_GUTTER);
    const ghost = placed.shapes.find((shape) => shape.kind === "ghost");
    expect(ghost).toMatchObject({ rect: { y: 450 + GHOST_GUTTER } });
    const fold = placed.labels.find((label) => label.text.startsWith("First view ends"));
    expect(fold?.y).toBeGreaterThanOrEqual(422);
    expect((fold?.y ?? 0) + LABEL.height).toBeLessThanOrEqual(422 + GHOST_GUTTER);
    // On a page that fits, the name still gets its row under the artboard.
    const fits = placeLens(draw("first-view", { ...base, scrollHeight: 844 }, phone), phone, 0.5);
    expect(fits.gutter).toBe(0);
    expect(fits.below).toBeGreaterThanOrEqual(LABEL.height);
  });

  it("draws the overflow strip no wider than its mark, however far the page runs", () => {
    const snapshot = { ...snapshotOf("rooms-list", "phone"), scrollWidth: 1200, scrollHeight: 844 };
    const placed = placeLens(draw("first-view", snapshot, phone), phone, 1);
    expect(placed.beside).toBe(STRIP_MAX_PX);
    expect(placed.shapes.find((shape) => shape.kind === "strip")).toMatchObject({ rect: { x: 390, width: STRIP_MAX_PX } });
    const narrow = placeLens(draw("first-view", { ...snapshot, scrollWidth: 400 }, phone), phone, 1);
    expect(narrow.beside).toBe(10);
  });

  it("is the same placement for the same drawing and zoom", () => {
    expect(placeLens(failing(), desktop, 0.47)).toEqual(placeLens(failing(), desktop, 0.47));
  });
});
