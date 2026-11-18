import type { Rect, RenderedElement, RenderedSnapshot, Rgba } from "../../src/rendered/types";

/**
 * Hand-written snapshots of the legal Nook prototype, one per scenario and
 * view, as a renderer would report them, so the rendered rules can be tested
 * without a browser. The web app's end-to-end tests render the same
 * prototype for real and check that it passes too.
 */

const INK: Rgba = [24, 24, 27, 1];
const MUTED: Rgba = [82, 82, 91, 1];
const PAPER: Rgba = [255, 255, 255, 1];
const BRAND: Rgba = [29, 78, 216, 1];

type View = { readonly name: "desktop" | "phone"; readonly x: number; readonly width: number };
const VIEWS: readonly View[] = [
  { name: "desktop", x: 280, width: 720 },
  { name: "phone", x: 16, width: 358 },
];

const rect = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height });

export function heading(level: number, name: string, box: Rect): RenderedElement {
  return { role: "heading", name, tag: `h${level}`, rect: box, interactive: false, visible: true, headingLevel: level, text: { px: level === 1 ? 32 : 20, weight: 700, color: INK, backgrounds: [] } };
}

export function text(name: string, box: Rect, options: { color?: Rgba; visible?: boolean } = {}): RenderedElement {
  return { role: "paragraph", name, tag: "p", rect: box, interactive: false, visible: options.visible ?? true, text: { px: 16, weight: 400, color: options.color ?? INK, backgrounds: [] } };
}

export function button(name: string, box: Rect, primary = false): RenderedElement {
  return {
    role: "button",
    name,
    tag: "button",
    rect: box,
    interactive: true,
    visible: true,
    text: { px: 16, weight: 600, color: primary ? PAPER : INK, backgrounds: primary ? [BRAND] : [] },
  };
}

function bookingPage(view: View, state: "room-open" | "booked" | "held"): RenderedElement[] {
  const { x, width } = view;
  const stacked = view.name === "phone";
  const status = state === "booked" ? [text("Booked until 3 pm", rect(x, 172, width, 24))] : state === "held" ? [text("Held for 10 minutes", rect(x, 172, width, 24))] : [];
  return [
    heading(1, "Lantern", rect(x, 96, width, 40)),
    text("6 seats, Second floor", rect(x, 144, width, 24), { color: MUTED }),
    ...status,
    text("How long?", rect(x, 208, width, 24)),
    { role: "combobox", name: "How long?", tag: "select", rect: rect(x, 236, Math.min(240, width), 40), interactive: true, visible: true, text: { px: 16, weight: 400, color: INK, backgrounds: [PAPER] } },
    { role: "button", name: "Room details", tag: "summary", rect: rect(x, 300, width, 32), interactive: true, visible: true, text: { px: 16, weight: 600, color: INK, backgrounds: [] } },
    text("Screen", rect(x, 340, width, 24), { visible: false }),
    text("Whiteboard", rect(x, 368, width, 24), { visible: false }),
    button("Hold room", stacked ? rect(x, 360, width, 44) : rect(x, 360, 160, 44)),
    button("Book room", stacked ? rect(x, 416, width, 44) : rect(x + 176, 360, 160, 44), true),
  ];
}

function roomsPage(view: View): RenderedElement[] {
  const { x, width } = view;
  const card = (top: number, name: string, seats: number): RenderedElement[] => [
    heading(2, name, rect(x + 16, top + 16, width - 32, 28)),
    text(`${seats} seats`, rect(x + 16, top + 48, width - 32, 24), { color: MUTED }),
    button(`Open ${name}`, rect(x + 16, top + 80, 160, 44)),
  ];
  return [
    heading(1, "Rooms", rect(x, 96, width, 40)),
    text("Pick a free room to book or hold.", rect(x, 144, width, 24)),
    ...card(192, "Lantern", 6),
    ...card(348, "Harbor", 10),
  ];
}

const SCENARIOS = [
  { id: "rooms-list", page: (view: View) => roomsPage(view) },
  { id: "lantern-open", page: (view: View) => bookingPage(view, "room-open") },
  { id: "lantern-booked", page: (view: View) => bookingPage(view, "booked") },
  { id: "lantern-held", page: (view: View) => bookingPage(view, "held") },
] as const;

export function legalSnapshots(): RenderedSnapshot[] {
  return SCENARIOS.flatMap((scenario) =>
    VIEWS.map((view) => ({ scenario: scenario.id, view: view.name, scrollWidth: view.name === "phone" ? 390 : 1280, canvas: PAPER, elements: scenario.page(view) })),
  );
}
