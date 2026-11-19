import { describe, expect, it } from "vitest";
import type { RenderedElement, RenderedSnapshot } from "@design-harness/core";
import { seedLegal } from "../../test/nook";
import { anchorAt, anchorOn, elementChoices, fingerprint, intoView, reanchor, resolveAnchor, toOverlay, toPage, type FrameMeasure } from "./anchor";
import { NO_PINS, addPin, type PinState } from "./model";

const el = (role: string, name: string, tag: string, rect: [number, number, number, number], more: Partial<RenderedElement> = {}): RenderedElement => ({ role, name, tag, rect: { x: rect[0], y: rect[1], width: rect[2], height: rect[3] }, interactive: role === "button", visible: true, ...more });
const snapshot = (elements: readonly RenderedElement[]): RenderedSnapshot => ({ scenario: "lantern-open", view: "desktop", scrollWidth: 1280, canvas: [255, 255, 255, 1], elements });
const place = (tag: string, rect: [number, number, number, number]) => ({ tag, rect: { x: rect[0], y: rect[1], width: rect[2], height: rect[3] } });
const measure = (elements: readonly RenderedElement[], places: readonly ReturnType<typeof place>[]): FrameMeasure => ({ snapshot: snapshot(elements), places, width: 1280, height: 900 });
const FRAME = { scenario: "lantern-open", view: "desktop" };

/** A page: a title, and a row of two buttons inside a tagged slot. */
const first = measure(
  [el("heading", "Lantern", "h1", [100, 40, 300, 40]), el("button", "Hold room", "button", [100, 200, 120, 40]), el("button", "Book room", "button", [240, 200, 120, 40])],
  [place("pages/booking.tsx:8:5", [80, 20, 600, 400]), place("pages/booking.tsx:10:7", [100, 40, 300, 40]), place("pages/booking.tsx:14:9", [100, 200, 120, 40]), place("pages/booking.tsx:15:9", [240, 200, 120, 40])],
);

describe("mapping a click on an artboard to its page", () => {
  it("divides by the zoom and adds the frame's scroll, and maps back", () => {
    expect(toPage({ x: 100, y: 50 }, 1, { x: 0, y: 0 })).toEqual({ x: 100, y: 50 });
    expect(toPage({ x: 100, y: 50 }, 0.25, { x: 0, y: 0 })).toEqual({ x: 400, y: 200 });
    expect(toPage({ x: 100, y: 50 }, 0.5, { x: 0, y: 300 })).toEqual({ x: 200, y: 400 });
    expect(toPage({ x: 51.2, y: 36 }, 0.4, { x: 12, y: 640 })).toEqual({ x: 140, y: 730 });
    for (const scale of [0.12, 0.25, 0.4, 0.75, 1]) {
      for (const scroll of [{ x: 0, y: 0 }, { x: 30, y: 1200 }]) {
        const point = { x: 333, y: 1444 };
        const back = toPage(toOverlay(point, scale, scroll), scale, scroll);
        expect(back.x).toBeCloseTo(point.x, 1);
        expect(back.y).toBeCloseTo(point.y, 1);
      }
    }
  });

  it("puts a pin on a part of the page scrolled out of the view at the nearest edge, and says so", () => {
    const view = { width: 1280, height: 900 };
    expect(intoView(toOverlay({ x: 200, y: 400 }, 0.5, { x: 0, y: 0 }), view, 0.5)).toEqual({ x: 100, y: 200, off: false });
    expect(intoView(toOverlay({ x: 200, y: 400 }, 0.5, { x: 0, y: 600 }), view, 0.5)).toEqual({ x: 100, y: 0, off: true });
    expect(intoView(toOverlay({ x: 200, y: 2400 }, 0.5, { x: 0, y: 0 }), view, 0.5)).toEqual({ x: 100, y: 450, off: true });
  });
});

describe("anchoring a pin", () => {
  it("names the innermost tagged part and the measured element under the point, and where in each the point is", () => {
    const anchor = anchorAt(first, FRAME, { x: 270, y: 210 }, "rev-1", "source");
    expect(anchor).toMatchObject({ scenario: "lantern-open", view: "desktop", revision: "rev-1", seen: "rev-1", point: { x: 270, y: 210 }, size: { width: 1280, height: 900 } });
    expect(anchor.element?.source).toEqual({ tag: "pages/booking.tsx:15:9", kind: "source", nth: 0, rect: { x: 240, y: 200, width: 120, height: 40 }, within: { x: 0.25, y: 0.25 } });
    expect(anchor.element?.label).toMatchObject({ role: "button", name: "Book room", html: "button", within: { x: 0.25, y: 0.25 } });
    expect(anchor.near).toEqual(['button "Hold room"', 'heading "Lantern"']);
  });

  it("anchors to the page when nothing is under the point, and to the point alone on an unmeasured frame", () => {
    expect(anchorAt(first, FRAME, { x: 1000, y: 700 }, "rev-1", "source").element).toBeUndefined();
    expect(anchorAt(first, FRAME, { x: 500, y: 300 }, "rev-1", "source").element).toEqual({ source: expect.objectContaining({ tag: "pages/booking.tsx:8:5" }) });
    expect(anchorAt(null, FRAME, { x: 5, y: 6 }, "rev-1", "source")).toEqual({ scenario: "lantern-open", view: "desktop", revision: "rev-1", seen: "rev-1", point: { x: 5, y: 6 } });
  });

  it("lists a frame's named, visible elements for a keyboard, telling equals apart, and pins the middle of the one picked", () => {
    const twice = measure([...first.snapshot.elements, el("button", "Book room", "button", [240, 300, 120, 40]), el("button", "Hidden", "button", [0, 0, 10, 10], { visible: false }), el("generic", "", "div", [0, 0, 10, 10])], first.places);
    expect(elementChoices(twice)).toEqual([
      { index: 0, label: 'heading "Lantern"' },
      { index: 1, label: 'button "Hold room"' },
      { index: 2, label: 'button "Book room"' },
      { index: 3, label: 'button "Book room" (2)' },
    ]);
    const anchor = anchorOn(first, FRAME, 1, "rev-1", "source");
    expect(anchor?.point).toEqual({ x: 160, y: 220 });
    expect(anchor?.element?.source?.tag).toBe("pages/booking.tsx:14:9");
    expect(anchorOn(first, FRAME, 99, "rev-1", "source")).toBeNull();
  });
});

describe("a pin across revisions", () => {
  const pinned = anchorAt(first, FRAME, { x: 270, y: 210 }, "rev-1", "source");

  it("is unchanged, the very same object, when the frame measures the same again", () => {
    expect(resolveAnchor(pinned, first, "rev-1", "source")).toBe(pinned);
  });

  it("follows its element when the element moves, keeping its place within it", () => {
    const moved = measure(
      [el("heading", "Lantern", "h1", [100, 40, 300, 40]), el("button", "Hold room", "button", [100, 500, 120, 40]), el("button", "Book room", "button", [240, 500, 240, 80])],
      [place("pages/booking.tsx:8:5", [80, 20, 600, 700]), place("pages/booking.tsx:10:7", [100, 40, 300, 40]), place("pages/booking.tsx:14:9", [100, 500, 120, 40]), place("pages/booking.tsx:15:9", [240, 500, 240, 80])],
    );
    const next = resolveAnchor(pinned, moved, "rev-2", "source");
    expect(next.point).toEqual({ x: 300, y: 520 });
    expect(next).toMatchObject({ revision: "rev-1", seen: "rev-2" });
    expect(next.lost).toBeUndefined();
    expect(next.element?.source).toMatchObject({ tag: "pages/booking.tsx:15:9", rect: { x: 240, y: 500, width: 240, height: 80 } });
  });

  it("finds its element by name when an edit above moved where it is written, and never takes the element now written there", () => {
    // A line was added above: Hold room is now written at 15:9, where Book room was, and Book room at 16:9.
    const shifted = measure(first.snapshot.elements, [place("pages/booking.tsx:8:5", [80, 20, 600, 400]), place("pages/booking.tsx:10:7", [100, 40, 300, 40]), place("pages/booking.tsx:15:9", [100, 200, 120, 40]), place("pages/booking.tsx:16:9", [240, 200, 120, 40])]);
    const next = resolveAnchor(pinned, shifted, "rev-2", "source");
    expect(next.point).toEqual({ x: 270, y: 210 });
    expect(next.element?.label?.name).toBe("Book room");
    expect(next.element?.source).toMatchObject({ tag: "pages/booking.tsx:16:9", kind: "source" });
    expect(next.lost).toBeUndefined();
  });

  it("stays on its element when the element is renamed where it stands, and names it anew", () => {
    const renamed = measure([el("heading", "Lantern", "h1", [100, 40, 300, 40]), el("button", "Hold room", "button", [100, 200, 120, 40]), el("button", "Reserve", "button", [240, 200, 120, 40])], first.places);
    const next = resolveAnchor(pinned, renamed, "rev-2", "source");
    expect(next.lost).toBeUndefined();
    expect(next.point).toEqual({ x: 270, y: 210 });
    expect(next.element?.label?.name).toBe("Reserve");
    expect(next.element?.source?.tag).toBe("pages/booking.tsx:15:9");
  });

  it("is moved or gone, at its last position, when its element is removed; and is found again when it comes back", () => {
    const without = measure(first.snapshot.elements.slice(0, 2), first.places.slice(0, 3));
    const lost = resolveAnchor(pinned, without, "rev-2", "source");
    expect(lost.lost).toBe(true);
    expect(lost.point).toEqual(pinned.point);
    expect(lost.element).toEqual(pinned.element);
    expect(lost.seen).toBe("rev-1");
    expect(resolveAnchor(lost, without, "rev-2", "source")).toBe(lost);
    const back = resolveAnchor(lost, first, "rev-3", "source");
    expect(back.lost).toBeUndefined();
    expect(back).toMatchObject({ point: pinned.point, seen: "rev-3" });
  });

  it("keeps a spec pin on its element key, and a pin on bare page at its point", () => {
    const spec = measure([el("button", "Book room", "button", [240, 200, 120, 40])], [place("actions/book", [240, 200, 120, 40])]);
    const anchor = anchorAt(spec, FRAME, { x: 300, y: 220 }, "rev-1", "key");
    expect(anchor.element?.source).toMatchObject({ tag: "actions/book", kind: "key" });
    const moved = measure([el("button", "Book", "button", [40, 600, 120, 40])], [place("actions/book", [40, 600, 120, 40])]);
    expect(resolveAnchor(anchor, moved, "rev-2", "key")).toMatchObject({ point: { x: 100, y: 620 }, element: { label: { name: "Book" } } });
    const bare = anchorAt(first, FRAME, { x: 1000, y: 700 }, "rev-1", "source");
    expect(resolveAnchor(bare, moved, "rev-2", "source")).toMatchObject({ point: { x: 1000, y: 700 }, seen: "rev-2" });
  });

  it("re-anchors every pin whose frame is measured, leaves the others, and returns the same state when nothing moved", () => {
    let state: PinState = NO_PINS;
    for (const [frame, point] of [[FRAME, { x: 270, y: 210 }], [{ scenario: "rooms-list", view: "phone" }, { x: 10, y: 10 }]] as const) {
      const added = addPin(state, anchorAt(first, frame, point, "rev-1", "source"), "A note", "2026-11-19T10:00:00.000Z");
      if (added.ok) state = added.value;
    }
    expect(reanchor(state, { "lantern-open@desktop": first }, "rev-1", "source")).toBe(state);
    const without = measure(first.snapshot.elements.slice(0, 2), first.places.slice(0, 3));
    const next = reanchor(state, { "lantern-open@desktop": without }, "rev-2", "source");
    expect(next.pins.map((pin) => pin.anchor.lost ?? false)).toEqual([true, false]);
    expect(next.pins[1]).toBe(state.pins[1]);
    expect(next.pins[0]).toMatchObject({ note: "A note", status: "open", history: state.pins[0]?.history });
    expect(reanchor(next, { "lantern-open@desktop": without }, "rev-2", "source")).toBe(next);
  });
});

describe("a revision's fingerprint", () => {
  it("is the same for the same prototype and different after any change", () => {
    const a = seedLegal();
    const b = seedLegal();
    expect(fingerprint(a)).toMatch(/^[0-9a-f]{16}$/);
    expect(fingerprint(b)).toBe(fingerprint(a));
    expect(fingerprint(Object.fromEntries(Object.entries(a).reverse()) as typeof a)).toBe(fingerprint(a));
    expect(fingerprint({ ...a, files: { ...a.files, "pages/rooms.tsx": `${a.files["pages/rooms.tsx"] ?? ""} ` } })).not.toBe(fingerprint(a));
  });
});
