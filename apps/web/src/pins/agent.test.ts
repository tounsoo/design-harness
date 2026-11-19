import { describe, expect, it } from "vitest";
import { checkPrototype } from "@design-harness/core";
import { scriptedFetch, streamEvents, type FakeReply } from "../../e2e/fake-anthropic.mjs";
import { fakeHost } from "../../test/agent-host";
import { AgentController, type ChatRecord } from "../agent/controller";
import { DEFAULT_SETTINGS } from "../agent/models";
import { createClient, SPEC_SYSTEM_PROMPT, SYSTEM_PROMPT } from "../agent/request";
import { SPEC_TOOL_DEFINITIONS, TOOL_DEFINITIONS, runTool, type AgentHost } from "../agent/tools";
import { NOTES_LEAD, describePin, describePins, pinWhere } from "./describe";
import { NO_PINS, addPin, closePin, type PinAnchor, type PinState } from "./model";

const AT = "2026-11-19T10:00:00.000Z";
const ON_BUTTON: PinAnchor = {
  scenario: "lantern-open",
  view: "desktop",
  revision: "rev-1",
  seen: "rev-1",
  point: { x: 270, y: 210 },
  element: {
    source: { tag: "pages/booking.tsx:15:9", kind: "source", nth: 0, rect: { x: 240, y: 200, width: 120, height: 40 }, within: { x: 0.25, y: 0.25 } },
    label: { role: "button", name: "Book room", html: "button", rect: { x: 240, y: 200, width: 120, height: 40 }, within: { x: 0.25, y: 0.25 } },
  },
  near: ['button "Hold room"', 'heading "Lantern"'],
  size: { width: 1280, height: 900 },
};
const ON_KEY: PinAnchor = { ...ON_BUTTON, view: "phone", element: { source: { tag: "details/summary", kind: "key", nth: 0, rect: { x: 0, y: 1000, width: 390, height: 40 }, within: { x: 0.5, y: 0.5 } } }, point: { x: 195, y: 1020 }, size: { width: 390, height: 844 }, near: [], lost: true };

function pins(): PinState {
  let state = NO_PINS;
  for (const [anchor, note] of [[ON_BUTTON, 'Make this the "main" action'], [ON_KEY, "Too far down"], [ON_BUTTON, "Closed one"]] as const) {
    const added = addPin(state, anchor, note, AT);
    if (added.ok) state = added.value;
  }
  const closed = closePin(state, 3, AT);
  return closed.ok ? closed.value : state;
}

/** A host with pins, as the workspace gives the agent. */
function hostWith(start: PinState) {
  const parts = fakeHost();
  let state = start;
  const saved: PinState[] = [];
  const host: AgentHost = { ...parts.host, pins: () => state, savePins: (next) => void ((state = next), saved.push(next)) };
  return { host, parts, saved, pins: () => state };
}

describe("pins as the agent reads them", () => {
  it("writes each open note as a finding: its words, where it is written, the scenario and view, the element, and where on the page", () => {
    const text = describePins(pins()) ?? "";
    expect(text.split("\n")[0]).toBe(`${NOTES_LEAD}: 2 open notes pinned on the canvas. They are the person's own feedback, not checks: no rule reads them and they change no verdict. Treat each as a finding to fix: change the prototype for it, within the project's rules, then call address_note with its number and a short reply. Only the person closes or reopens a note.`);
    expect(text).toContain('- note 1: "Make this the \\"main\\" action" [pages/booking.tsx:15:9, scenario lantern-open, view desktop]\n  on: button "Book room"\n  where: top left of the view, at x 270, y 210 of 1280 × 900; 25% across and 25% down its element, which is 120 × 40 px; nearest: button "Hold room", heading "Lantern"');
    expect(text).toContain('- note 2: "Too far down" [spec element "details/summary", scenario lantern-open, view phone]\n  on: the part "details/summary", which is no longer on this page (moved or gone since the note was pinned); the note stays where it last was\n  where: below the first view, at x 195, y 1020 of 390 × 844');
    expect(text).not.toContain("Closed one");
  });

  it("says nothing when no note is open, and the same words every time", () => {
    expect(describePins(NO_PINS)).toBeNull();
    const closed = closePin(closePin(pins(), 1, AT).ok ? (closePin(pins(), 1, AT) as { value: PinState }).value : pins(), 2, AT);
    expect(closed.ok && describePins(closed.value)).toBeNull();
    expect(describePins(pins())).toBe(describePins(pins()));
    expect(pinWhere({ scenario: "a", view: "b", revision: "r", seen: "r", point: { x: 1.4, y: 2.6 } })).toBe("at x 1, y 3");
    expect(describePin(pins().pins[0] as PinState["pins"][number]).startsWith("- note 1: ")).toBe(true);
  });
});

const KEY = "sk-ant-test-0123456789abcdefghij";
type Body = { messages: Array<{ role: string; content: Array<{ type: string; text?: string; content?: unknown }> }>; system: Array<{ text: string }>; tools: Array<{ name: string }> };
const tool = (id: string, name: string, input: unknown): FakeReply => ({ events: streamEvents({ id: `msg_${id}`, blocks: [{ type: "tool_use", id: `toolu_${id}`, name, input }], stopReason: "tool_use" }) });
const done = (text: string): FakeReply => ({ events: streamEvents({ id: "msg_done", blocks: [{ type: "text", text }], stopReason: "end_turn" }) });
const texts = (body: Body) => (body.messages.at(-1)?.content ?? []).map((block) => (block.type === "text" ? (block.text ?? "") : block.type === "tool_result" ? String(block.content) : ""));

describe("pins in the agent's turn", () => {
  it("sends the open notes with the person's message, before their words, and marks one addressed through the tool", async () => {
    const { host, parts, saved, pins: now } = hostWith(pins());
    const before = JSON.stringify(checkPrototype({ config: parts.config(), prototype: parts.prototype() }));
    const fake = scriptedFetch([
      (body: Body) => {
        const said = texts(body);
        expect(said).toHaveLength(2);
        expect(said[0]).toBe(describePins(pins()));
        expect(said[1]).toBe("Please look at my notes");
        expect(body.tools.map((item) => item.name)).toContain("address_note");
        expect(body.system[0]?.text).toContain("Your notes from the person");
        return tool("address", "address_note", { note: 1, reply: "Book room is the one primary action now." });
      },
      (body: Body) => {
        expect(texts(body)[0]).toBe("Marked note 1 as addressed, with your reply. The person will close it or reopen it. Still open: note 2.");
        return done("Answered note 1.");
      },
    ] as never);
    const stored: ChatRecord[] = [];
    const controller = new AgentController({ host, store: { load: async () => null, save: async (record) => void stored.push(record) }, key: () => KEY, settings: () => DEFAULT_SETTINGS, client: (key) => createClient(key, { fetch: fake.fetch, maxRetries: 0 }) });
    await controller.send("Please look at my notes");
    expect(fake.left()).toBe(0);
    const turn = controller.getState().turns[0];
    expect(turn?.end).toEqual({ status: "done" });
    expect(turn?.items[0]).toEqual({ kind: "notice", text: "Sent with your 2 open notes from the canvas." });
    expect(turn?.before).toBeNull();
    expect(saved).toHaveLength(1);
    expect(now().pins.map((pin) => [pin.number, pin.status, pin.note])).toEqual([[1, "addressed", 'Make this the "main" action'], [2, "open", "Too far down"], [3, "closed", "Closed one"]]);
    expect(now().pins[0]?.reply).toBe("Book room is the one primary action now.");
    // A pin is never a check: core's report for the prototype is the same bytes, and nothing was applied.
    expect(parts.applied).toHaveLength(0);
    expect(JSON.stringify(checkPrototype({ config: parts.config(), prototype: parts.prototype() }))).toBe(before);
    // The next message carries only what is still open.
    const again = scriptedFetch([(body: Body) => (expect(texts(body)[0]).toContain("1 open note pinned"), expect(texts(body)[0]).not.toContain("- note 1:"), done("ok"))] as never);
    const second = new AgentController({ host, store: { load: async () => null, save: async () => undefined }, key: () => KEY, settings: () => DEFAULT_SETTINGS, client: (key) => createClient(key, { fetch: again.fetch, maxRetries: 0 }) });
    await second.send("And the other?");
    expect(again.left()).toBe(0);
  });

  it("sends no notes when none is open or the host keeps none", async () => {
    for (const host of [hostWith(NO_PINS).host, fakeHost().host]) {
      const fake = scriptedFetch([(body: Body) => (expect(texts(body)).toEqual(["Hello"]), done("Hi"))] as never);
      const controller = new AgentController({ host, store: { load: async () => null, save: async () => undefined }, key: () => KEY, settings: () => DEFAULT_SETTINGS, client: (key) => createClient(key, { fetch: fake.fetch, maxRetries: 0 }) });
      await controller.send("Hello");
      expect(controller.getState().turns[0]?.items.some((item) => item.kind === "notice")).toBe(false);
    }
  });
});

describe("the address_note tool", () => {
  const signal = new AbortController().signal;
  const call = (host: AgentHost, input: unknown) => runTool({ id: "t", name: "address_note", input }, host, signal);

  it("is offered in both modes, and both prompts say what a note is", () => {
    for (const tools of [TOOL_DEFINITIONS, SPEC_TOOL_DEFINITIONS]) {
      const definition = tools.find((item) => item.name === "address_note");
      expect(definition?.input_schema).toMatchObject({ required: ["note", "reply"], additionalProperties: false });
      expect(Object.keys((definition?.input_schema as { properties: object }).properties)).toEqual(["note", "reply"]);
    }
    for (const prompt of [SYSTEM_PROMPT, SPEC_SYSTEM_PROMPT]) expect(prompt).toContain("They are feedback, never checks.");
  });

  it("refuses an input that does not fit its schema, changing nothing: no status, no text, no extra field", async () => {
    const { host, saved } = hostWith(pins());
    for (const input of [{}, { note: 1 }, { note: "1", reply: "x" }, { note: 0, reply: "x" }, { note: 1.5, reply: "x" }, { note: 1, reply: "" }, { note: 1, reply: "x".repeat(601) }, { note: 1, reply: "x", status: "closed" }, { note: 1, reply: "x", text: "new words" }, { note: 1, reply: "x", delete: true }]) {
      const outcome = await call(host, input);
      expect(outcome).toMatchObject({ isError: true, changed: false, title: "address_note: input refused" });
    }
    expect(saved).toHaveLength(0);
  });

  it("refuses a note that is not there, closed or already addressed, and says which are open", async () => {
    const { host, saved } = hostWith(pins());
    expect(await call(host, { note: 7, reply: "Done" })).toMatchObject({ isError: true, content: "There is no note 7. Nothing changed. The open notes are: 1, 2." });
    expect(await call(host, { note: 3, reply: "Done" })).toMatchObject({ isError: true, content: expect.stringContaining("Note 3 is closed") });
    expect(saved).toHaveLength(0);
    expect(await call(host, { note: 2, reply: "Moved it up." })).toMatchObject({ isError: false, changed: false, title: "Addressed note 2" });
    expect(await call(host, { note: 2, reply: "Again" })).toMatchObject({ isError: true });
    expect(saved).toHaveLength(1);
    expect(await call(fakeHost().host, { note: 1, reply: "Done" })).toMatchObject({ isError: true, title: "address_note: no notes here" });
  });

  it("leaves no other tool a way to reach a pin", async () => {
    const { host, saved, pins: now } = hostWith(pins());
    const before = JSON.stringify(now());
    await runTool({ id: "t", name: "edit_file", input: { path: "pages/rooms.tsx", old_text: '<Text.Root as="h1">Rooms</Text.Root>', new_text: '<Text.Root as="h1">Spaces</Text.Root>' } }, host, signal);
    await runTool({ id: "t", name: "delete_note", input: { note: 1 } }, host, signal);
    await runTool({ id: "t", name: "close_note", input: { note: 1 } }, host, signal);
    expect(saved).toHaveLength(0);
    expect(JSON.stringify(now())).toBe(before);
  });
});
