import type { BoxWithNeighbourEvidence, Rect, RegionLineEvidence, RouteVsBudgetEvidence, SequenceGapEvidence } from "@design-harness/core";

/**
 * The geometry of the evidence figures: pure functions from core's evidence
 * to boxes, lines and rows in a figure's own units. Nothing here decides
 * anything: every number comes from the evidence, and a figure is a
 * schematic of measured boxes, never the page's pixels.
 */

export type Size = { readonly width: number; readonly height: number };
export type Circle = { readonly cx: number; readonly cy: number; readonly r: number };

const round = (value: number) => Math.round(value * 100) / 100;

/** The scales a magnified figure may be shown at, largest first, so its caption can say "Shown at 4×". */
const SCALES = [8, 6, 5, 4, 3, 2, 1.5, 1, 0.75, 0.5, 0.25, 0.1] as const;

/** The largest of the fixed scales at which `content` fits `room`. */
export function fitScale(content: Size, room: Size): number {
  const most = Math.min(room.width / Math.max(1, content.width), room.height / Math.max(1, content.height));
  return SCALES.find((scale) => scale <= most) ?? most;
}

export type BoxFigure = {
  readonly size: Size;
  /** How many figure units one CSS px is. */
  readonly scale: number;
  /** The control, and the circle the spacing exception gives it. */
  readonly box: Rect;
  readonly circle: Circle;
  /** The neighbour the circle meets, cut to the figure, and its own circle when both are undersized. */
  readonly neighbour?: { readonly box: Rect; readonly name: string; readonly cut: boolean; readonly circle?: Circle };
  /** The control's measured width and height, in CSS px, for the dimension lines. */
  readonly measured: Size;
  readonly min: number;
};

/**
 * A small control at scale: its box in the middle, its circle of diameter
 * `min`, and the neighbour that circle meets. The window is the circle with
 * a margin of half the minimum each way, so a wide neighbour is cut rather
 * than shrinking the control to a dot.
 */
export function boxFigure(evidence: BoxWithNeighbourEvidence, size: Size = { width: 280, height: 170 }): BoxFigure {
  const { box, min, neighbour } = evidence;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const halfWidth = Math.max(box.width / 2, min / 2) + min * 0.75;
  const halfHeight = Math.max(box.height / 2, min / 2) + min * 0.25;
  // Room at the top and the bottom for the names and the dimension lines.
  const gutter = 26;
  const scale = fitScale({ width: halfWidth * 2, height: halfHeight * 2 }, { width: size.width - gutter, height: size.height - gutter });
  const window: Rect = { x: cx - size.width / scale / 2, y: cy - (size.height - gutter) / scale / 2, width: size.width / scale, height: (size.height - gutter) / scale };
  const place = (rect: Rect): Rect => ({ x: round((rect.x - window.x) * scale), y: round(gutter / 2 + (rect.y - window.y) * scale), width: round(rect.width * scale), height: round(rect.height * scale) });
  const cut = (rect: Rect): { box: Rect; cut: boolean } => {
    const x1 = Math.max(rect.x, window.x);
    const y1 = Math.max(rect.y, window.y);
    const x2 = Math.min(rect.x + rect.width, window.x + window.width);
    const y2 = Math.min(rect.y + rect.height, window.y + window.height);
    const inside = { x: x1, y: y1, width: Math.max(0, x2 - x1), height: Math.max(0, y2 - y1) };
    return { box: place(inside), cut: inside.width < rect.width - 0.01 || inside.height < rect.height - 0.01 };
  };
  const placed = place(box);
  const circleOf = (rect: Rect): Circle => ({ cx: round((rect.x + rect.width / 2 - window.x) * scale), cy: round(gutter / 2 + (rect.y + rect.height / 2 - window.y) * scale), r: round((min / 2) * scale) });
  return {
    size,
    scale,
    box: placed,
    circle: circleOf(box),
    ...(neighbour ? { neighbour: { ...cut(neighbour.box), name: neighbour.name || neighbour.role, ...(neighbour.meets === "circles-meet" ? { circle: circleOf(neighbour.box) } : {}) } } : {}),
    measured: { width: Math.round(box.width), height: Math.round(box.height) },
    min,
  };
}

export type OutlineRow =
  | { readonly kind: "heading"; readonly level: number; readonly text: string; readonly shown: boolean; readonly flag?: string }
  /** A level the outline skips: an empty row where a heading would be. */
  | { readonly kind: "gap"; readonly level: number }
  /** Headings left out of a long outline. */
  | { readonly kind: "more"; readonly count: number };

const FLAGS: Readonly<Record<SequenceGapEvidence["problem"], string>> = {
  skipped: "skips a level",
  "second-first": "a second h1",
  "before-first": "before the title",
  "no-first": "no h1",
};

/**
 * The heading outline as rows: each heading at its level, an empty row for
 * each level skipped just above the heading that skips it, and a first empty
 * row when the page has no title. A long outline keeps the rows around the
 * problem and says how many it left out.
 */
export function outlineRows(evidence: SequenceGapEvidence, most = 8): OutlineRow[] {
  const rows: OutlineRow[] = [];
  if (evidence.problem === "no-first") rows.push({ kind: "gap", level: 1 });
  evidence.items.forEach((item, index) => {
    const here = index === evidence.at;
    if (here && evidence.problem === "skipped") for (const level of evidence.missing ?? []) rows.push({ kind: "gap", level });
    rows.push({ kind: "heading", level: item.level, text: item.text, shown: item.shown, ...(here ? { flag: FLAGS[evidence.problem] } : {}) });
  });
  if (rows.length <= most) return rows;
  // Keep the rows around the flagged one (or the top, when nothing is flagged), and the title.
  const flagged = Math.max(0, rows.findIndex((row) => row.kind === "heading" && row.flag !== undefined));
  const start = Math.max(1, Math.min(flagged - Math.floor(most / 2), rows.length - (most - 1)));
  const end = Math.min(rows.length, start + most - 1);
  const out: OutlineRow[] = [rows[0] as OutlineRow];
  if (start > 1) out.push({ kind: "more", count: start - 1 });
  out.push(...rows.slice(start, end));
  if (end < rows.length) out.push({ kind: "more", count: rows.length - end });
  return out;
}

export type RegionFigure = {
  readonly size: Size;
  readonly scale: number;
  /** The part of the page the figure shows, in the page's CSS px. */
  readonly window: Rect;
  /** True when the window is a close-up, not the whole page or view. */
  readonly closeUp: boolean;
  /** The page as far as the window shows it, and the part of it the first view shows. */
  readonly page: Rect;
  readonly view: Rect;
  /** The fold or the view's edge. */
  readonly line: { readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number };
  /** What lies past the line: the part of the page below the fold, or the strip wider than the view. */
  readonly past: Rect;
  /** The element the finding is about. */
  readonly box?: Rect;
  /** How far past the line, in CSS px: the element's end below the fold, or the page's width past the edge. */
  readonly by: number;
};

const intersect = (a: Rect, b: Rect): Rect => {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return { x, y, width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x), height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y) };
};

/**
 * A page with a line across it. Down the page (`y`): the foot of the first
 * view and what was measured below it, close up around the element the
 * finding is about so it is large enough to see, or the whole page with
 * `closeUp` off. Across (`x`): the first view and the strip that runs past
 * its edge. `labels` is the room kept at the end side for the words.
 */
export function regionFigure(evidence: RegionLineEvidence, size: Size = { width: 280, height: 150 }, options: { readonly closeUp?: boolean; readonly labels?: number } = {}): RegionFigure {
  const { axis, line, from, to, view, box } = evidence;
  const margin = 8;
  const labels = options.labels ?? (axis === "y" ? 112 : 64);
  const foot = axis === "x" ? 14 : 0;
  const pageWidth = axis === "x" ? Math.max(to, view.width) : view.width;
  const pageHeight = axis === "y" ? Math.max(evidence.pageHeight ?? 0, to, view.height) : view.height;
  const whole: Rect = { x: 0, y: 0, width: pageWidth, height: pageHeight };
  const closeUp = axis === "y" && box !== undefined && (options.closeUp ?? true);
  let window = whole;
  if (closeUp && box) {
    const above = Math.max(2 * (to - line), view.height * 0.2);
    const beside = box.width * 0.6 + 60;
    window = intersect(whole, { x: box.x - beside, y: line - above, width: box.width + beside * 2, height: above + (to - line) + 40 });
  }
  const room = { width: size.width - margin * 2 - labels, height: size.height - margin * 2 - foot };
  const scale = Math.min(room.width / window.width, room.height / window.height);
  const left = axis === "x" ? margin + (room.width - window.width * scale) / 2 : margin;
  const place = (rect: Rect): Rect => {
    const shown = intersect(rect, window);
    return { x: round(left + (shown.x - window.x) * scale), y: round(margin + (shown.y - window.y) * scale), width: round(shown.width * scale), height: round(shown.height * scale) };
  };
  const page = place(whole);
  const lineY = round(margin + (line - window.y) * scale);
  const lineX = round(left + (line - window.x) * scale);
  return {
    size,
    scale: round(scale),
    window,
    closeUp,
    page,
    view: place({ x: 0, y: 0, width: axis === "x" ? Math.min(view.width, line) : view.width, height: view.height }),
    line: axis === "y" ? { x1: page.x - 4, y1: lineY, x2: page.x + page.width + 4, y2: lineY } : { x1: lineX, y1: page.y - 4, x2: lineX, y2: page.y + page.height + 4 },
    past: axis === "y" ? place({ x: 0, y: line, width: pageWidth, height: pageHeight - line }) : place({ x: line, y: 0, width: pageWidth - line, height: pageHeight }),
    ...(box ? { box: place(box) } : {}),
    by: Math.round(to - (axis === "y" ? line : from)),
  };
}

export type RouteStep = { readonly number: number; readonly from: string; readonly event: string; readonly to: string; readonly over: boolean };

/** A route's steps numbered from 1, each marked when it is past the budget. */
export function routeSteps(evidence: Pick<RouteVsBudgetEvidence, "route" | "budget">): RouteStep[] {
  return evidence.route.map((step, index) => ({ number: index + 1, from: step.from, event: step.event, to: step.to, over: index + 1 > evidence.budget }));
}
