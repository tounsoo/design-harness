import type { Rect } from "@design-harness/core";

/**
 * Pinned feedback: notes a person leaves on a spot of a frame. A pin is the
 * person's own word, never a check: nothing here is read by core, no pin
 * changes a report or a rule's verdict, and the app shows pins apart from
 * core's findings ("Your notes"). The agent gets the open ones as findings to
 * fix and may mark one addressed with a short reply; only a person writes,
 * edits, closes or reopens one, and nothing deletes one: every change is
 * appended to the pin's history.
 *
 * Everything here is pure data and pure functions over it. Pins are kept
 * with their prototype (`store/`), outside the prototype core checks.
 */

export type Point = { readonly x: number; readonly y: number };

/** A box a pin is anchored in, and where in it: `within` is a fraction of the box's width and height. */
export type PinBox = { readonly rect: Rect; readonly within: Point };

/**
 * What was under the click.
 *
 * `source` is the part the page drew there, by its element tag
 * (`runtime/tags.ts`): where a TSX element is written, `file:line:column`,
 * or a spec element's key in the expanded page. `nth` tells its boxes apart
 * when the part drew several. `label` is the measured element there, as the
 * snapshot names it: its role, accessible name and HTML tag.
 *
 * A TSX tag is a place in a file, which another element can come to hold
 * after an edit, so a `source` of that kind also keeps `elsewhere`: a short
 * print (`anchor.ts`) of every named element the frame drew under another
 * tag when the pin was last found. It is what tells an element renamed where
 * it stands from a neighbour that moved into its place, and it is kept with
 * the pin so the answer is the same after a reload or an import. A spec's
 * key names its element whatever is around it, so a `key` source has none.
 * Absent on a pin stored before this was kept.
 */
export type PinSource = PinBox & { readonly tag: string; readonly nth: number } & ({ readonly kind: "key" } | { readonly kind: "source"; readonly elsewhere?: readonly string[] });

export type PinElement = {
  readonly source?: PinSource;
  readonly label?: PinBox & { readonly role: string; readonly name: string; readonly html: string };
};

/**
 * Where a pin is: the frame (scenario and view), the point in the page's CSS
 * px, the element under it, and the revision it was made on. `seen` is the
 * revision it was last found on; `lost` is set while its element is not on
 * the page any more, and then `point` is where it last was.
 *
 * `variant` is set for a note pinned on a variant of a page in the Variants
 * view: the variant's id. The note is then about that variant's frame, not
 * the prototype's, and its element is found on what the variant draws. A
 * note on the board, or on "Current" in the Variants view, has none.
 */
export type PinAnchor = {
  readonly scenario: string;
  readonly view: string;
  readonly variant?: string;
  /** The revision the pin was made on: a fingerprint of the prototype (`anchor.ts`). */
  readonly revision: string;
  readonly seen: string;
  readonly point: Point;
  readonly element?: PinElement;
  readonly lost?: true;
  /** What is drawn nearest the point, for the description the agent reads. */
  readonly near?: readonly string[];
  /** The view's size when the pin was last placed. */
  readonly size?: { readonly width: number; readonly height: number };
};

export type PinStatus = "open" | "addressed" | "closed";

export type PinEvent =
  | { readonly kind: "created"; readonly at: string; readonly by: "you"; readonly note: string }
  /** `note` is the new text; the text before it is the nearest earlier `created` or `edited`. */
  | { readonly kind: "edited"; readonly at: string; readonly by: "you"; readonly note: string }
  | { readonly kind: "addressed"; readonly at: string; readonly by: "agent"; readonly reply: string }
  | { readonly kind: "closed"; readonly at: string; readonly by: "you" }
  | { readonly kind: "reopened"; readonly at: string; readonly by: "you" }
  /** The person undid the agent's turn that addressed the note: it is open again, and that reply no longer stands. */
  | { readonly kind: "undone"; readonly at: string; readonly by: "you" }
  /**
   * The person applied a pick that took the note's part of the page from the
   * variant it was pinned on, so the note went with it onto the prototype
   * (`pick.ts`). `at` is the pick's own time, which names it among the picks
   * applied; `from` is the note's anchor on the variant as it was, which
   * undoing the pick puts back.
   */
  | { readonly kind: "picked"; readonly at: string; readonly by: "you"; readonly variant: string; readonly from: PinAnchor }
  /** The person undid that pick: the note is back on the variant, where it was. */
  | { readonly kind: "unpicked"; readonly at: string; readonly by: "you"; readonly variant: string };

export type Pin = {
  /** The pin's number on the canvas, from 1, never reused. */
  readonly number: number;
  readonly note: string;
  readonly status: PinStatus;
  /** The agent's latest reply, kept while the pin is addressed or closed after it. */
  readonly reply?: string;
  readonly anchor: PinAnchor;
  readonly history: readonly PinEvent[];
};

export type PinState = { readonly version: 1; readonly next: number; readonly pins: readonly Pin[] };

export const NO_PINS: PinState = { version: 1, next: 1, pins: [] };

export const MAX_NOTE_LENGTH = 2000;
export const MAX_REPLY_LENGTH = 600;
/** More pins than this on one prototype are refused: a pin is a note, not a log. */
export const MAX_PINS = 500;

export type PinResult = { readonly ok: true; readonly value: PinState } | { readonly ok: false; readonly error: string };

const refuse = (error: string): PinResult => ({ ok: false, error });

function replace(state: PinState, number: number, change: (pin: Pin) => Pin | string): PinResult {
  const pin = state.pins.find((item) => item.number === number);
  if (!pin) return refuse(`There is no note ${number}.`);
  const next = change(pin);
  if (typeof next === "string") return refuse(next);
  return { ok: true, value: { ...state, pins: state.pins.map((item) => (item === pin ? next : item)) } };
}

function cleanNote(text: string): string | null {
  const note = text.trim();
  return note.length === 0 || note.length > MAX_NOTE_LENGTH ? null : note;
}

/** A person's new pin: open, numbered, with the note as written. */
export function addPin(state: PinState, anchor: PinAnchor, text: string, at: string): PinResult {
  const note = cleanNote(text);
  if (note === null) return refuse(`A note needs some words, at most ${MAX_NOTE_LENGTH} characters.`);
  if (state.pins.length >= MAX_PINS) return refuse(`A prototype holds at most ${MAX_PINS} notes.`);
  const pin: Pin = { number: state.next, note, status: "open", anchor, history: [{ kind: "created", at, by: "you", note }] };
  return { ok: true, value: { version: 1, next: state.next + 1, pins: [...state.pins, pin] } };
}

/** A person rewrites their note. A note the agent had addressed is open again: the new words have not been answered. A closed note is reopened first. */
export function editPin(state: PinState, number: number, text: string, at: string): PinResult {
  const note = cleanNote(text);
  if (note === null) return refuse(`A note needs some words, at most ${MAX_NOTE_LENGTH} characters.`);
  return replace(state, number, (pin) => {
    if (pin.status === "closed") return `Note ${number} is closed. Reopen it to change it.`;
    if (pin.note === note) return pin;
    return { ...pin, note, status: "open", history: [...pin.history, { kind: "edited", at, by: "you", note }] };
  });
}

/** A person closes a note: it is done with, and stays in the list and on the canvas, quietly. */
export function closePin(state: PinState, number: number, at: string): PinResult {
  return replace(state, number, (pin) => (pin.status === "closed" ? `Note ${number} is already closed.` : { ...pin, status: "closed", history: [...pin.history, { kind: "closed", at, by: "you" }] }));
}

/** A person reopens a note, closed or addressed: the agent gets it again. */
export function reopenPin(state: PinState, number: number, at: string): PinResult {
  return replace(state, number, (pin) => (pin.status === "open" ? `Note ${number} is already open.` : { ...pin, status: "open", history: [...pin.history, { kind: "reopened", at, by: "you" }] }));
}

/**
 * The agent's one move: an open note becomes addressed, with a short reply.
 * It never touches the note's text, and cannot close, reopen or remove one.
 */
export function addressPin(state: PinState, number: number, text: string, at: string): PinResult {
  const reply = text.trim();
  if (reply.length === 0 || reply.length > MAX_REPLY_LENGTH) return refuse(`A reply needs some words, at most ${MAX_REPLY_LENGTH} characters.`);
  return replace(state, number, (pin) => {
    if (pin.status === "closed") return `Note ${number} is closed: the person closed it, and only the person reopens it.`;
    if (pin.status === "addressed") return `Note ${number} is already marked addressed. The person closes it or reopens it.`;
    return { ...pin, status: "addressed", reply, history: [...pin.history, { kind: "addressed", at, by: "agent", reply }] };
  });
}

/**
 * Undoing the agent's turn takes back what it did to a note: the note it
 * marked addressed is open again and its reply is dropped from the note (the
 * history keeps both). `event` is the place in the note's history of the
 * `addressed` entry that turn appended. It is taken back only while it is
 * still the last thing that happened to the note: once the person closed,
 * reopened or rewrote the note, that is theirs, and undoing the agent's turn
 * leaves it alone. Returns the same state when nothing is taken back.
 */
export function unaddressPin(state: PinState, number: number, event: number, at: string): PinState {
  const pin = state.pins.find((item) => item.number === number);
  if (!pin || pin.status !== "addressed" || pin.history.length - 1 !== event || pin.history[event]?.kind !== "addressed") return state;
  const { reply: _reply, ...rest } = pin;
  const next: Pin = { ...rest, status: "open", history: [...pin.history, { kind: "undone", at, by: "you" }] };
  return { ...state, pins: state.pins.map((item) => (item === pin ? next : item)) };
}

/** Replaces one pin's anchor, as re-anchoring does; nothing else about the pin changes. */
export function moveAnchor(state: PinState, number: number, anchor: PinAnchor): PinState {
  return { ...state, pins: state.pins.map((pin) => (pin.number === number ? { ...pin, anchor } : pin)) };
}

/**
 * The variant a note is away from: the one a pick took it off, while that
 * pick is not undone; null for a note no pick holds. False for a history
 * that could not have happened: a note picked twice with no undoing
 * between, or put back with no pick, or to another variant.
 */
export function awayOn(history: readonly PinEvent[]): string | null | false {
  let away: string | null = null;
  for (const event of history) {
    if (event.kind === "picked") {
      if (away !== null) return false;
      away = event.variant;
    } else if (event.kind === "unpicked") {
      if (away !== event.variant) return false;
      away = null;
    }
  }
  return away;
}

export const openPins = (state: PinState): Pin[] => state.pins.filter((pin) => pin.status === "open");

// ---- reading stored pins ---------------------------------------------------

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const only = (value: Json, keys: readonly string[]) => Object.keys(value).every((key) => keys.includes(key));
const text = (value: unknown, max: number, empty = false): value is string => typeof value === "string" && value.length <= max && (empty || value.length > 0);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1e7;
const point = (value: unknown): value is Point => isObject(value) && only(value, ["x", "y"]) && finite(value.x) && finite(value.y);
const rect = (value: unknown): value is Rect => isObject(value) && only(value, ["x", "y", "width", "height"]) && finite(value.x) && finite(value.y) && finite(value.width) && finite(value.height) && value.width >= 0 && value.height >= 0;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const slug = (value: unknown): value is string => typeof value === "string" && value.length <= 200 && SLUG.test(value);
/** A variant's id, as core gives them. */
const VARIANT = /^[a-z]{1,3}$/;
/** One print of `elsewhere` (`anchor.ts`), and how many a pin keeps at most. */
const PRINT = /^[0-9a-f]{8}$/;
export const MAX_ELSEWHERE = 256;

function elementOk(value: unknown): boolean {
  if (!isObject(value) || !only(value, ["source", "label"])) return false;
  const { source, label } = value;
  if (source !== undefined) {
    if (!isObject(source) || !(source.kind === "source" || source.kind === "key")) return false;
    // Only a place in a TSX file keeps what was drawn elsewhere.
    if (!only(source, source.kind === "source" ? ["tag", "kind", "nth", "rect", "within", "elsewhere"] : ["tag", "kind", "nth", "rect", "within"])) return false;
    if (!(text(source.tag, 1024) && Number.isSafeInteger(source.nth) && (source.nth as number) >= 0 && rect(source.rect) && point(source.within))) return false;
    const elsewhere = source.elsewhere;
    if (elsewhere !== undefined && !(Array.isArray(elsewhere) && elsewhere.length <= MAX_ELSEWHERE && elsewhere.every((item) => typeof item === "string" && PRINT.test(item)))) return false;
  }
  if (label !== undefined && !(isObject(label) && only(label, ["role", "name", "html", "rect", "within"]) && text(label.role, 200) && text(label.name, 4000, true) && text(label.html, 200) && rect(label.rect) && point(label.within))) return false;
  return true;
}

function anchorOk(value: unknown): boolean {
  if (!isObject(value) || !only(value, ["scenario", "view", "variant", "revision", "seen", "point", "element", "lost", "near", "size"])) return false;
  if (value.variant !== undefined && !(typeof value.variant === "string" && VARIANT.test(value.variant))) return false;
  // A variant is a spec page, so a note on one is never anchored to a place in a TSX file.
  if (value.variant !== undefined && isObject(value.element) && isObject(value.element.source) && value.element.source.kind !== "key") return false;
  if (!slug(value.scenario) || !slug(value.view) || !text(value.revision, 64) || !text(value.seen, 64) || !point(value.point)) return false;
  if (value.element !== undefined && !elementOk(value.element)) return false;
  if (value.lost !== undefined && value.lost !== true) return false;
  if (value.near !== undefined && !(Array.isArray(value.near) && value.near.length <= 8 && value.near.every((item) => text(item, 4000)))) return false;
  const size = value.size;
  if (size !== undefined && !(isObject(size) && only(size, ["width", "height"]) && finite(size.width) && finite(size.height) && size.width > 0 && size.height > 0)) return false;
  return true;
}

function eventOk(value: unknown): boolean {
  if (!isObject(value) || !text(value.at, 64)) return false;
  switch (value.kind) {
    case "created":
    case "edited":
      return only(value, ["kind", "at", "by", "note"]) && value.by === "you" && text(value.note, MAX_NOTE_LENGTH);
    case "addressed":
      return only(value, ["kind", "at", "by", "reply"]) && value.by === "agent" && text(value.reply, MAX_REPLY_LENGTH);
    case "closed":
    case "reopened":
    case "undone":
      return only(value, ["kind", "at", "by"]) && value.by === "you";
    case "picked":
      return only(value, ["kind", "at", "by", "variant", "from"]) && value.by === "you" && typeof value.variant === "string" && VARIANT.test(value.variant) && anchorOk(value.from) && (value.from as Json).variant === value.variant;
    case "unpicked":
      return only(value, ["kind", "at", "by", "variant"]) && value.by === "you" && typeof value.variant === "string" && VARIANT.test(value.variant);
    default:
      return false;
  }
}

/**
 * Reads stored or imported pins, trusting nothing: every field is checked,
 * an unknown field is a problem, and the list is refused whole on any
 * problem, each named by where it is.
 */
export function parsePinState(value: unknown): { readonly ok: true; readonly value: PinState } | { readonly ok: false; readonly error: readonly string[] } {
  if (!isObject(value) || !only(value, ["version", "next", "pins"]) || value.version !== 1) return { ok: false, error: ['$: expected pins as { "version": 1, "next", "pins" }'] };
  if (!Array.isArray(value.pins) || value.pins.length > MAX_PINS) return { ok: false, error: [`$.pins: expected a list of at most ${MAX_PINS} pins`] };
  const errors: string[] = [];
  const seen = new Set<number>();
  let highest = 0;
  value.pins.forEach((pin: unknown, index) => {
    const at = `$.pins[${index}]`;
    if (!isObject(pin) || !only(pin, ["number", "note", "status", "reply", "anchor", "history"])) return void errors.push(`${at}: expected a pin with number, note, status, anchor and history`);
    if (!Number.isSafeInteger(pin.number) || (pin.number as number) < 1) errors.push(`${at}.number: expected a whole number from 1`);
    else if (seen.has(pin.number as number)) errors.push(`${at}.number: note ${String(pin.number)} appears twice`);
    else {
      seen.add(pin.number as number);
      highest = Math.max(highest, pin.number as number);
    }
    if (!text(pin.note, MAX_NOTE_LENGTH)) errors.push(`${at}.note: expected some words, at most ${MAX_NOTE_LENGTH} characters`);
    if (pin.status !== "open" && pin.status !== "addressed" && pin.status !== "closed") errors.push(`${at}.status: expected "open", "addressed" or "closed"`);
    if (pin.reply !== undefined && !text(pin.reply, MAX_REPLY_LENGTH)) errors.push(`${at}.reply: expected some words, at most ${MAX_REPLY_LENGTH} characters`);
    if (!anchorOk(pin.anchor)) errors.push(`${at}.anchor: expected where the pin is: scenario, view, revision, point and the element under it`);
    if (!Array.isArray(pin.history) || pin.history.length === 0 || pin.history.length > 2000 || !pin.history.every(eventOk)) errors.push(`${at}.history: expected what happened to the pin, oldest first`);
    else if ((pin.history[0] as Json).kind !== "created") errors.push(`${at}.history: a pin's history starts with its creation`);
    // An agent's turn is undone only right after it addressed the note.
    else if ((pin.history as Json[]).some((event, place, all) => event.kind === "undone" && all[place - 1]?.kind !== "addressed")) errors.push(`${at}.history: a turn is undone only straight after the agent addressed the note`);
    else {
      // A pick takes a note off its variant and undoing it puts the note back, in turn; where the note is now is where the last of them left it.
      const away = awayOn(pin.history as unknown as readonly PinEvent[]);
      const variant = isObject(pin.anchor) ? pin.anchor.variant : undefined;
      if (away === false) errors.push(`${at}.history: a pick takes a note from its variant once, and only that pick's undoing puts it back`);
      else if (away !== null && variant !== undefined) errors.push(`${at}.anchor: a note that came with a pick is on the prototype, not on a variant`);
      else if (away === null) {
        const back = (pin.history as Json[]).filter((event) => event.kind === "unpicked").at(-1);
        if (back && back.variant !== variant) errors.push(`${at}.anchor: a note put back by undoing a pick is on the variant it came from`);
      }
    }
  });
  if (!Number.isSafeInteger(value.next) || (value.next as number) <= highest) errors.push("$.next: expected a number above every pin's");
  if (errors.length > 0) return { ok: false, error: errors };
  return { ok: true, value: value as unknown as PinState };
}
