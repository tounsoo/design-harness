import type { Finding, FindingTarget, Rect } from "@design-harness/core";
import type { FrameKey, FrameSpec, FrameState } from "./session";

/**
 * Element tags: how a frame knows which spec element each part of the page
 * it drew came from, so a finding about an element can be outlined where it
 * renders.
 *
 * A tag travels as one prop, `data-dh-source`, on the React element of a
 * library part or a page kit part: the spec renderer passes it to each part,
 * and its value is the element's key in the expanded page, which carries the
 * layout instance's scope (`details/summary`); a Page's slot is
 * `<page root>/slots/<name>`. Core gives the same key on each of a finding's
 * targets (`FindingTarget.key`).
 *
 * The frame never reads a tag from the DOM. After the page settles it walks
 * React's tree and gives each tag the outermost DOM elements of the
 * outermost part that carries it (`frame/tags.ts`), so whether a part passes
 * the prop on to the DOM, or renders several elements or none, changes
 * nothing, and an attribute written into the DOM by anyone else is ignored.
 */

export const TAG_PROP = "data-dh-source";

/** At most this many tags in one outline request, and this long each. */
export const MAX_OUTLINE_TAGS = 256;
export const MAX_TAG_LENGTH = 1024;
/** At most this many tags a frame reports as drawn. */
export const MAX_FRAME_TAGS = 20000;
/** At most this many boxes a frame reports for the tags it drew. */
export const MAX_FRAME_PLACES = 20000;

/**
 * Where a tag drew: the box of one DOM element a tagged part owns, in the
 * page's CSS px with the page at the top, as the snapshot's own boxes are.
 * A frame sends them with its snapshot, in tree order, so the app can tell
 * which part is under a point of the page without asking the frame, which
 * may be parked by then. No rule reads them and they are in no snapshot.
 */
export type TagPlace = { readonly tag: string; readonly rect: Rect };

/** The tag a frame draws a finding's target under: a spec element's key; none for an element no page draws. */
export function tagOf(target: FindingTarget): string | null {
  return target.key ?? null;
}

/** One frame to outline, and the tags of the finding's elements it drew. */
export type OutlineFrame = { readonly key: FrameKey; readonly tags: readonly string[] };

/**
 * Where a finding's elements are outlined: every measured frame of a
 * scenario on the element's page (any page, for an element read from the
 * source) that drew at least one of them, and the scenarios where they
 * should be and are not drawn, so the app can say so. `unmeasured` are
 * frames that could have drawn them but sent no snapshot. Null for a
 * finding with no targets, such as one about a whole page.
 */
export type OutlinePlan = {
  readonly frames: readonly OutlineFrame[];
  /** Scenarios that could show the finding's elements and drew none of them, in the board's order. */
  readonly missing: readonly string[];
  readonly unmeasured: readonly FrameKey[];
};

export function planOutline(finding: Finding, frames: readonly FrameSpec[], states: Readonly<Record<FrameKey, FrameState>>): OutlinePlan | null {
  const targets = finding.targets ?? [];
  if (targets.length === 0) return null;
  const out: OutlineFrame[] = [];
  const unmeasured: FrameKey[] = [];
  const shown = new Map<string, boolean>();
  for (const frame of frames) {
    if (finding.scenario !== undefined && frame.scenario.id !== finding.scenario) continue;
    if (finding.view !== undefined && frame.view.name !== finding.view) continue;
    const here = targets.filter((target) => target.page === undefined || target.page === frame.scenario.page);
    if (here.length === 0) continue;
    // A target no page draws has no tag: the frame could show it and does not.
    const wanted = [...new Set(here.flatMap((target) => tagOf(target) ?? []))];
    const state = states[frame.key];
    if (state?.state !== "measured") {
      unmeasured.push(frame.key);
      continue;
    }
    const drawn = new Set(state.tags);
    const tags = wanted.filter((tag) => drawn.has(tag)).slice(0, MAX_OUTLINE_TAGS);
    shown.set(frame.scenario.id, (shown.get(frame.scenario.id) ?? false) || tags.length > 0);
    if (tags.length > 0) out.push({ key: frame.key, tags });
  }
  const missing = [...shown].filter(([, any]) => !any).map(([scenario]) => scenario);
  return { frames: out, missing, unmeasured };
}
