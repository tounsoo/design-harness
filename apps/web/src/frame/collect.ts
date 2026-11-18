import type { Rect, RenderedElement, RenderedSnapshot, Rgba } from "@design-harness/core";
import { computeAccessibleName, getRole, isDisabled } from "dom-accessibility-api";

/**
 * Reads a rendered page into core's `RenderedSnapshot`, inside the frame,
 * from the live DOM. It records three kinds of element, in document order:
 * every control a person can press or type into, every heading, and every
 * element that paints text of its own. `nodes[i]` is the DOM node of
 * `snapshot.elements[i]`, so a finding can be pointed at on the page.
 *
 * Names come from `dom-accessibility-api`'s computation of the accessible
 * name for controls and headings. An element that only paints text is named
 * by that text, which is what a reader sees and what a contrast finding quotes.
 */

export type Collected = { readonly snapshot: RenderedSnapshot; readonly nodes: readonly Element[] };

const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TITLE", "OPTION", "OPTGROUP", "DATALIST", "HEAD", "META", "LINK"]);
const WIDGET_ROLES = new Set([
  "button",
  "link",
  "checkbox",
  "radio",
  "switch",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "combobox",
  "textbox",
  "searchbox",
  "slider",
  "spinbutton",
  "treeitem",
  "gridcell",
]);
/** The overlay the frame draws for a highlight; never part of the page. */
export const OVERLAY_ATTRIBUTE = "data-design-harness-overlay";

export function collapse(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

/** Rounds to a hundredth of a CSS px, so float noise in layout never changes a snapshot. */
export function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Parses `rgb()` and `rgba()`, as Chrome computes most colours, or returns null. */
export function parseRgb(color: string): Rgba | null {
  const match = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/.exec(color.trim());
  if (!match) return null;
  const alpha = match[4] === undefined ? 1 : Number(match[4]) / (match[5] ? 100 : 1);
  return [round(Number(match[1])), round(Number(match[2])), round(Number(match[3])), round(Math.min(1, alpha))];
}

/** Multiplies a colour's alpha, as an element's opacity fades what it paints. */
export function fade(color: Rgba, opacity: number): Rgba {
  return [color[0], color[1], color[2], round(color[3] * opacity)];
}

/** A colour in any CSS syntax (oklch, color(), hsl) as sRGB, read through a 1×1 canvas when it is not plain rgb(). */
function colorReader(doc: Document): (color: string) => Rgba {
  let context: CanvasRenderingContext2D | null | undefined;
  return (color) => {
    const plain = parseRgb(color);
    if (plain) return plain;
    if (context === undefined) {
      const canvas = doc.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      context = canvas.getContext("2d", { willReadFrequently: true });
    }
    if (!context) return [0, 0, 0, 1];
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = "#000";
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0, a = 0] = context.getImageData(0, 0, 1, 1).data;
    return [r, g, b, round(a / 255)];
  };
}

/** The ARIA level of a heading: a whole-number aria-level, else the tag's number, else 2. */
export function headingLevel(element: Element): number | undefined {
  const role = element.getAttribute("role")?.trim().split(/\s+/)[0];
  const tag = /^H([1-6])$/.exec(element.tagName);
  if (role && role !== "heading") return undefined;
  if (!role && !tag) return undefined;
  const aria = Number(element.getAttribute("aria-level"));
  if (Number.isInteger(aria) && aria >= 1) return Math.min(aria, 6);
  return tag?.[1] ? Number(tag[1]) : 2;
}

function explicitRole(element: Element): string | null {
  return element.getAttribute("role")?.trim().split(/\s+/)[0] || null;
}

/** True for a control a person can press or type into. */
export function isInteractive(element: Element): boolean {
  const role = explicitRole(element);
  if (role === "presentation" || role === "none") return false;
  if (role && WIDGET_ROLES.has(role)) return true;
  if (element.hasAttribute("contenteditable") && element.getAttribute("contenteditable") !== "false") return true;
  switch (element.tagName) {
    case "BUTTON":
    case "SELECT":
    case "TEXTAREA":
      return true;
    case "INPUT":
      return (element as HTMLInputElement).type !== "hidden";
    case "A":
    case "AREA":
      return element.hasAttribute("href");
    case "SUMMARY": {
      const parent = element.parentElement;
      return parent instanceof HTMLDetailsElement && parent.querySelector(":scope > summary") === element;
    }
  }
  const tabindex = element.getAttribute("tabindex");
  return tabindex !== null && Number(tabindex) >= 0;
}

/**
 * False for an element a person cannot see: no box, hidden, see-through,
 * clipped to a pixel or less, or inside a closed disclosure (its summary
 * stays visible). A visually hidden element is not visible, though a screen
 * reader still reaches it.
 */
export function isShown(element: Element): boolean {
  if (element.getClientRects().length === 0) return false;
  if (!element.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })) return false;
  for (let node: Element | null = element; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    const box = node.getBoundingClientRect();
    if ((box.width <= 1 || box.height <= 1) && (style.overflow !== "visible" || node === element)) return false;
    const parent: Element | null = node.parentElement;
    if (parent instanceof HTMLDetailsElement && !parent.open && parent.querySelector(":scope > summary") !== node) return false;
  }
  return true;
}

/** True for an element no assistive technology reaches: aria-hidden, inert, or not rendered at all. */
function isInaccessible(element: Element): boolean {
  if (element.closest("[aria-hidden='true'], [inert]")) return true;
  return !element.checkVisibility({ visibilityProperty: true });
}

/** The text an element paints itself: its own text nodes, not its children's. */
export function ownText(element: Element): string {
  let text = "";
  for (const node of element.childNodes) if (node.nodeType === Node.TEXT_NODE) text += node.textContent ?? "";
  return collapse(text);
}

/** A link inside a sentence, which WCAG 2.5.8 exempts from the target size: laid out inline, with other text in its block. */
function isInlineLink(element: Element): boolean {
  if (element.tagName !== "A" && explicitRole(element) !== "link") return false;
  if (!getComputedStyle(element).display.startsWith("inline")) return false;
  const block = element.parentElement;
  return block !== null && collapse(block.textContent).length > collapse(element.textContent).length;
}

function rectOf(element: Element, scroll: { x: number; y: number }): Rect {
  const box = element.getBoundingClientRect();
  return { x: round(box.left + scroll.x), y: round(box.top + scroll.y), width: round(box.width), height: round(box.height) };
}

/** The root canvas under every background: dark when the root's used colour scheme is dark. */
function canvasColor(doc: Document, win: Window): Rgba {
  const computed = win.getComputedStyle(doc.documentElement).colorScheme;
  const scheme = computed === "normal" ? (doc.querySelector("meta[name='color-scheme']")?.getAttribute("content") ?? "normal") : computed;
  const prefersDark = win.matchMedia("(prefers-color-scheme: dark)").matches;
  const dark = /\bdark\b/.test(scheme) && (prefersDark || !/\blight\b/.test(scheme));
  return dark ? [18, 18, 18, 1] : [255, 255, 255, 1];
}

/** Reads the page. `scenario` and `view` name the snapshot; the document must be scrolled to the top. */
export function collectSnapshot(doc: Document, scenario: string, view: string): Collected {
  const win = doc.defaultView;
  if (!win) throw new Error("the document has no window to measure in");
  const read = colorReader(doc);
  const scroll = { x: win.scrollX, y: win.scrollY };
  const opacity = new Map<Element, number>();
  /** The product of an element's opacity and its ancestors'. */
  const faded = (element: Element | null): number => {
    if (!element) return 1;
    const known = opacity.get(element);
    if (known !== undefined) return known;
    const value = Number(win.getComputedStyle(element).opacity) * faded(element.parentElement);
    opacity.set(element, value);
    return value;
  };

  const elements: RenderedElement[] = [];
  const nodes: Element[] = [];
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT, {
    acceptNode: (node) => {
      const element = node as Element;
      if (SKIP.has(element.tagName) || element.hasAttribute(OVERLAY_ATTRIBUTE)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const element = node as Element;
    const interactive = isInteractive(element) && !isInaccessible(element);
    const level = headingLevel(element);
    const heading = level !== undefined && !isInaccessible(element);
    const text = ownText(element);
    if (!interactive && !heading && text === "") continue;
    if (element.getClientRects().length === 0 && !interactive && !heading) continue;

    let shown = isShown(element);
    let rect = rectOf(element, scroll);
    // A visually hidden control with a visible label, such as a styled checkbox: the label is what a person presses.
    if (interactive && !shown && "labels" in element) {
      const label = [...((element as HTMLInputElement).labels ?? [])].find((item) => isShown(item));
      if (label) {
        shown = true;
        rect = rectOf(label, scroll);
      }
    }
    const style = win.getComputedStyle(element);
    const role = getRole(element) ?? (element.tagName === "SUMMARY" ? "button" : "generic");
    const name = interactive || heading ? collapse(computeAccessibleName(element)) : text;
    const disabled = (interactive && isDisabled(element)) || element.closest("[aria-disabled='true'], :disabled") !== null;

    let paint: RenderedElement["text"];
    if (text !== "") {
      const backgrounds: Rgba[] = [];
      let overImage = false;
      for (let layer: Element | null = element; layer; layer = layer.parentElement) {
        const layerStyle = win.getComputedStyle(layer);
        if (layerStyle.backgroundImage !== "none") {
          overImage = true;
          break;
        }
        const background = fade(read(layerStyle.backgroundColor), faded(layer));
        if (background[3] > 0) backgrounds.push(background);
        if (background[3] >= 0.999) break;
      }
      paint = {
        px: round(Number.parseFloat(style.fontSize)),
        weight: Number(style.fontWeight) || 400,
        color: fade(read(style.color), faded(element)),
        backgrounds,
        ...(overImage ? { overImage: true as const } : {}),
      };
    }

    elements.push({
      role,
      name,
      tag: element.tagName.toLowerCase(),
      rect,
      interactive,
      visible: shown,
      ...(interactive && isInlineLink(element) ? { inline: true } : {}),
      ...(heading ? { headingLevel: level } : {}),
      ...(disabled ? { disabled: true as const } : {}),
      ...(paint ? { text: paint } : {}),
    });
    nodes.push(element);
  }

  const snapshot: RenderedSnapshot = {
    scenario,
    view,
    scrollWidth: doc.documentElement.scrollWidth,
    viewportWidth: doc.documentElement.clientWidth,
    canvas: canvasColor(doc, win),
    elements,
  };
  return { snapshot, nodes };
}
