/**
 * What a page looked like when it was rendered: one snapshot per scenario and
 * view. Producing a snapshot from a live page is a later milestone; the rules
 * here read only this data, so they are pure and can be tested with
 * hand-written snapshots.
 */

/** A colour as sRGB channels from 0 to 255 and alpha from 0 to 1. */
export type Rgba = readonly [number, number, number, number];

export type Rect = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };

/** How a run of text was painted. */
export type TextPaint = {
  readonly px: number;
  readonly weight: number;
  /** The text colour, its alpha already multiplied by the opacity of the element and its ancestors. */
  readonly color: Rgba;
  /** Background colours under the text, innermost first, down to the first opaque one. */
  readonly backgrounds: readonly Rgba[];
};

export type RenderedElement = {
  /** The ARIA role, such as `button`, `link`, `heading` or `generic`. */
  readonly role: string;
  /** The accessible name a screen reader announces. */
  readonly name: string;
  /** The HTML tag, lowercase. */
  readonly tag: string;
  readonly rect: Rect;
  /** True for a control a person can press or type into. */
  readonly interactive: boolean;
  /** False for an element not painted, such as one in a closed disclosure. */
  readonly visible: boolean;
  /** True for a link inside a sentence, which WCAG 2.5.8 exempts from the target size. */
  readonly inline?: boolean;
  /** 1 to 6 for a heading, from its tag or aria-level. */
  readonly headingLevel?: number;
  /** Present on an element that paints text of its own. */
  readonly text?: TextPaint;
};

export type RenderedSnapshot = {
  readonly scenario: string;
  /** A view name from the project's config. */
  readonly view: string;
  /** The width of the page's content, which is more than the view's width when the page scrolls sideways. */
  readonly scrollWidth: number;
  /** The canvas colour under every background. */
  readonly canvas: Rgba;
  /** Elements in document order. */
  readonly elements: readonly RenderedElement[];
};
