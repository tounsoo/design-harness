import type { RenderedSnapshot } from "../../src/rendered/types";
import { button, heading, legalSnapshots, text } from "./snapshots";

/**
 * Illegal rendered cases: the legal prototype's snapshots, each changed in
 * one way a rendered rule must catch. The prototype's source is the legal one.
 */
export type RenderedCase = {
  readonly name: string;
  readonly what: string;
  readonly expect: readonly { readonly rule: string; readonly message: string }[];
  readonly snapshots: () => RenderedSnapshot[];
};

function change(scenario: string, view: string, edit: (snapshot: RenderedSnapshot) => RenderedSnapshot): () => RenderedSnapshot[] {
  return () => legalSnapshots().map((snapshot) => (snapshot.scenario === scenario && snapshot.view === view ? edit(snapshot) : snapshot));
}

export const renderedCases: readonly RenderedCase[] = [
  {
    name: "small-targets-side-by-side",
    what: "Two 12 CSS px links side by side under the rooms intro",
    expect: [{ rule: "target-size", message: "At 1280 by 900: link \"Help\" is 12×12 CSS px, under 24, and fails the spacing exception." }],
    snapshots: change("rooms-list", "desktop", (snapshot) => ({
      ...snapshot,
      elements: [
        ...snapshot.elements,
        { role: "link", name: "Help", tag: "a", rect: { x: 280, y: 170, width: 12, height: 12 }, interactive: true, visible: true },
        { role: "link", name: "Map", tag: "a", rect: { x: 296, y: 170, width: 12, height: 12 }, interactive: true, visible: true },
      ],
    })),
  },
  {
    name: "skipped-heading-level",
    what: "A room's name as h3 straight under the h1",
    expect: [{ rule: "heading-structure", message: "h3 \"Lantern\" skips a level" }],
    snapshots: change("rooms-list", "phone", (snapshot) => ({
      ...snapshot,
      elements: snapshot.elements.map((element) => (element.name === "Lantern" && element.headingLevel === 2 ? heading(3, "Lantern", element.rect) : element)),
    })),
  },
  {
    name: "second-h1",
    what: "The facts line set as a second h1",
    expect: [{ rule: "heading-structure", message: "h1 \"6 seats, Second floor\" is a second h1" }],
    snapshots: change("lantern-open", "desktop", (snapshot) => ({
      ...snapshot,
      elements: snapshot.elements.map((element) => (element.name === "6 seats, Second floor" ? heading(1, element.name, element.rect) : element)),
    })),
  },
  {
    name: "faint-text",
    what: "The rooms intro in light grey on white",
    expect: [{ rule: "text-contrast", message: "\"Pick a free room to book or hold.\" is #a1a1aa on #ffffff, a contrast of 2.56:1, under 4.5:1." }],
    snapshots: change("rooms-list", "desktop", (snapshot) => ({
      ...snapshot,
      elements: snapshot.elements.map((element) => (element.name.startsWith("Pick a free room") ? text(element.name, element.rect, { color: [161, 161, 170, 1] }) : element)),
    })),
  },
  {
    name: "unnamed-control",
    what: "Hold room as an icon with no name",
    expect: [{ rule: "accessible-names", message: "a button (<button>) at 280, 360 has no accessible name." }],
    snapshots: change("lantern-held", "desktop", (snapshot) => ({
      ...snapshot,
      elements: snapshot.elements.map((element) => (element.name === "Hold room" ? { role: "button", name: "", tag: "button", rect: element.rect, interactive: true, visible: true } : element)),
    })),
  },
  {
    name: "primary-below-the-fold",
    what: "Book room pushed below the first view on a phone",
    expect: [{ rule: "rank-1-in-first-view", message: "At 390 by 844: \"Book room\" is at 900 to 944 CSS px, below the first view of 844." }],
    snapshots: change("lantern-open", "phone", (snapshot) => ({
      ...snapshot,
      elements: snapshot.elements.map((element) => (element.name === "Book room" ? button("Book room", { ...element.rect, y: 900 }, true) : element)),
    })),
  },
  {
    name: "sideways-scroll",
    what: "The booked page 520 CSS px wide on a phone",
    expect: [{ rule: "no-sideways-scroll", message: "the page is 520 CSS px wide in a 390 CSS px view, so it scrolls sideways." }],
    snapshots: change("lantern-booked", "phone", (snapshot) => ({ ...snapshot, scrollWidth: 520 })),
  },
];
