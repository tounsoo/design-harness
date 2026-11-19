import { describe, expect, it } from "vitest";
import { CURRENT, recombine, recombinedKey, type Prototype } from "@design-harness/core";
import { seedProject } from "../seed/nook";
import { seedSpec } from "../../test/nook";
import { reanchor, type FrameMeasure } from "./anchor";
import { describePins } from "./describe";
import { NO_PINS, addPin, addressPin, closePin, editPin, parsePinState, type PinAnchor, type PinResult, type PinState } from "./model";
import { carriedWords, carryWithPick, returnFromPick, returnedWords, type PickForPins } from "./pick";

/**
 * A variant's notes and a pick, on Nook's booking page: variant B asks the
 * question another way and keys its action "question" as well, so a pick of
 * B's body and action beside the current page renames both.
 */

const PAGE = "pages/booking.json";
type Spec = { root: string; elements: Record<string, { type: string; props?: Record<string, unknown>; slots?: Record<string, string[]> }> };
const prototype: Prototype = seedSpec();
const config = seedProject().config;
const current = prototype.files[PAGE] as string;
function variantB(): string {
  const spec = JSON.parse(current) as Spec;
  // The action is keyed "ask", which nothing else is; the hold button keeps its key, which the current page has too.
  spec.elements.ask = spec.elements.book as Spec["elements"][string];
  delete spec.elements.book;
  (spec.elements.page as { slots: Record<string, string[]> }).slots.action = ["ask"];
  return JSON.stringify(spec);
}
const scenarios = prototype.scenarios.filter((scenario) => scenario.page === "booking").map((scenario) => scenario.id);
const SCENARIO = scenarios[0] as string;

function pickOf(slots: Record<string, string>): PickForPins {
  const result = recombine(prototype, config, "booking", { [CURRENT]: current, b: variantB(), c: variantB() }, slots);
  if (!result.ok) throw new Error(result.error);
  return { scenarios, slots: result.value.slots, keyOf: (source, key) => recombinedKey(result.value, source, key) };
}
const ALL_CURRENT = { title: CURRENT, facts: CURRENT, body: CURRENT, alternate: CURRENT, action: CURRENT };
/** B gives the hold button (alternate) and the action; the rest is the page as it is. */
const SOME = pickOf({ ...ALL_CURRENT, alternate: "b", action: "b", body: "b" });
const WHOLE = pickOf({ title: "b", facts: "b", body: "b", alternate: "b", action: "b" });

const box = { rect: { x: 100, y: 200, width: 120, height: 40 }, within: { x: 0.5, y: 0.5 } };
const on = (tag: string | null, variant: string | undefined, more: Partial<PinAnchor> = {}): PinAnchor => ({
  scenario: SCENARIO,
  view: "desktop",
  ...(variant !== undefined ? { variant } : {}),
  revision: "rev-b",
  seen: "rev-b",
  point: { x: 160, y: 220 },
  ...(tag !== null ? { element: { source: { tag, kind: "key" as const, nth: 0, ...box }, label: { role: "button", name: "Hold room", html: "button", ...box } } } : {}),
  ...more,
});
const AT = "2026-11-19T10:00:00.000Z";
const PICKED = "2026-11-19T11:00:00.000Z";
const UNDONE = "2026-11-19T12:00:00.000Z";
const ok = (result: PinResult): PinState => {
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
const pinned = (...anchors: PinAnchor[]): PinState => anchors.reduce((state, anchor, index) => ok(addPin(state, anchor, `Note ${index + 1}`, AT)), NO_PINS);
const stored = (state: PinState) => parsePinState(JSON.parse(JSON.stringify(state)));

describe("a variant's notes when a pick is applied", () => {
  it("moves a note whose variant gave its element's slot onto the prototype, under the key the element has there", () => {
    // 1: B's hold button, a key the current page has too, so both are renamed. 2: B's action. 3: inside a layout instance of B's body.
    const state = pinned(on("hold", "b"), on("ask", "b"), on("details/summary", "b"));
    const { state: next, moved } = carryWithPick(state, SOME, PICKED);
    expect(moved).toEqual([{ note: 1, variant: "b" }, { note: 2, variant: "b" }, { note: 3, variant: "b" }]);
    expect(next.pins.map((pin) => [pin.anchor.variant, pin.anchor.element?.source?.tag])).toEqual([[undefined, "hold"], [undefined, "ask"], [undefined, "details/summary"]]);
    // Everything else about the anchor is as it was, for the board to place it by its own rules.
    const { variant: _variant, ...rest } = state.pins[1]?.anchor as PinAnchor;
    expect(next.pins[1]?.anchor).toEqual(rest);
    expect(next.pins[1]?.anchor.element?.label).toEqual(state.pins[1]?.anchor.element?.label);
    expect(stored(next)).toEqual({ ok: true, value: next });
  });

  it("names the element by its new key when recombining renamed it", () => {
    // D keys its action "name", as the current page keys its title: each is named for its source in the result.
    const d = JSON.parse(current) as Spec;
    d.elements.name = { ...(d.elements.book as Spec["elements"][string]) };
    delete d.elements.book;
    (d.elements.page as { slots: Record<string, string[]> }).slots = { ...(d.elements.page as { slots: Record<string, string[]> }).slots, title: [], action: ["name"] };
    const result = recombine(prototype, config, "booking", { [CURRENT]: current, d: JSON.stringify(d) }, { ...ALL_CURRENT, action: "d" });
    if (!result.ok) throw new Error(result.error);
    expect(result.value.renamed.map((item) => `${item.source}:${item.from}->${item.to}`)).toEqual(["current:name->name-current", "d:name->name-d"]);
    const pick: PickForPins = { scenarios, slots: result.value.slots, keyOf: (source, key) => recombinedKey(result.value, source, key) };
    const { state: next, moved } = carryWithPick(pinned(on("name", "d"), on("name/inner", "d"), on("hold", "d")), pick, PICKED);
    expect(moved.map((item) => item.note)).toEqual([1, 2]);
    expect(next.pins.map((pin) => [pin.anchor.variant, pin.anchor.element?.source?.tag])).toEqual([[undefined, "name-d"], [undefined, "name-d/inner"], ["d", "hold"]]);
  });

  it("keeps the note's number, words, state, reply and history, and adds an entry saying it came with the pick", () => {
    const state = ok(addressPin(ok(editPin(pinned(on("hold", "b"), on("ask", "b")), 1, "Make it quieter", AT)), 1, "Made it ghost.", AT));
    const { state: next } = carryWithPick(state, SOME, PICKED);
    const [before, after] = [state.pins[0], next.pins[0]];
    expect(after).toMatchObject({ number: 1, note: "Make it quieter", status: "addressed", reply: "Made it ghost." });
    expect(after?.history.slice(0, -1)).toEqual(before?.history);
    expect(after?.history.at(-1)).toEqual({ kind: "picked", at: PICKED, by: "you", variant: "b", from: before?.anchor });
    expect(next.next).toBe(state.next);
    expect(next.pins.map((pin) => pin.number)).toEqual([1, 2]);
  });

  it("leaves a note on a slot the pick did not take on its variant", () => {
    // The title and the facts stay the current page's; C is not used at all.
    const state = pinned(on("name", "b"), on("seats", "b"), on("page/slots/title", "b"), on("hold", "c"), on("hold", undefined));
    const { state: next, moved } = carryWithPick(state, SOME, PICKED);
    expect(moved).toEqual([]);
    expect(next).toBe(state);
  });

  it("moves a note on a slot itself with the slot, and one on the bare page only when the whole page came from its variant", () => {
    const state = pinned(on("page/slots/action", "b"), on("page", "b"), on(null, "b"));
    expect(carryWithPick(state, SOME, PICKED).moved.map((item) => item.note)).toEqual([1]);
    const whole = carryWithPick(state, WHOLE, PICKED);
    expect(whole.moved.map((item) => item.note)).toEqual([1, 2, 3]);
    expect(whole.state.pins.map((pin) => pin.anchor.element?.source?.tag)).toEqual(["page/slots/action", "page", undefined]);
    expect(whole.state.pins.every((pin) => pin.anchor.variant === undefined)).toBe(true);
  });

  it("leaves a closed note where it was, and one whose element is already gone from its variant, and one on another page's scenario", () => {
    const state = ok(closePin(pinned(on("hold", "b"), on("hold", "b", { lost: true }), on("hold", "b", { scenario: "some-other-page" }), on("hold", "b")), 1, AT));
    const { state: next, moved } = carryWithPick(state, SOME, PICKED);
    expect(moved).toEqual([{ note: 4, variant: "b" }]);
    expect(next.pins.slice(0, 3)).toEqual(state.pins.slice(0, 3));
  });

  it("is then placed on what the prototype draws, by the board's own rules", () => {
    const { state: next } = carryWithPick(pinned(on("ask", "b")), SOME, PICKED);
    // The new revision draws the button elsewhere: the note follows its key, keeping its place within the box.
    const measure: FrameMeasure = {
      snapshot: { scenario: SCENARIO, view: "desktop", scrollWidth: 1280, canvas: [255, 255, 255, 1], elements: [{ role: "button", name: "Hold room", tag: "button", rect: { x: 400, y: 600, width: 200, height: 40 }, interactive: true, visible: true }] },
      places: [{ tag: "ask", rect: { x: 400, y: 600, width: 200, height: 40 } }],
      width: 1280,
      height: 900,
    };
    const frames = { [`${SCENARIO}@desktop`]: measure };
    // Still on the variant, the board's placing would not touch it.
    expect(reanchor(pinned(on("ask", "b")), frames, "rev-new", "key")).toEqual(pinned(on("ask", "b")));
    const placed = reanchor(next, frames, "rev-new", "key");
    expect(placed.pins[0]?.anchor).toMatchObject({ point: { x: 500, y: 620 }, seen: "rev-new", revision: "rev-b" });
    expect(placed.pins[0]?.anchor.lost).toBeUndefined();
    expect(placed.pins[0]?.anchor.variant).toBeUndefined();
    // The agent reads it as a note on the prototype's page.
    expect(describePins(placed)).toContain(`[spec element "ask", scenario ${SCENARIO}, view desktop]`);
    expect(describePins(placed)).not.toContain("variant");
  });
});

describe("undoing the pick", () => {
  const state = pinned(on("hold", "b"), on("ask", "b"), on("name", "b"), on("hold", undefined));
  const applied = carryWithPick(state, SOME, PICKED).state;

  it("puts every note the pick moved back on its variant, as it was, and says so in its history", () => {
    const { state: back, returned } = returnFromPick(applied, PICKED, UNDONE);
    expect(returned).toEqual([{ note: 1, variant: "b" }, { note: 2, variant: "b" }]);
    expect(back.pins.map((pin) => pin.anchor)).toEqual(state.pins.map((pin) => pin.anchor));
    expect(back.pins[0]?.history.slice(-2)).toEqual([{ kind: "picked", at: PICKED, by: "you", variant: "b", from: state.pins[0]?.anchor }, { kind: "unpicked", at: UNDONE, by: "you", variant: "b" }]);
    // The notes the pick did not move are the same objects.
    expect(back.pins[2]).toBe(state.pins[2]);
    expect(back.pins[3]).toBe(state.pins[3]);
    expect(stored(back)).toEqual({ ok: true, value: back });
  });

  it("puts a note back where it was on the variant, wherever the board placed it since, with what happened to it since kept", () => {
    const moved = applied.pins[0] as PinState["pins"][number];
    const since: PinState = { ...applied, pins: [{ ...moved, anchor: { ...moved.anchor, point: { x: 9, y: 9 }, seen: "rev-new", lost: true } }, ...applied.pins.slice(1)] };
    const closed = ok(closePin(ok(addressPin(since, 2, "Done.", AT)), 1, AT));
    const { state: back, returned } = returnFromPick(closed, PICKED, UNDONE);
    expect(returned.map((item) => item.note)).toEqual([1, 2]);
    expect(back.pins[0]?.anchor).toEqual(state.pins[0]?.anchor);
    expect(back.pins[0]).toMatchObject({ status: "closed" });
    expect(back.pins[1]).toMatchObject({ status: "addressed", reply: "Done." });
    expect(back.pins[1]?.history.map((event) => event.kind)).toEqual(["created", "picked", "addressed", "unpicked"]);
  });

  it("touches only that pick's notes, and nothing twice", () => {
    expect(returnFromPick(applied, "2026-11-19T11:30:00.000Z", UNDONE)).toEqual({ state: applied, returned: [] });
    expect(returnFromPick(state, PICKED, UNDONE).state).toBe(state);
    const back = returnFromPick(applied, PICKED, UNDONE).state;
    expect(returnFromPick(back, PICKED, UNDONE).state).toBe(back);
  });

  it("lets the same pick be applied again after it, and undone again", () => {
    const back = returnFromPick(applied, PICKED, UNDONE).state;
    const again = carryWithPick(back, SOME, "2026-11-19T13:00:00.000Z");
    expect(again.moved.map((item) => item.note)).toEqual([1, 2]);
    expect(again.state.pins[0]?.history.map((event) => event.kind)).toEqual(["created", "picked", "unpicked", "picked"]);
    expect(stored(again.state)).toMatchObject({ ok: true });
    // The earlier pick's time no longer names these notes.
    expect(returnFromPick(again.state, PICKED, UNDONE).returned).toEqual([]);
    expect(returnFromPick(again.state, "2026-11-19T13:00:00.000Z", UNDONE).returned.map((item) => item.note)).toEqual([1, 2]);
  });
});

describe("what the person is told", () => {
  it("says how many notes came along, and from where", () => {
    expect(carriedWords([])).toBeNull();
    expect(carriedWords([{ note: 3, variant: "b" }])).toBe("1 note came along from Variant B (note 3): it is on the board now, under Your notes.");
    expect(carriedWords([{ note: 4, variant: "c" }, { note: 3, variant: "b" }, { note: 7, variant: "b" }])).toBe("3 notes came along from Variant B and Variant C (notes 3, 4 and 7): they are on the board now, under Your notes.");
    expect(returnedWords([])).toBeNull();
    expect(returnedWords([{ note: 3, variant: "b" }])).toBe("1 note is back on Variant B, where it was (note 3).");
    expect(returnedWords([{ note: 4, variant: "b" }, { note: 3, variant: "b" }])).toBe("2 notes are back on Variant B, where they were (notes 3 and 4).");
  });
});

describe("reading stored notes a pick moved", () => {
  const applied = carryWithPick(pinned(on("hold", "b"), on("name", "b")), SOME, PICKED).state;
  const back = returnFromPick(applied, PICKED, UNDONE).state;
  const json = (state: PinState) => JSON.parse(JSON.stringify(state)) as { pins: { anchor: Record<string, unknown>; history: Record<string, unknown>[] }[] };
  const withPin = (state: PinState, change: (pin: { anchor: Record<string, unknown>; history: Record<string, unknown>[] }) => unknown) => {
    const value = json(state);
    return parsePinState({ ...value, pins: [change(value.pins[0] as { anchor: Record<string, unknown>; history: Record<string, unknown>[] }), value.pins[1]] });
  };

  it("takes back exactly what was kept, moved and put back", () => {
    expect(stored(applied)).toEqual({ ok: true, value: applied });
    expect(stored(back)).toEqual({ ok: true, value: back });
  });

  it("refuses an entry out of shape", () => {
    const entry = (change: (event: Record<string, unknown>) => Record<string, unknown>) => withPin(applied, (pin) => ({ ...pin, history: [pin.history[0], change(pin.history[1] as Record<string, unknown>)] }));
    expect(entry((event) => event)).toMatchObject({ ok: true });
    for (const change of [
      (event: Record<string, unknown>) => ({ ...event, by: "agent" }),
      (event: Record<string, unknown>) => ({ ...event, variant: "B" }),
      (event: Record<string, unknown>) => ({ ...event, variant: "c" }),
      (event: Record<string, unknown>) => ({ ...event, from: undefined }),
      (event: Record<string, unknown>) => ({ ...event, from: { ...(event.from as object), variant: undefined } }),
      (event: Record<string, unknown>) => ({ ...event, from: { ...(event.from as object), scenario: "Not A Slug" } }),
      (event: Record<string, unknown>) => ({ ...event, pick: 3 }),
    ]) {
      expect(entry(change)).toMatchObject({ ok: false, error: [expect.stringContaining("$.pins[0].history")] });
    }
    const undone = (change: (event: Record<string, unknown>) => Record<string, unknown>) => withPin(back, (pin) => ({ ...pin, history: [pin.history[0], pin.history[1], change(pin.history[2] as Record<string, unknown>)] }));
    expect(undone((event) => event)).toMatchObject({ ok: true });
    expect(undone((event) => ({ ...event, variant: "c" }))).toMatchObject({ ok: false });
    expect(undone((event) => ({ ...event, by: "agent" }))).toMatchObject({ ok: false });
    expect(undone((event) => ({ ...event, from: {} }))).toMatchObject({ ok: false });
  });

  it("refuses a history that could not have happened, and a note that is not where its history left it", () => {
    const picked = json(applied).pins[0]?.history[1];
    const unpicked = json(back).pins[0]?.history[2];
    // Put back with no pick; picked twice with no undoing between.
    expect(withPin(back, (pin) => ({ ...pin, history: [pin.history[0], unpicked] }))).toMatchObject({ ok: false, error: [expect.stringContaining("$.pins[0].history")] });
    expect(withPin(applied, (pin) => ({ ...pin, history: [pin.history[0], picked, picked] }))).toMatchObject({ ok: false, error: [expect.stringContaining("$.pins[0].history")] });
    // Moved by a pick, yet on a variant; put back, yet not on that variant.
    expect(withPin(applied, (pin) => ({ ...pin, anchor: { ...pin.anchor, variant: "b" } }))).toMatchObject({ ok: false, error: [expect.stringContaining("$.pins[0].anchor")] });
    expect(withPin(back, (pin) => ({ ...pin, anchor: { ...pin.anchor, variant: undefined } }))).toMatchObject({ ok: false, error: [expect.stringContaining("$.pins[0].anchor")] });
    expect(withPin(back, (pin) => ({ ...pin, anchor: { ...pin.anchor, variant: "c" } }))).toMatchObject({ ok: false, error: [expect.stringContaining("$.pins[0].anchor")] });
  });
});
