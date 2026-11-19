import { variantLabel } from "@design-harness/core";
import { awayOn, type Pin, type PinAnchor, type PinState } from "./model";

/**
 * A variant's notes and a pick.
 *
 * A note pinned on a variant is about what that variant draws. When the
 * person applies a pick that takes the note's part of the page from that
 * variant, the part is the prototype's now, and the note goes with it: it
 * leaves the variant, names its element by the key the element has in the
 * recombined page, keeps its number, its words, its state and its history,
 * and gains a history entry saying it came with the pick. The board then
 * places it on what the new revision draws, by the rules every note on the
 * board is placed by (`anchor.ts`). Undoing the pick puts each such note
 * back on its variant, exactly where it was.
 *
 * Pure over the pins: nothing here reads a report, and nothing here is read
 * by core, by a standing or by a pick's verdict.
 */

/** What a pick is to the notes: the page's scenarios, where each slot came from, and where a source's element is in the result. */
export type PickForPins = {
  /** The ids of the scenarios of the page the pick changes. */
  readonly scenarios: readonly string[];
  /** Slot to source, as the pick's record keeps it. */
  readonly slots: Readonly<Record<string, string>>;
  /** An element's key in the result's expanded page, from its key in one source's, or null when the pick did not take it from that source: core's `recombinedKey`. */
  readonly keyOf: (source: string, key: string) => string | null;
};

/** A note a pick moved, or its undoing put back, and the variant it is from. */
export type CarriedNote = { readonly note: number; readonly variant: string };

/**
 * A note's anchor on the prototype after the pick, or null when the note
 * stays on its variant. It moves when the pick took its element from its
 * variant: the element's key is one the result holds for that source. A
 * note on no part (bare page) is about the page as a whole, which is the
 * variant's only when every slot came from it. A note whose element is
 * already gone from its variant names nothing a slot holds, and stays.
 */
function carried(anchor: PinAnchor, variant: string, pick: PickForPins): PinAnchor | null {
  if (anchor.lost || !pick.scenarios.includes(anchor.scenario)) return null;
  const { variant: _variant, ...rest } = anchor;
  const source = anchor.element?.source;
  if (!source) return Object.values(pick.slots).every((name) => name === variant) ? rest : null;
  const tag = pick.keyOf(variant, source.tag);
  if (tag === null) return null;
  return { ...rest, element: { ...anchor.element, source: { ...source, tag } } };
}

/**
 * The pins after a pick is applied at `at`, the pick's own time. Each open
 * or addressed note on a variant that gave the slot the note's element sits
 * in moves onto the prototype. A closed note stays where it is, and so does
 * a note on a slot the pick did not take, on another page's scenario, or on
 * a variant the pick did not use. Returns the same state when none moves.
 */
export function carryWithPick(state: PinState, pick: PickForPins, at: string): { readonly state: PinState; readonly moved: readonly CarriedNote[] } {
  const used = new Set(Object.values(pick.slots));
  const moved: CarriedNote[] = [];
  const pins = state.pins.map((pin): Pin => {
    const variant = pin.anchor.variant;
    if (variant === undefined || !used.has(variant) || pin.status === "closed") return pin;
    const anchor = carried(pin.anchor, variant, pick);
    if (!anchor) return pin;
    moved.push({ note: pin.number, variant });
    return { ...pin, anchor, history: [...pin.history, { kind: "picked", at, by: "you", variant, from: pin.anchor }] };
  });
  return moved.length === 0 ? { state, moved } : { state: { ...state, pins }, moved };
}

/**
 * The pins after the pick applied at `pick` is undone, at `at`: every note
 * that pick moved is back on its variant with the anchor it had there.
 * Only its place is put back: what happened to the note since (a reply, a
 * rewrite, closing it) is kept, since the page under it is gone from the
 * prototype whatever its state. Returns the same state when no note is
 * that pick's.
 */
export function returnFromPick(state: PinState, pick: string, at: string): { readonly state: PinState; readonly returned: readonly CarriedNote[] } {
  const returned: CarriedNote[] = [];
  const pins = state.pins.map((pin): Pin => {
    if (pin.anchor.variant !== undefined || typeof awayOn(pin.history) !== "string") return pin;
    const event = pin.history.filter((item) => item.kind === "picked").at(-1);
    if (!event || event.at !== pick) return pin;
    returned.push({ note: pin.number, variant: event.variant });
    return { ...pin, anchor: event.from, history: [...pin.history, { kind: "unpicked", at, by: "you", variant: event.variant }] };
  });
  return returned.length === 0 ? { state, returned } : { state: { ...state, pins }, returned };
}

const list = (items: readonly string[]) => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1) ?? ""}`);

/** The notes a pick moved or gave back, by number, and the variants they are from, by name. */
function named(notes: readonly CarriedNote[]): { readonly numbers: string; readonly variants: string; readonly count: number } {
  const numbers = notes.map((item) => item.note).sort((a, b) => a - b);
  const variants = [...new Set(notes.map((item) => item.variant))].sort().map(variantLabel);
  return { numbers: list(numbers.map(String)), variants: list(variants), count: numbers.length };
}

/** What the person is told when notes came with a pick, saying how many, or null when none did. */
export function carriedWords(moved: readonly CarriedNote[]): string | null {
  if (moved.length === 0) return null;
  const { numbers, variants, count } = named(moved);
  return count === 1 ? `1 note came along from ${variants} (note ${numbers}): it is on the board now, under Your notes.` : `${count} notes came along from ${variants} (notes ${numbers}): they are on the board now, under Your notes.`;
}

/** What the person is told when undoing a pick put notes back, or null when it put none. */
export function returnedWords(returned: readonly CarriedNote[]): string | null {
  if (returned.length === 0) return null;
  const { numbers, variants, count } = named(returned);
  return count === 1 ? `1 note is back on ${variants}, where it was (note ${numbers}).` : `${count} notes are back on ${variants}, where they were (notes ${numbers}).`;
}
