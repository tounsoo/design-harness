import type { Rect, RenderedSnapshot, View, ViewFacts } from "@design-harness/core";

/**
 * Lenses: one family of rules drawn on every artboard at once, passing
 * parts included. Each lens turns core's facts for a view (`viewFacts`)
 * into shapes in the page's own CSS px and one line of words; `placeLens`
 * then scales the shapes to the artboard on screen and keeps the labels
 * apart. Core decided every verdict the shapes show: nothing here measures
 * or judges, and the words say what the shapes say.
 */

export const LENSES = [
  { id: "targets", label: "Tap targets", hint: "Every control's hit area, and the ones too small and too close" },
  { id: "first-view", label: "First view", hint: "Where the first screen ends, what lies below it, and the view's edge" },
] as const;
export type LensId = (typeof LENSES)[number]["id"];

export type LensShape =
  /** A hit area or a crossing element: quiet and dashed when it passes, solid when it fails. */
  | { readonly kind: "box"; readonly rect: Rect; readonly tone: "quiet" | "fail" }
  /** The circle the spacing exception gives an undersized control, hatched. */
  | { readonly kind: "circle"; readonly cx: number; readonly cy: number; readonly r: number }
  /** A guide across the artboard: the end of the first view, or the view's edge. */
  | { readonly kind: "line"; readonly axis: "x" | "y"; readonly at: number; readonly tone: "quiet" | "fail" }
  /** A box measured below the first view, drawn under the artboard. */
  | { readonly kind: "ghost"; readonly rect: Rect; readonly tone: "quiet" | "fail" | "control" }
  /** The strip the page runs past the view's edge by, hatched. */
  | { readonly kind: "strip"; readonly rect: Rect }
  | { readonly kind: "label"; readonly x: number; readonly y: number; readonly text: string; readonly tone: "quiet" | "fail"; readonly anchor: "start" | "end"; readonly side: "above" | "below" | "beside"; /** For `beside`: where the label goes instead, with its end here, when it does not fit after `x`. */ readonly flip?: number; /** `page`: it moves with the page when the frame scrolls. `fixed`: it belongs to the view's edge. `ghost`: it belongs to a box drawn under the artboard. */ readonly layer: "page" | "fixed" | "ghost" };

export type LensDrawing = {
  /** In the page's CSS px. */
  readonly shapes: readonly LensShape[];
  /** One line saying what the shapes say. */
  readonly words: string;
  readonly tone: "ok" | "fail" | "none";
  /** How far below the first view the ghost runs, in CSS px: the room to keep under the artboard. */
  readonly below: number;
};

const px = (value: number) => Math.round(value);
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export function lensDrawing(lens: LensId, facts: ViewFacts, snapshot: RenderedSnapshot, view: View): LensDrawing {
  return lens === "targets" ? targetsLens(facts, snapshot) : firstViewLens(facts, snapshot, view);
}

function targetsLens(facts: ViewFacts, snapshot: RenderedSnapshot): LensDrawing {
  const targets = facts.targets;
  if (!targets) return { shapes: [], words: "The project has no target-size rule, so no hit area is judged.", tone: "none", below: 0 };
  const { min, controls } = targets;
  const shapes: LensShape[] = [];
  let fails = 0;
  let spaced = 0;
  // Failing controls that meet each other are one cluster: their sizes are listed beside it, never over it.
  const cluster = new Map<number, number>();
  const rootOf = (index: number): number => {
    let at = index;
    while (cluster.get(at) !== undefined && cluster.get(at) !== at) at = cluster.get(at) as number;
    return at;
  };
  for (const control of controls) if (control.status === "fails") cluster.set(control.element, control.element);
  for (const control of controls) {
    const other = control.neighbour?.element;
    if (control.status === "fails" && other !== undefined && cluster.has(other)) cluster.set(rootOf(control.element), rootOf(other));
  }
  const bounds = new Map<number, { left: number; right: number; top: number }>();
  for (const control of controls) {
    const rect = snapshot.elements[control.element]?.rect;
    if (control.status !== "fails" || !rect) continue;
    const root = rootOf(control.element);
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    const now = bounds.get(root);
    bounds.set(root, { left: Math.min(now?.left ?? Infinity, cx - min / 2, rect.x), right: Math.max(now?.right ?? -Infinity, cx + min / 2, rect.x + rect.width), top: Math.min(now?.top ?? Infinity, cy - min / 2, rect.y) });
  }
  for (const control of controls) {
    const element = snapshot.elements[control.element];
    if (!element) continue;
    const rect = element.rect;
    if (control.status === "fails") {
      fails += 1;
      const around = bounds.get(rootOf(control.element)) ?? { left: rect.x, right: rect.x + rect.width, top: rect.y };
      shapes.push({ kind: "circle", cx: rect.x + rect.width / 2, cy: rect.y + rect.height / 2, r: min / 2 });
      shapes.push({ kind: "box", rect, tone: "fail" });
      shapes.push({ kind: "label", x: around.right, y: around.top, flip: around.left, text: `${element.name ? `${element.name.slice(0, 12)} · ` : ""}${px(rect.width)} × ${px(rect.height)}`, tone: "fail", anchor: "start", side: "beside", layer: "page" });
    } else {
      if (control.status === "spaced") spaced += 1;
      shapes.push({ kind: "box", rect, tone: "quiet" });
    }
  }
  const count = controls.length;
  if (count === 0) return { shapes, words: "No controls on this page.", tone: "none", below: 0 };
  const also = spaced > 0 ? ` ${plural(spaced, "is", "are")} under ${min} px but clear of the rest.` : "";
  if (fails > 0) return { shapes, words: `${fails} of ${plural(count, "control", "controls")} ${fails === 1 ? "is" : "are"} under ${min} px and too close to another.${also}`, tone: "fail", below: 0 };
  return { shapes, words: spaced > 0 ? `${plural(count, "control", "controls")}, none too small and too close.${also}` : `${plural(count, "control", "controls")}, ${count === 1 ? "at least" : "all"} ${min} px or more.`, tone: "ok", below: 0 };
}

/** The ghost under an artboard never runs further than this many first views, however long the page. */
export const GHOST_VIEWS = 1;

function firstViewLens(facts: ViewFacts, snapshot: RenderedSnapshot, view: View): LensDrawing {
  const { fold, edge } = facts;
  const shapes: LensShape[] = [];
  const action = fold.action;
  const belowAction = new Set((action?.controls ?? []).filter((control) => control.below).map((control) => control.element));
  const lowest = Math.max(fold.pageHeight ?? 0, ...fold.below.map((index) => (snapshot.elements[index]?.rect.y ?? 0) + (snapshot.elements[index]?.rect.height ?? 0)));
  const runsPast = Math.max(0, lowest - fold.line);
  const below = Math.min(runsPast, view.height * GHOST_VIEWS);
  for (const index of fold.below) {
    const element = snapshot.elements[index];
    if (!element || element.rect.y >= fold.line + below) continue;
    // Only the part below the fold is a ghost; what is above it is on the artboard already.
    const top = Math.max(element.rect.y, fold.line);
    const rect = { x: element.rect.x, y: top, width: element.rect.width, height: Math.min(element.rect.y + element.rect.height, fold.line + below) - top };
    if (rect.height <= 0 || rect.width <= 0) continue;
    shapes.push({ kind: "ghost", rect, tone: belowAction.has(index) ? "fail" : element.interactive ? "control" : "quiet" });
    if (belowAction.has(index)) shapes.push({ kind: "label", x: rect.x + rect.width, y: rect.y, flip: rect.x, text: action?.name ?? "", tone: "fail", anchor: "start", side: "beside", layer: "ghost" });
  }
  const actionFails = belowAction.size > 0;
  shapes.push({ kind: "line", axis: "y", at: fold.line, tone: actionFails ? "fail" : "quiet" });
  // Under the line, in the room below the artboard, so it never covers the page.
  shapes.push({ kind: "label", x: 0, y: fold.line, text: `First view ends · ${px(fold.line)} px`, tone: actionFails ? "fail" : "quiet", anchor: "start", side: "below", layer: "page" });
  const wide = edge.overflow > 0;
  shapes.push({ kind: "line", axis: "x", at: edge.line, tone: wide ? "fail" : "quiet" });
  if (wide) {
    shapes.push({ kind: "strip", rect: { x: edge.line, y: 0, width: edge.overflow, height: view.height } });
    for (const index of edge.crossing) {
      const element = snapshot.elements[index];
      if (element && element.rect.y < view.height) shapes.push({ kind: "box", rect: element.rect, tone: "fail" });
    }
    shapes.push({ kind: "label", x: edge.line + edge.overflow, y: 0, text: `+${px(edge.overflow)} px`, tone: "fail", anchor: "end", side: "below", layer: "fixed" });
  }

  // One line: the action first; then how far the page runs, or, when it is too wide, that instead.
  const words: string[] = [];
  if (action) {
    const quoted = `"${action.name}"`;
    if (action.controls.length === 0) words.push(`${quoted} is not on this page.`);
    else if (actionFails) {
      const lowestAction = Math.max(...action.controls.filter((control) => control.below).map((control) => control.box.y + control.box.height));
      words.push(`${quoted} ends ${px(lowestAction - fold.line)} px below the first view.`);
    } else words.push(`${quoted} is in the first view.`);
  }
  if (wide) words.push(`The page is ${px(edge.overflow)} px wider than the view.`);
  else if (runsPast > 0) words.push(`The page runs ${px(runsPast)} px past ${action ? "it" : "the first view"}.`);
  else words.push(action ? "The whole page fits it." : "The whole page fits the first view.");
  return { shapes, words: words.join(" "), tone: actionFails || wide ? "fail" : "ok", below };
}

/** The most room the overflow strip takes beside an artboard, in screen px: it is a mark with its number, not to scale past this. */
export const STRIP_MAX_PX = 24;
/** The row kept between an artboard and the ghost under it, on screen: the first view's end is named there, over neither. */
export const GHOST_GUTTER = 22;
/** A label's size on screen, however the artboard is zoomed. */
export const LABEL = { height: 16, char: 6.1, padding: 5 } as const;

export type PlacedLabel = { readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly text: string; readonly tone: "quiet" | "fail"; readonly layer: "page" | "fixed" | "ghost" };
export type PlacedLens = {
  /** Shapes on the artboard, in screen px from its top left corner, before the page's scroll is applied. */
  readonly shapes: readonly Exclude<LensShape, { kind: "label" }>[];
  readonly labels: readonly PlacedLabel[];
  /** The artboard's size on screen, the ghost's height under it, and the strip's width beside it. */
  readonly width: number;
  readonly height: number;
  readonly below: number;
  readonly beside: number;
  /** The part of `below` between the artboard and the ghost. */
  readonly gutter: number;
};

const scaleRect = (rect: Rect, scale: number): Rect => ({ x: rect.x * scale, y: rect.y * scale, width: rect.width * scale, height: rect.height * scale });

/**
 * A drawing at the artboard's zoom: shapes scaled, labels at their fixed
 * size, each moved clear of the labels placed before it and kept inside the
 * layer. Labels are placed in the order given, top to bottom, so the same
 * drawing at the same zoom always places the same way.
 */
export function placeLens(drawing: LensDrawing, view: { readonly width: number; readonly height: number }, scale: number): PlacedLens {
  const width = view.width * scale;
  const height = view.height * scale;
  // What lies below the first view is drawn under a gutter, so the ghost starts clear of the artboard and of the fold's name.
  const gutter = drawing.below > 0 ? GHOST_GUTTER : 0;
  const below = drawing.below * scale + gutter;
  let beside = 0;
  const shapes: Exclude<LensShape, { kind: "label" }>[] = [];
  const wanted: Extract<LensShape, { kind: "label" }>[] = [];
  for (const shape of drawing.shapes) {
    switch (shape.kind) {
      case "label":
        wanted.push(shape);
        break;
      case "box":
        shapes.push({ ...shape, rect: scaleRect(shape.rect, scale) });
        break;
      case "ghost": {
        const rect = scaleRect(shape.rect, scale);
        shapes.push({ ...shape, rect: { ...rect, y: rect.y + gutter } });
        break;
      }
      case "strip": {
        const rect = scaleRect(shape.rect, scale);
        beside = Math.min(rect.width, STRIP_MAX_PX);
        shapes.push({ kind: "strip", rect: { ...rect, width: beside } });
        break;
      }
      case "circle":
        shapes.push({ kind: "circle", cx: shape.cx * scale, cy: shape.cy * scale, r: shape.r * scale });
        break;
      case "line":
        shapes.push({ ...shape, at: shape.at * scale });
        break;
    }
  }
  const labels: PlacedLabel[] = [];
  const sorted = wanted.map((label, index) => ({ label, index })).sort((a, b) => a.label.y - b.label.y || a.label.x - b.label.x || a.index - b.index);
  for (const { label } of sorted) {
    // A failing label carries a mark before its words.
    const w = Math.ceil((label.text.length + (label.tone === "fail" ? 2 : 0)) * LABEL.char + LABEL.padding * 2);
    let x = label.side === "beside" ? label.x * scale + 5 : label.anchor === "end" ? label.x * scale - w : label.x * scale;
    // Beside its cluster, on the other side when there is no room after it.
    if (label.side === "beside" && x + w > width && label.flip !== undefined && label.flip * scale - 5 - w >= 0) x = label.flip * scale - 5 - w;
    let y = (label.side === "above" ? label.y * scale - LABEL.height - 2 : label.side === "below" ? label.y * scale + 3 : label.y * scale) + (label.layer === "ghost" ? gutter : 0);
    x = Math.max(0, Math.min(x, Math.max(0, width + beside - w)));
    y = Math.max(0, y);
    // Step down past any label already there; a bounded walk, so a crowded artboard still places every label.
    for (let tries = 0; tries < 12 && labels.some((other) => x < other.x + other.width + 2 && other.x < x + w + 2 && y < other.y + other.height + 1 && other.y < y + LABEL.height + 1); tries += 1) y += LABEL.height + 2;
    labels.push({ x: Math.round(x), y: Math.round(y), width: w, height: LABEL.height, text: label.text, tone: label.tone, layer: label.layer });
  }
  // The room under the artboard holds the ghost and any label placed below the first view's end.
  const lowest = Math.max(0, ...labels.map((label) => label.y + label.height + 2 - height));
  return { shapes, labels, width, height, below: Math.max(below, lowest), beside, gutter };
}
