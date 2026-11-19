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
 */
export type PinElement = {
  readonly source?: PinBox & { readonly tag: string; readonly kind: "source" | "key"; readonly nth: number };
  readonly label?: PinBox & { readonly role: string; readonly name: string; readonly html: string };
};

/**
 * Where a pin is: the frame (scenario and view), the point in the page's CSS
 * px, the element under it, and the revision it was made on. `seen` is the
 * revision it was last found on; `lost` is set while its element is not on
 * the page any more, and then `point` is where it last was.
 */
export type PinAnchor = {
  readonly scenario: string;
  readonly view: string;
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
  | { readonly kind: "reopened"; readonly at: string; readonly by: "you" };

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

/** Replaces one pin's anchor, as re-anchoring does; nothing else about the pin changes. */
export function moveAnchor(state: PinState, number: number, anchor: PinAnchor): PinState {
  return { ...state, pins: state.pins.map((pin) => (pin.number === number ? { ...pin, anchor } : pin)) };
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

function elementOk(value: unknown): boolean {
  if (!isObject(value) || !only(value, ["source", "label"])) return false;
  const { source, label } = value;
  if (source !== undefined && !(isObject(source) && only(source, ["tag", "kind", "nth", "rect", "within"]) && text(source.tag, 1024) && (source.kind === "source" || source.kind === "key") && Number.isSafeInteger(source.nth) && (source.nth as number) >= 0 && rect(source.rect) && point(source.within))) return false;
  if (label !== undefined && !(isObject(label) && only(label, ["role", "name", "html", "rect", "within"]) && text(label.role, 200) && text(label.name, 4000, true) && text(label.html, 200) && rect(label.rect) && point(label.within))) return false;
  return true;
}

function anchorOk(value: unknown): boolean {
  if (!isObject(value) || !only(value, ["scenario", "view", "revision", "seen", "point", "element", "lost", "near", "size"])) return false;
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
      return only(value, ["kind", "at", "by"]) && value.by === "you";
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
  });
  if (!Number.isSafeInteger(value.next) || (value.next as number) <= highest) errors.push("$.next: expected a number above every pin's");
  if (errors.length > 0) return { ok: false, error: errors };
  return { ok: true, value: value as unknown as PinState };
}
