/**
 * What a page looked like when it was rendered: one snapshot per scenario and
 * view. The web app produces them from the live DOM inside each sandboxed
 * frame; the rules here read only this data, so they are pure and can be
 * tested with hand-written snapshots too.
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
  /** True when an image or gradient is painted under the text before an opaque colour, so its contrast cannot be read from colours. */
  readonly overImage?: boolean;
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
  /** True for a control that is turned off, or text inside one, which WCAG 1.4.3 exempts from contrast. */
  readonly disabled?: boolean;
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
  /**
   * The width the page lays out in: the view's width less a vertical
   * scrollbar, when the browser draws one beside the page rather than over
   * it. Without it, the view's width is assumed.
   */
  readonly viewportWidth?: number;
  /**
   * The height of the page's content, which is more than the view's height
   * when the page scrolls down. No rule decides anything by it: it is
   * evidence, so a picture can show how far a page runs past its first view.
   */
  readonly scrollHeight?: number;
  /** The canvas colour under every background. */
  readonly canvas: Rgba;
  /** Elements in document order. */
  readonly elements: readonly RenderedElement[];
};
