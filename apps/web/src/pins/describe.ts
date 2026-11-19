import { elementWords } from "./anchor";
import type { Pin, PinAnchor, PinState } from "./model";

/**
 * Pins in words: for the agent, which gets the open ones as findings beside
 * core's, and for the person, in the pin's card and the "Your notes" list.
 * Pure over the pins: what a pin says about its place was measured when it
 * was last placed, so the same pins always read the same.
 */

/** A pin's place as core's findings give theirs: where it is written, then the scenario and the view; for a note on a variant, the variant first. */
export function pinPlace(anchor: PinAnchor): string {
  const source = anchor.element?.source;
  return [anchor.variant !== undefined ? `variant "${anchor.variant}"` : null, source ? (source.kind === "key" ? `spec element "${source.tag}"` : source.tag) : null, `scenario ${anchor.scenario}`, `view ${anchor.view}`].filter(Boolean).join(", ");
}

/** The element a pin is on, in a few words; null for a pin on bare page. */
export function pinElementWords(anchor: PinAnchor): string | null {
  const label = anchor.element?.label;
  if (label) return elementWords(label);
  const source = anchor.element?.source;
  return source ? (source.kind === "key" ? `the part "${source.tag}"` : `the part written at ${source.tag}`) : null;
}

const third = (value: number, of: number, words: readonly [string, string, string]) => (value < of / 3 ? words[0] : value < (2 * of) / 3 ? words[1] : words[2]);

/**
 * Where a pin is on its page, cropped to what tells it apart: the part of
 * the view, the point, how far into its element, and what is drawn nearest.
 */
export function pinWhere(anchor: PinAnchor): string {
  const { point, size, element, near } = anchor;
  const parts: string[] = [];
  const at = `x ${Math.round(point.x)}, y ${Math.round(point.y)}`;
  if (size) {
    const region = point.y > size.height ? "below the first view" : `${third(point.y, size.height, ["top", "middle", "bottom"])} ${third(point.x, size.width, ["left", "centre", "right"])} of the view`;
    parts.push(`${region}, at ${at} of ${size.width} × ${size.height}`);
  } else parts.push(`at ${at}`);
  const box = element?.label ?? element?.source;
  if (box) parts.push(`${Math.round(box.within.x * 100)}% across and ${Math.round(box.within.y * 100)}% down its element, which is ${Math.round(box.rect.width)} × ${Math.round(box.rect.height)} px`);
  if (near && near.length > 0) parts.push(`nearest: ${near.join(", ")}`);
  return parts.join("; ");
}

/**
 * One pin as the agent reads it: a finding's line, then what it is on and
 * where. `offered` is the variants kept now: a note on one that is not
 * among them says so.
 */
export function describePin(pin: Pin, offered?: ReadonlySet<string>): string {
  const on = pinElementWords(pin.anchor);
  const lines = [`- note ${pin.number}: ${JSON.stringify(pin.note)} [${pinPlace(pin.anchor)}]`];
  const variant = pin.anchor.variant;
  if (variant !== undefined && offered && !offered.has(variant)) lines.push(`  on: ${on ?? "the page"} of variant "${variant}", which is no longer kept (dismissed since the note was pinned); nothing is left to change for it, so say so in your reply`);
  else if (pin.anchor.lost) lines.push(`  on: ${on ?? "an element"}, which is no longer on this page (moved or gone since the note was pinned); the note stays where it last was`);
  else lines.push(`  on: ${on ?? "the page itself, no element"}`);
  lines.push(`  where: ${pinWhere(pin.anchor)}`);
  return lines.join("\n");
}

/** What opens the notes in the agent's message; the tests and the agent's instructions name it. */
export const NOTES_LEAD = "Your notes from the person";

/**
 * The open pins as the text the agent gets with the person's next message,
 * or null when there are none. It says what they are (the person's feedback,
 * never a check) and what to do with each.
 */
export function describePins(state: PinState, offered?: ReadonlySet<string>): string | null {
  const open = state.pins.filter((pin) => pin.status === "open");
  if (open.length === 0) return null;
  const onVariants = open.some((pin) => pin.anchor.variant !== undefined);
  return [
    `${NOTES_LEAD}: ${open.length} open ${open.length === 1 ? "note" : "notes"} pinned on the canvas. They are the person's own feedback, not checks: no rule reads them and they change no verdict. Treat each as a finding to fix: change the prototype for it, within the project's rules, then call address_note with its number and a short reply. Only the person closes or reopens a note.`,
    ...open.map((pin) => describePin(pin, offered)),
    // A note on a variant is about that variant's page, which only revise_variant changes.
    ...(onVariants ? ['A note whose place starts with variant "…" was pinned on that variant in the Variants view, not on the prototype: change that variant with revise_variant, never the prototype\'s page, then call address_note.'] : []),
  ].join("\n");
}
