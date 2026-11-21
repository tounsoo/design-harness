import type { Prototype, Rect } from "@design-harness/core";

/**
 * What an example screen is about, and how its frame is placed so that part
 * is in view. Display only: it reads the boxes a frame already measured and
 * moves nothing inside the frame, so nothing core reads changes.
 */

/** A band of the page, top to bottom, in the page's CSS px. */
export type Band = { readonly top: number; readonly bottom: number };

/** The band that holds every box, or nothing for no boxes. Boxes with no size are left out: nothing was painted there. */
export function bandOf(boxes: readonly Rect[]): Band | undefined {
  const painted = boxes.filter((box) => box.width > 0 && box.height > 0);
  if (painted.length === 0) return undefined;
  return { top: Math.min(...painted.map((box) => box.y)), bottom: Math.max(...painted.map((box) => box.y + box.height)) };
}

/** One band over two, when both screens of a pair have a part to show. */
export function joinBands(a: Band | undefined, b: Band | undefined): Band | undefined {
  if (!a || !b) return a ?? b;
  return { top: Math.min(a.top, b.top), bottom: Math.max(a.bottom, b.bottom) };
}

/**
 * The spec elements an example adds or changes on a page: the keys of the
 * page's file whose element no prototype of the project has as it is. For an
 * example no rule flags, they are what it is about. The page's root is left
 * out, since a new child changes its slots and its box is the whole page.
 * With no prototype to compare with, or a file that is not a spec, nothing
 * is known to have changed.
 */
export function changedElements(prototype: Pick<Prototype, "files" | "pages">, baselines: readonly Readonly<Record<string, string>>[], page: string): readonly string[] {
  const file = prototype.pages.find((item) => item.id === page)?.component.file;
  if (file === undefined || baselines.length === 0) return [];
  const own = elementsOf(prototype.files[file]);
  if (!own) return [];
  const others = baselines.map((files) => elementsOf(files[file])?.elements ?? {});
  return Object.keys(own.elements).filter((key) => key !== own.root && !others.some((elements) => key in elements && JSON.stringify(elements[key]) === JSON.stringify(own.elements[key])));
}

function elementsOf(text: string | undefined): { readonly root: string | undefined; readonly elements: Readonly<Record<string, unknown>> } | null {
  if (text === undefined) return null;
  try {
    const spec: unknown = JSON.parse(text);
    if (typeof spec !== "object" || spec === null) return null;
    const { root, elements } = spec as { readonly root?: unknown; readonly elements?: unknown };
    if (typeof elements !== "object" || elements === null) return null;
    return { root: typeof root === "string" ? root : undefined, elements: elements as Readonly<Record<string, unknown>> };
  } catch {
    return null;
  }
}

/** Whether a tag a frame drew belongs to a spec element: its own key, or a part inside it (`details/summary`). */
export function tagWithin(tag: string, key: string): boolean {
  return tag === key || tag.startsWith(`${key}/`);
}

/**
 * How far down a stage is scrolled so the band is in view, in the stage's
 * own px. The page is drawn at `scale` under `padding`. A band that is in
 * view from the top of the page leaves the stage at the top, where the page
 * starts; otherwise the band is centred, or, when it is taller than the
 * stage, its top is shown. Both screens of a pair are given the same band,
 * so they stay side by side at the same place.
 */
export function stageScroll(band: Band | undefined, scale: number, stage: { readonly height: number; readonly padding: number }): number {
  if (!band || stage.height <= 0) return 0;
  const top = band.top * scale + stage.padding;
  const bottom = band.bottom * scale + stage.padding;
  if (bottom + stage.padding <= stage.height) return 0;
  if (bottom - top + 2 * stage.padding >= stage.height) return Math.max(0, Math.floor(top - stage.padding));
  return Math.max(0, Math.round((top + bottom) / 2 - stage.height / 2));
}
