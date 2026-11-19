import { describe, expect, it } from "vitest";
import { NO_PINS, MAX_NOTE_LENGTH, addPin, addressPin, closePin, editPin, openPins, parsePinState, reopenPin, unaddressPin, type PinAnchor, type PinResult, type PinState } from "./model";

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

describe("undoing the agent's turn", () => {
  const LATER = "2026-11-19T10:09:00.000Z";
  const addressed = () => ok(addressPin(two(), 1, "Made it primary.", "2026-11-19T10:05:00.000Z"));

  it("opens the note the turn addressed again, drops the reply from it, and keeps both in the history", () => {
    const start = addressed();
    const back = unaddressPin(start, 1, 1, LATER);
    expect(back.pins[0]).toMatchObject({ number: 1, note: "Make this bigger", status: "open" });
    expect(back.pins[0] && "reply" in back.pins[0]).toBe(false);
    expect(back.pins[0]?.history.map((event) => event.kind)).toEqual(["created", "addressed", "undone"]);
    expect(back.pins[0]?.history.at(-1)).toEqual({ kind: "undone", at: LATER, by: "you" });
    expect(back.pins[0]?.history[1]).toMatchObject({ reply: "Made it primary." });
    expect(back.pins[1]).toBe(start.pins[1]);
    // It is open, so the agent gets it again and may address it again.
    expect(openPins(back).map((pin) => pin.number)).toEqual([1, 2]);
    expect(addressPin(back, 1, "Second try.", LATER)).toMatchObject({ ok: true });
    expect(parsePinState(JSON.parse(JSON.stringify(back)))).toEqual({ ok: true, value: back });
  });

  it("leaves alone what the person did since: a note they closed, reopened or rewrote is theirs", () => {
    for (const mine of [(s: PinState) => closePin(s, 1, AT), (s: PinState) => reopenPin(s, 1, AT), (s: PinState) => editPin(s, 1, "Bigger still", AT)]) {
      const state = ok(mine(addressed()));
      expect(unaddressPin(state, 1, 1, LATER)).toBe(state);
    }
    // Reopened by the person and addressed again by a later turn: the earlier turn's undo does not take the later reply back.
    const again = ok(addressPin(ok(reopenPin(addressed(), 1, AT)), 1, "Another go.", AT));
    expect(unaddressPin(again, 1, 1, LATER)).toBe(again);
    expect(unaddressPin(again, 1, 3, LATER).pins[0]).toMatchObject({ status: "open" });
  });

  it("changes nothing for a note that is not there, was never addressed, or an entry that is not the agent's", () => {
    const state = addressed();
    expect(unaddressPin(state, 9, 1, LATER)).toBe(state);
    expect(unaddressPin(state, 2, 0, LATER)).toBe(state);
    expect(unaddressPin(state, 1, 0, LATER)).toBe(state);
    expect(unaddressPin(state, 1, 5, LATER)).toBe(state);
  });
});

describe("reading stored pins", () => {
  it("reads a note on a variant, and what a TSX pin keeps of its frame, and refuses either out of shape", () => {
    const box = { rect: { x: 0, y: 0, width: 10, height: 10 }, within: { x: 0.5, y: 0.5 } };
    const withAnchor = (anchor: unknown) => parsePinState({ version: 1, next: 2, pins: [{ number: 1, note: "n", status: "open", anchor, history: [{ kind: "created", at: AT, by: "you", note: "n" }] }] });
    const tsx = { ...ANCHOR, element: { source: { tag: "pages/a.tsx:1:1", kind: "source", nth: 0, ...box, elsewhere: ["0a1b2c3d", "ffffffff"] } } };
    const key = { ...ANCHOR, variant: "b", element: { source: { tag: "hold", kind: "key", nth: 0, ...box } } };
    expect(withAnchor(tsx)).toMatchObject({ ok: true });
    expect(withAnchor({ ...tsx, element: { source: { ...tsx.element.source, elsewhere: [] } } })).toMatchObject({ ok: true });
    expect(withAnchor(key)).toMatchObject({ ok: true });
    // Prints are 8 hex digits, a list, and at most 256 of them; a spec key keeps none.
    for (const elsewhere of [["xyz"], ["0A1B2C3D"], ["0a1b2c3d9"], [12345678], "0a1b2c3d", Array.from({ length: 257 }, () => "0a1b2c3d")]) {
      expect(withAnchor({ ...tsx, element: { source: { ...tsx.element.source, elsewhere } } })).toMatchObject({ ok: false, error: [expect.stringContaining("$.pins[0].anchor")] });
    }
    expect(withAnchor({ ...key, element: { source: { ...key.element.source, elsewhere: [] } } })).toMatchObject({ ok: false });
    expect(withAnchor({ ...tsx, element: { source: { ...tsx.element.source, before: {} } } })).toMatchObject({ ok: false });
    // A variant's id is core's, and a variant is a spec page, so its note is never on a place in a TSX file.
    for (const variant of ["B", "", "abcd", "current", 2]) expect(withAnchor({ ...key, variant })).toMatchObject({ ok: false });
    expect(withAnchor({ ...tsx, variant: "b" })).toMatchObject({ ok: false });
  });

  it("refuses an undone entry that does not follow the agent's reply", () => {
    const state = JSON.parse(JSON.stringify(two())) as { next: number; pins: { history: unknown[] }[] };
    const undone = { kind: "undone", at: AT, by: "you" };
    const withHistory = (history: unknown[]) => parsePinState({ ...state, pins: [{ ...state.pins[0], history }, state.pins[1]] });
    const created = state.pins[0]?.history[0];
    expect(withHistory([created, { kind: "addressed", at: AT, by: "agent", reply: "r" }, undone])).toMatchObject({ ok: true });
    expect(withHistory([created, undone])).toMatchObject({ ok: false, error: [expect.stringContaining("$.pins[0].history")] });
    expect(withHistory([created, { kind: "addressed", at: AT, by: "agent", reply: "r" }, { ...undone, by: "agent" }])).toMatchObject({ ok: false });
    expect(withHistory([created, { kind: "addressed", at: AT, by: "agent", reply: "r" }, { ...undone, reply: "x" }])).toMatchObject({ ok: false });
  });


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
