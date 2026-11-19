import type { Rect, RenderedElement, Rgba, TextPaint } from "./types";

/**
 * The arithmetic behind the rendered rules, ported from agent-design-loop's
 * lib/rendered-page.ts and check-target-size.ts: heading outline, WCAG
 * contrast, and the WCAG 2.5.8 target-size spacing exception.
 */

/** WCAG 2.2 AA, 1.4.3: normal text, and large text (24 CSS px, or 18.66 CSS px and bold). */
export const AA_NORMAL = 4.5;
export const AA_LARGE = 3;

export type Heading = { readonly text: string; readonly level: number; readonly shown: boolean };

/** One outline problem, with the index of the heading it is about, when it is about one. */
export type HeadingProblem = {
  readonly message: string;
  readonly index?: number;
  /** What is wrong, for a picture of the outline. */
  readonly problem: "skipped" | "second-first" | "before-first" | "no-first";
  /** For a skipped level: the index of the heading it follows, and the levels left out. */
  readonly after?: number;
  readonly missing?: readonly number[];
};

/** The page's heading outline problems: one visible h1 first, no second h1, no level skipped going down. */
export function headingProblems(headings: readonly Heading[]): HeadingProblem[] {
  const titleIndex = headings.findIndex((heading) => heading.level === 1 && heading.shown);
  const title = headings[titleIndex];
  if (!title) return [{ message: "The page has no visible title: it needs one h1, and the other headings sit under it.", problem: "no-first" }];
  const problems: HeadingProblem[] = [];
  let previous = title;
  let previousIndex = titleIndex;
  headings.forEach((heading, index) => {
    if (index === titleIndex) return;
    const name = `h${heading.level} "${heading.text}"`;
    if (heading.level === 1) {
      problems.push({ message: `${name} is a second h1. A page has one h1, its title "${title.text}".`, index, problem: "second-first" });
    } else if (index < titleIndex) {
      problems.push({ message: `${name} comes before the title "${title.text}". The title is the page's first heading.`, index, problem: "before-first" });
      return;
    } else if (heading.level > previous.level + 1) {
      problems.push({ message: `${name} skips a level: it follows h${previous.level} "${previous.text}", so it is h${Math.min(previous.level + 1, 6)} or a level above.`, index, problem: "skipped", after: previousIndex, missing: Array.from({ length: heading.level - previous.level - 1 }, (_, step) => previous.level + 1 + step) });
    }
    previous = heading;
    previousIndex = index;
  });
  return problems;
}

/** `top` painted over an opaque `bottom`. */
export function over(top: Rgba, bottom: Rgba): Rgba {
  const alpha = top[3];
  const mix = (a: number, b: number) => a * alpha + b * (1 - alpha);
  return [mix(top[0], bottom[0]), mix(top[1], bottom[1]), mix(top[2], bottom[2]), 1];
}

export function luminance(color: Rgba): number {
  const [r, g, b] = [color[0], color[1], color[2]].map((value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: Rgba, b: Rgba): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

export function isLargeText(px: number, weight: number): boolean {
  return px >= 24 - 0.01 || (px >= 18.66 && weight >= 700);
}

/** The ratio a run of text reaches over its backgrounds and the canvas, and the ratio it needs. */
export function textContrast(text: TextPaint, canvas: Rgba): { ratio: number; needs: number; foreground: Rgba; background: Rgba } {
  let background = canvas;
  for (const layer of [...text.backgrounds].reverse()) background = over(layer, background);
  const foreground = over(text.color, background);
  return { ratio: contrast(foreground, background), needs: isLargeText(text.px, text.weight) ? AA_LARGE : AA_NORMAL, foreground, background };
}

export function hex(color: Rgba): string {
  return `#${[color[0], color[1], color[2]].map((value) => Math.round(value).toString(16).padStart(2, "0")).join("")}`;
}

function circleHitsRect(cx: number, cy: number, radius: number, rect: Rect): boolean {
  const nx = Math.max(rect.x, Math.min(cx, rect.x + rect.width));
  const ny = Math.max(rect.y, Math.min(cy, rect.y + rect.height));
  return Math.hypot(cx - nx, cy - ny) < radius;
}

/**
 * WCAG 2.5.8: a target smaller than `min` passes when a circle of diameter
 * `min` centred on it meets no other target, nor the circle of another
 * undersized target.
 */
export function failsSpacing(target: RenderedElement, others: readonly RenderedElement[], min: number): boolean {
  return spacingNeighbour(target, others, min) !== null;
}

/**
 * The first of `others`, in the order given, that breaks the spacing
 * exception for `target`, and how: the target's circle reaches its box
 * (`in-circle`), or both are undersized and their circles overlap
 * (`circles-meet`). Null when the exception holds. `failsSpacing` is exactly
 * "this is not null", so a picture of the neighbour and the verdict cannot
 * disagree.
 */
export function spacingNeighbour(target: RenderedElement, others: readonly RenderedElement[], min: number): { readonly index: number; readonly meets: "in-circle" | "circles-meet" } | null {
  const cx = target.rect.x + target.rect.width / 2;
  const cy = target.rect.y + target.rect.height / 2;
  for (const [index, other] of others.entries()) {
    if (other === target) continue;
    if (circleHitsRect(cx, cy, min / 2, other.rect)) return { index, meets: "in-circle" };
    const undersized = other.rect.width < min || other.rect.height < min;
    const ox = other.rect.x + other.rect.width / 2;
    const oy = other.rect.y + other.rect.height / 2;
    if (undersized && Math.hypot(cx - ox, cy - oy) < min) return { index, meets: "circles-meet" };
  }
  return null;
}
