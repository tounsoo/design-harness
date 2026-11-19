import { describe, expect, it } from "vitest";
import { NO_PINS, MAX_NOTE_LENGTH, addPin, addressPin, closePin, editPin, openPins, parsePinState, reopenPin, type PinAnchor, type PinResult, type PinState } from "./model";

const ANCHOR: PinAnchor = { scenario: "lantern-open", view: "desktop", revision: "rev-1", seen: "rev-1", point: { x: 270, y: 210 } };
const AT = "2026-11-19T10:00:00.000Z";
const ok = (result: PinResult): PinState => {
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
const two = () => ok(addPin(ok(addPin(NO_PINS, ANCHOR, "  Make this bigger  ", AT)), ANCHOR, "Second", AT));

describe("the pin store", () => {
  it("numbers notes from 1, never reusing a number, and keeps the words as written, trimmed", () => {
    const state = two();
    expect(state.pins.map((pin) => [pin.number, pin.note, pin.status])).toEqual([[1, "Make this bigger", "open"], [2, "Second", "open"]]);
    expect(state.next).toBe(3);
    expect(state.pins[0]?.history).toEqual([{ kind: "created", at: AT, by: "you", note: "Make this bigger" }]);
    expect(NO_PINS.pins).toEqual([]);
  });

  it("refuses a note with no words or too many", () => {
    expect(addPin(NO_PINS, ANCHOR, "   ", AT)).toMatchObject({ ok: false });
    expect(addPin(NO_PINS, ANCHOR, "x".repeat(MAX_NOTE_LENGTH + 1), AT)).toMatchObject({ ok: false });
    expect(editPin(two(), 1, "", AT)).toMatchObject({ ok: false });
  });

  it("lets the agent mark an open note addressed with a reply, and nothing else: not its words, not a closed one, not twice", () => {
    const addressed = ok(addressPin(two(), 1, " Made it primary. ", "2026-11-19T10:05:00.000Z"));
    expect(addressed.pins[0]).toMatchObject({ note: "Make this bigger", status: "addressed", reply: "Made it primary." });
    expect(addressed.pins[0]?.history.at(-1)).toEqual({ kind: "addressed", at: "2026-11-19T10:05:00.000Z", by: "agent", reply: "Made it primary." });
    expect(addressed.pins[1]?.status).toBe("open");
    expect(addressPin(addressed, 1, "Again", AT)).toMatchObject({ ok: false, error: expect.stringContaining("already marked addressed") });
    expect(addressPin(addressed, 9, "x", AT)).toEqual({ ok: false, error: "There is no note 9." });
    expect(addressPin(two(), 1, "  ", AT)).toMatchObject({ ok: false });
    expect(addressPin(two(), 1, "x".repeat(601), AT)).toMatchObject({ ok: false });
    const closed = ok(closePin(two(), 2, AT));
    expect(addressPin(closed, 2, "Done", AT)).toMatchObject({ ok: false, error: expect.stringContaining("only the person reopens it") });
  });

  it("lets a person close and reopen, and keeps every step in the history", () => {
    let state = ok(addressPin(two(), 1, "Done.", AT));
    state = ok(closePin(state, 1, AT));
    expect(state.pins[0]).toMatchObject({ status: "closed", reply: "Done." });
    expect(closePin(state, 1, AT)).toMatchObject({ ok: false });
    expect(editPin(state, 1, "Other words", AT)).toMatchObject({ ok: false, error: expect.stringContaining("Reopen it") });
    state = ok(reopenPin(state, 1, AT));
    expect(state.pins[0]?.status).toBe("open");
    expect(reopenPin(state, 1, AT)).toMatchObject({ ok: false });
    expect(state.pins[0]?.history.map((event) => event.kind)).toEqual(["created", "addressed", "closed", "reopened"]);
    expect(openPins(state).map((pin) => pin.number)).toEqual([1, 2]);
  });

  it("opens an addressed note again when the person rewrites it, keeping the words before in its history", () => {
    const state = ok(editPin(ok(addressPin(two(), 1, "Done.", AT)), 1, "Bigger still", AT));
    expect(state.pins[0]).toMatchObject({ note: "Bigger still", status: "open" });
    expect(state.pins[0]?.history.map((event) => (event.kind === "created" || event.kind === "edited" ? event.note : event.kind))).toEqual(["Make this bigger", "addressed", "Bigger still"]);
    const same = ok(editPin(two(), 2, "Second", AT));
    expect(same.pins[1]?.history).toHaveLength(1);
  });

  it("has no way to remove a pin: every operation keeps every pin", () => {
    let state = two();
    for (const step of [(s: PinState) => addressPin(s, 1, "r", AT), (s: PinState) => closePin(s, 1, AT), (s: PinState) => reopenPin(s, 1, AT), (s: PinState) => editPin(s, 2, "e", AT), (s: PinState) => closePin(s, 2, AT)]) {
      state = ok(step(state));
      expect(state.pins.map((pin) => pin.number)).toEqual([1, 2]);
    }
  });
});

describe("reading stored pins", () => {
  it("takes back exactly what was kept", () => {
    const state = ok(closePin(ok(addressPin(two(), 1, "Done.", AT)), 1, AT));
    expect(parsePinState(JSON.parse(JSON.stringify(state)))).toEqual({ ok: true, value: state });
    expect(parsePinState(NO_PINS)).toEqual({ ok: true, value: NO_PINS });
  });

  it("refuses what is malformed, naming where", () => {
    const state = JSON.parse(JSON.stringify(two())) as { next: number; pins: Record<string, unknown>[] };
    expect(parsePinState(null)).toMatchObject({ ok: false });
    expect(parsePinState({ ...state, version: 2 })).toMatchObject({ ok: false });
    expect(parsePinState({ ...state, extra: 1 })).toMatchObject({ ok: false });
    expect(parsePinState({ ...state, next: 2 })).toEqual({ ok: false, error: ["$.next: expected a number above every pin's"] });
    expect(parsePinState({ ...state, pins: [{ ...state.pins[0], status: "passed" }, state.pins[1]] })).toMatchObject({ ok: false, error: [expect.stringContaining("$.pins[0].status")] });
    expect(parsePinState({ ...state, pins: [state.pins[0], { ...state.pins[1], number: 1 }] })).toMatchObject({ ok: false, error: [expect.stringContaining("appears twice")] });
    expect(parsePinState({ ...state, pins: [{ ...state.pins[0], anchor: { scenario: "Lantern Open" } }, state.pins[1]] })).toMatchObject({ ok: false, error: [expect.stringContaining("$.pins[0].anchor")] });
    expect(parsePinState({ ...state, pins: [{ ...state.pins[0], history: [{ kind: "addressed", at: AT, by: "you", reply: "x" }] }, state.pins[1]] })).toMatchObject({ ok: false, error: [expect.stringContaining("$.pins[0].history")] });
    expect(parsePinState({ ...state, pins: [{ ...state.pins[0], verdict: "pass" }, state.pins[1]] })).toMatchObject({ ok: false });
  });
});
