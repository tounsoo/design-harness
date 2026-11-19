import type { Prototype, Rect, RenderedElement, RenderedSnapshot } from "@design-harness/core";
import type { TagPlace } from "../runtime/tags";
import { moveAnchor, type PinAnchor, type PinElement, type PinSource, type PinState, type Point } from "./model";

/**
 * Where a pin is, and where it is after the prototype changes.
 *
 * Everything is worked out by the app from what a frame already measured:
 * the snapshot's boxes (`RenderedSnapshot`) and the boxes each element tag
 * drew (`TagPlace`, sent with the snapshot). Nothing here asks a frame
 * anything, so it works the same on a live frame and on a parked one, and it
 * reads no report: a pin never changes what core says.
 */

/** What one frame measured: its snapshot, and the box of every tagged part it drew, in tree order. */
export type FrameMeasure = { readonly snapshot: RenderedSnapshot; readonly places: readonly TagPlace[]; readonly width: number; readonly height: number };

const round = (value: number) => Math.round(value * 100) / 100;

/**
 * A click on the overlay above an artboard, as a point in the page's CSS px.
 * `offset` is from the overlay's top left corner, in screen px; `scale` is
 * the artboard's zoom; `scroll` is where the frame's page is scrolled to.
 */
export function toPage(offset: Point, scale: number, scroll: Point): Point {
  return { x: round(offset.x / scale + scroll.x), y: round(offset.y / scale + scroll.y) };
}

/** The other way: where a point of the page is on the overlay, in screen px from its top left corner. */
export function toOverlay(point: Point, scale: number, scroll: Point): Point {
  return { x: (point.x - scroll.x) * scale, y: (point.y - scroll.y) * scale };
}

/** An overlay point kept inside the artboard, and whether it had to be moved: a pin on a part of the page scrolled out of the view sits at the nearest edge. */
export function intoView(at: Point, view: { readonly width: number; readonly height: number }, scale: number): Point & { readonly off: boolean } {
  const x = Math.min(Math.max(at.x, 0), view.width * scale);
  const y = Math.min(Math.max(at.y, 0), view.height * scale);
  return { x, y, off: x !== at.x || y !== at.y };
}

const drawn = (rect: Rect) => rect.width > 0 && rect.height > 0;
const contains = (rect: Rect, point: Point) => drawn(rect) && point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
const area = (rect: Rect) => rect.width * rect.height;
const within = (rect: Rect, point: Point): Point => ({ x: round((point.x - rect.x) / rect.width), y: round((point.y - rect.y) / rect.height) });
const pointIn = (rect: Rect, at: Point): Point => ({ x: round(rect.x + rect.width * at.x), y: round(rect.y + rect.height * at.y) });
const centre = (rect: Rect): Point => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
/** How far a point is from a box: nothing when it is inside. */
const distance = (rect: Rect, point: Point) => Math.hypot(Math.max(rect.x - point.x, 0, point.x - rect.x - rect.width), Math.max(rect.y - point.y, 0, point.y - rect.y - rect.height));

/** The innermost box holding the point: the smallest, and of equals the later one, which is deeper in the page. */
function innermost<T>(items: readonly T[], rectOf: (item: T) => Rect, point: Point, accept: (item: T) => boolean = () => true): number {
  let best = -1;
  items.forEach((item, index) => {
    if (!accept(item) || !contains(rectOf(item), point)) return;
    if (best < 0 || area(rectOf(item)) <= area(rectOf(items[best] as T))) best = index;
  });
  return best;
}

const sameRect = (a: Rect, b: Rect) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/** A pin's source on a tagged part: the spec element's key, which of its boxes, and where in that box. */
function sourceOn(part: { readonly tag: string; readonly nth: number; readonly rect: Rect; readonly within: Point }): PinSource {
  return { tag: part.tag, nth: part.nth, rect: part.rect, within: part.within, kind: "key" };
}

/** The tagged part under a point, when there is one. */
function sourceAt(measure: FrameMeasure, point: Point): PinElement["source"] {
  const index = innermost(measure.places, (place) => place.rect, point);
  const place = measure.places[index];
  if (!place) return undefined;
  const nth = measure.places.slice(0, index).filter((item) => item.tag === place.tag && drawn(item.rect)).length;
  return sourceOn({ tag: place.tag, nth, rect: place.rect, within: within(place.rect, point) });
}

function labelOf(element: RenderedElement, point: Point): NonNullable<PinElement["label"]> {
  return { role: element.role, name: element.name, html: element.tag, rect: element.rect, within: within(element.rect, point) };
}

/**
 * The measured element under a point, when there is one: the control there
 * (a button, not the run of text inside it), or else the heading, or else
 * whatever paints text there, each time the innermost.
 */
function labelAt(measure: FrameMeasure, point: Point): PinElement["label"] {
  const elements = measure.snapshot.elements;
  for (const accept of [(item: RenderedElement) => item.visible && item.interactive, (item: RenderedElement) => item.visible && item.headingLevel !== undefined, (item: RenderedElement) => item.visible]) {
    const element = elements[innermost(elements, (item) => item.rect, point, accept)];
    if (element) return labelOf(element, point);
  }
  return undefined;
}

const elementOf = (source: PinElement["source"], label: PinElement["label"]): { element?: PinElement } => (source || label ? { element: { ...(source ? { source } : {}), ...(label ? { label } : {}) } } : {});

/** A measured element in a few words: `button "Book room"`. */
export function elementWords(element: { readonly role: string; readonly name: string; readonly html?: string; readonly tag?: string }): string {
  const role = element.role === "generic" || element.role === "" ? (element.html ?? element.tag ?? "element") : element.role;
  const name = element.name.length > 80 ? `${element.name.slice(0, 77)}...` : element.name;
  return name ? `${role} "${name}"` : role;
}

/** What is drawn nearest a point, nearest first, the element under it left out: for the description the agent reads. */
function nearby(measure: FrameMeasure, point: Point, under: PinElement["label"]): string[] {
  const named = measure.snapshot.elements.filter((element) => element.visible && element.name !== "" && drawn(element.rect) && !(under && sameRect(element.rect, under.rect) && element.name === under.name));
  const sorted = named.map((element) => ({ element, far: distance(element.rect, point) })).sort((a, b) => a.far - b.far);
  return [...new Set(sorted.map((item) => elementWords(item.element)))].slice(0, 3);
}

/** A frame pins are on: a scenario at a view, of the prototype or, with `variant`, of one variant of a page. */
export type FrameRef = { readonly scenario: string; readonly view: string; readonly variant?: string };

/** Whether an anchor is on a surface: the prototype's own frames (`undefined`), or one variant's. */
export const onSurface = (anchor: { readonly variant?: string }, variant: string | undefined): boolean => (anchor.variant ?? null) === (variant ?? null);

/** A new pin's anchor: the frame, the point, and what the frame drew under it, by the spec's element keys. */
export function anchorAt(measure: FrameMeasure | null, frame: FrameRef, point: Point, revision: string): PinAnchor {
  const base = { scenario: frame.scenario, view: frame.view, ...(frame.variant !== undefined ? { variant: frame.variant } : {}), revision, seen: revision, point: { x: round(point.x), y: round(point.y) } };
  if (!measure) return base;
  const label = labelAt(measure, point);
  return { ...base, ...elementOf(sourceAt(measure, point), label), near: nearby(measure, point, label), size: { width: measure.width, height: measure.height } };
}

/** One element of a frame a person can pin a note to without a pointer. */
export type ElementChoice = { readonly index: number; readonly label: string };

/** A frame's elements for the list: every visible, named element the snapshot holds, in page order, each told apart when two read the same. */
export function elementChoices(measure: FrameMeasure): ElementChoice[] {
  const seen = new Map<string, number>();
  const out: ElementChoice[] = [];
  measure.snapshot.elements.forEach((element, index) => {
    if (!element.visible || element.name === "" || !drawn(element.rect)) return;
    const words = elementWords(element);
    const count = (seen.get(words) ?? 0) + 1;
    seen.set(words, count);
    out.push({ index, label: count > 1 ? `${words} (${count})` : words });
  });
  return out.slice(0, 400);
}

/** The anchor of a pin put on one element of the list: its middle. */
export function anchorOn(measure: FrameMeasure, frame: FrameRef, index: number, revision: string): PinAnchor | null {
  const element = measure.snapshot.elements[index];
  return element && drawn(element.rect) ? anchorAt(measure, frame, centre(element.rect), revision) : null;
}

/** Of several boxes, the one whose middle is nearest a point. */
function nearest<T>(items: readonly T[], rectOf: (item: T) => Rect, point: Point): T | undefined {
  let best: T | undefined;
  let least = Number.POSITIVE_INFINITY;
  for (const item of items) {
    const middle = centre(rectOf(item));
    const far = Math.hypot(middle.x - point.x, middle.y - point.y);
    if (far < least) {
      least = far;
      best = item;
    }
  }
  return best;
}

/**
 * A pin's anchor on a new measurement of its frame.
 *
 * The pin stays on its element while that element is still on the page. An
 * element is found by its tag first, a spec element's key, which names it
 * whatever is around it: the tag is believed when what it draws there is
 * still the element the pin named (its role, HTML tag and accessible name);
 * otherwise the element is looked for by that name, and its new tag
 * adopted; and when the name is nowhere, the tag alone is believed (the
 * element was renamed where it stands). Nothing else is remembered between
 * measurements, so the answer is the same in the session the pin was made
 * in, after a reload, and after an export and import. The point keeps its
 * place within the element's box, wherever the box moved.
 *
 * When neither finds it, the pin is `lost`: it stays where it last was, to
 * be shown as "moved or gone". It is found again if the element comes back.
 * A pin on no element (bare page) stays at its point.
 *
 * Returns the same object when nothing changed.
 */
export function resolveAnchor(anchor: PinAnchor, measure: FrameMeasure, revision: string): PinAnchor {
  const element = anchor.element;
  const size = { width: measure.width, height: measure.height };
  const frame = { scenario: anchor.scenario, view: anchor.view, ...(anchor.variant !== undefined ? { variant: anchor.variant } : {}), revision: anchor.revision, seen: revision };
  let next: PinAnchor;
  if (!element) {
    next = { ...frame, point: anchor.point, near: nearby(measure, anchor.point, undefined), size };
  } else {
    const { source, label } = element;
    const named = label && label.name !== "" ? measure.snapshot.elements.filter((item) => item.visible && drawn(item.rect) && item.role === label.role && item.tag === label.html && item.name === label.name) : [];
    const boxes = source ? measure.places.filter((place) => place.tag === source.tag && drawn(place.rect)) : [];
    const box = source ? (boxes[source.nth] ?? nearest(boxes, (place) => place.rect, centre(source.rect))) : undefined;
    const byTag = source && box ? pointIn(box.rect, source.within) : null;
    let found: { readonly point: Point; readonly source: PinElement["source"]; readonly label: PinElement["label"] } | null = null;
    if (source && box && byTag) {
      const same = label ? nearest(named.filter((item) => contains(item.rect, byTag)), (item) => item.rect, byTag) : undefined;
      const now = same ? labelOf(same, byTag) : labelAt(measure, byTag);
      // The element it named is still under the point; or it was renamed where it stands, and the pin names what is there now.
      // A pin already lost is found again only by its element's name, never by its tag alone.
      const trusted = !anchor.lost || !label || label.name === "";
      if (same || (named.length === 0 && trusted)) found = { point: byTag, source: sourceOn({ tag: source.tag, nth: Math.max(0, boxes.indexOf(box)), rect: box.rect, within: source.within }), label: now };
    }
    if (found) {
      // Found by its tag: nothing more to look for.
    } else if (label && named.length > 0) {
      const match = nearest(named, (item) => item.rect, anchor.point) as RenderedElement;
      const point = pointIn(match.rect, label.within);
      found = { point, source: sourceAt(measure, point), label: { ...label, rect: match.rect } };
    } else if (!source && label && label.name === "") {
      // Nothing names it (no tag, no accessible name), so nothing can say it is gone: it stays at its point, on what is there now.
      found = { point: anchor.point, source: undefined, label: labelAt(measure, anchor.point) };
    }
    next = found
      ? { ...frame, point: found.point, ...elementOf(found.source, found.label), near: nearby(measure, found.point, found.label), size }
      : { ...anchor, lost: true };
  }
  return JSON.stringify(next) === JSON.stringify(anchor) ? anchor : next;
}

/**
 * Every pin's anchor on what the frames of a revision measured, by frame key
 * (`scenario@view`), for the pins of one surface: the prototype's own frames,
 * or one variant's (`variant`). A pin whose frame is not measured (not drawn
 * yet, failed, or no longer there) is left as it is, and so is every pin of
 * another surface. Returns the same state when no anchor changed, so calling
 * it again changes nothing.
 */
export function reanchor(state: PinState, frames: Readonly<Record<string, FrameMeasure | undefined>>, revision: string, variant?: string): PinState {
  let next = state;
  for (const pin of state.pins) {
    if (!onSurface(pin.anchor, variant)) continue;
    const measure = frames[`${pin.anchor.scenario}@${pin.anchor.view}`];
    if (!measure) continue;
    const anchor = resolveAnchor(pin.anchor, measure, revision);
    if (anchor !== pin.anchor) next = moveAnchor(next, pin.number, anchor);
  }
  return next;
}

/**
 * Markers that share a spot, grouped: two notes pinned closer than `radius`
 * (in screen px on the artboard) would lie one on the other, and only the
 * upper one would take the pointer. Each item joins the first group whose
 * first member is within the radius, in the order given, so the same pins
 * always group the same way. A group of one is a marker alone.
 */
export function spots<T extends Point>(items: readonly T[], radius: number): T[][] {
  const groups: T[][] = [];
  for (const item of items) {
    const group = groups.find((members) => {
      const first = members[0] as T;
      return Math.hypot(first.x - item.x, first.y - item.y) < radius;
    });
    if (group) group.push(item);
    else groups.push([item]);
  }
  return groups;
}

const prints = new WeakMap<Prototype, string>();

/** A revision's name: a fingerprint of the prototype's content, the same wherever and whenever it is worked out. */
export function fingerprint(prototype: Prototype): string {
  const known = prints.get(prototype);
  if (known) return known;
  // Keys in a fixed order: a prototype read back from a file or the store may hold the same content in another order.
  const text = JSON.stringify(prototype, (_key, value: unknown) => (typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : value));
  // FNV-1a, twice with different seeds: 64 bits as hex.
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193);
    b = Math.imul(b ^ code, 0x85ebca6b);
  }
  const print = `${(a >>> 0).toString(16).padStart(8, "0")}${(b >>> 0).toString(16).padStart(8, "0")}`;
  prints.set(prototype, print);
  return print;
}
