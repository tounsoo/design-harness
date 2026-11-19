import type { ElementNode, Finding, FindingTarget, PrototypeModel } from "@design-harness/core";
import type { FrameKey, FrameSpec, FrameState } from "./session";

/**
 * Element tags: how a frame knows which spec or source element each part of
 * the page it drew came from, so a finding about an element can be outlined
 * where it renders.
 *
 * A tag travels as one prop, `data-dh-source`, on the React element of a
 * library part, a page kit part or an HTML element. In a TSX prototype the
 * transform adds it after core has checked the source (core reads the files
 * as written, and code export writes them as written); its value is where
 * the JSX is written, `file:line:column`, exactly core's location for that
 * element. In a spec prototype the spec renderer passes it to each part, and
 * its value is the element's key in the expanded page, which carries the
 * layout instance's scope (`details/summary`); a Page's slot is
 * `<page root>/slots/<name>`.
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

/** A TSX element's tag: where its JSX is written. */
export function sourceTag(at: { readonly file: string; readonly line: number; readonly column: number }): string {
  return `${at.file}:${at.line}:${at.column}`;
}

/** The tag a frame draws a finding's target under: a spec element's key, or where a TSX element is written. */
export function tagOf(target: FindingTarget): string {
  return target.key ?? sourceTag(target);
}

/**
 * What the TSX transform writes on each JSX element, by file and then by
 * `line:column` (core's location): the element's tag for a library part, a
 * page kit part or an HTML element; null for anything else (one of the
 * prototype's own components, or a tag the extractor could not name), which
 * gets the prop set to undefined, so a value written by hand is never passed
 * on as a tag.
 */
export type TagSites = ReadonlyMap<string, ReadonlyMap<string, string | null>>;

/** The tag sites of a TSX prototype, from core's model of its source: every JSX element written in its files. */
export function tagSites(model: PrototypeModel): TagSites {
  const sites = new Map<string, Map<string, string | null>>();
  const visit = (node: ElementNode) => {
    const file = sites.get(node.at.file) ?? new Map<string, string | null>();
    sites.set(node.at.file, file);
    const taggable = node.kind === "library" || node.kind === "kit" || node.kind === "intrinsic";
    file.set(`${node.at.line}:${node.at.column}`, taggable ? sourceTag(node.at) : null);
    node.children.forEach(visit);
  };
  model.source.forEach(visit);
  return sites;
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
    const wanted = [...new Set(targets.filter((target) => target.page === undefined || target.page === frame.scenario.page).map(tagOf))];
    if (wanted.length === 0) continue;
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
