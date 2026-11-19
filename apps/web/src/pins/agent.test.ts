import { describe, expect, it } from "vitest";
import { checkPrototype } from "@design-harness/core";
import { scriptedFetch, streamEvents, type FakeReply } from "../../e2e/fake-anthropic.mjs";
import { fakeHost } from "../../test/agent-host";
import { AgentController, type ChatRecord } from "../agent/controller";
import { DEFAULT_SETTINGS } from "../agent/models";
import { createClient, SYSTEM_PROMPT } from "../agent/request";
import { TOOL_DEFINITIONS, runTool, type AgentHost } from "../agent/tools";
import { NOTES_LEAD, describePin, describePins, pinWhere } from "./describe";
import { seedSpec } from "../../test/nook";
import { NO_PINS, addPin, closePin, editPin, reopenPin, type PinAnchor, type PinState } from "./model";

const AT = "2026-11-19T10:00:00.000Z";
const ON_BUTTON: PinAnchor = {
  scenario: "lantern-open",
  view: "desktop",
  revision: "rev-1",
  seen: "rev-1",
  point: { x: 270, y: 210 },
  element: {
    source: { tag: "book", kind: "key", nth: 0, rect: { x: 240, y: 200, width: 120, height: 40 }, within: { x: 0.25, y: 0.25 } },
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
    expect(text).toContain('- note 1: "Make this the \\"main\\" action" [spec element "book", scenario lantern-open, view desktop]\n  on: button "Book room"\n  where: top left of the view, at x 270, y 210 of 1280 × 900; 25% across and 25% down its element, which is 120 × 40 px; nearest: button "Hold room", heading "Lantern"');
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

describe("undoing a turn that addressed a note", () => {
  const RENAME = { path: "pages/rooms.json", patches: '{"op":"replace","path":"/elements/heading/props/text","value":"Spaces"}' };
  const agent = (host: AgentHost, replies: unknown[]) => {
    const fake = scriptedFetch(replies as never);
    const stored: ChatRecord[] = [];
    const controller = new AgentController({ host, store: { load: async () => null, save: async (record) => void stored.push(record) }, key: () => KEY, settings: () => DEFAULT_SETTINGS, client: (key) => createClient(key, { fetch: fake.fetch, maxRetries: 0 }) });
    return { controller, fake, stored };
  };
  /** A turn that patches a spec, then marks notes 1 and 2 addressed. */
  const editAndAddress = [tool("edit", "patch_spec", RENAME), tool("one", "address_note", { note: 1, reply: "Renamed the page." }), tool("two", "address_note", { note: 2, reply: "Moved it up." }), done("Done.")];

  it("puts the prototype back and opens the notes again, their replies dropped, as one step, and tells the agent", async () => {
    const { host, parts, pins: now } = hostWith(pins());
    const start = parts.prototype();
    const history: number[] = [];
    const { controller, fake, stored } = agent(host, [
      ...editAndAddress,
      (body: Body) => {
        const said = texts(body);
        // The agent is told with the next message, and gets the notes again since they are open again.
        expect(said[0]).toBe('The person undid your changes from their message "Please look at my notes": the prototype is back to what it was before that message. Read the files again before you change them. Also, notes 1, 2 are open again, and your replies to them were withdrawn.');
        expect(said[1]).toContain("2 open notes pinned");
        expect(said[2]).toBe("Try again");
        history.push(body.messages.length);
        return done("ok");
      },
    ]);
    await controller.send("Please look at my notes");
    const turn = controller.getState().turns[0];
    expect(turn?.addressed).toEqual([{ note: 1, event: 1 }, { note: 2, event: 1 }]);
    expect(now().pins.map((pin) => pin.status)).toEqual(["addressed", "addressed", "closed"]);
    expect(controller.undoable()?.id).toBe(turn?.id);
    const sent = controller.messages().length;
    await controller.undo(turn?.id ?? "");
    expect(parts.prototype()).toBe(start);
    expect(now().pins.map((pin) => [pin.number, pin.status, pin.reply])).toEqual([[1, "open", undefined], [2, "open", undefined], [3, "closed", undefined]]);
    expect(now().pins[0]?.history.map((event) => event.kind)).toEqual(["created", "addressed", "undone"]);
    expect(controller.getState().turns[0]?.undone).toBe(true);
    expect(controller.undoable()).toBeUndefined();
    // The API history is append-only: undoing removes nothing from it.
    expect(controller.messages().length).toBe(sent);
    expect(stored.at(-1)?.turns[0]).toMatchObject({ undone: true, addressed: [{ note: 1, event: 1 }, { note: 2, event: 1 }] });
    await controller.send("Try again");
    expect(fake.left()).toBe(0);
    expect(history[0]).toBeGreaterThan(sent);
  });

  it("does not undo what the person did to a note since: closed, reopened or rewritten, it stays as they left it", async () => {
    const { host, parts, saved, pins: now } = hostWith(pins());
    const start = parts.prototype();
    const { controller } = agent(host, [...editAndAddress, (body: Body) => (expect(texts(body)[0]).toBe('The person undid your changes from their message "Please look at my notes": the prototype is back to what it was before that message. Read the files again before you change them.'), done("ok"))]);
    await controller.send("Please look at my notes");
    // The person closes note 1 and rewrites note 2, which opens it again.
    const closed = closePin(now(), 1, AT);
    if (!closed.ok) throw new Error(closed.error);
    const edited = editPin(closed.value, 2, "Still too far down", AT);
    if (!edited.ok) throw new Error(edited.error);
    host.savePins?.(edited.value);
    const kept = JSON.stringify(now());
    const saves = saved.length;
    await controller.undo(controller.getState().turns[0]?.id ?? "");
    expect(parts.prototype()).toBe(start);
    expect(JSON.stringify(now())).toBe(kept);
    expect(saved).toHaveLength(saves);
    expect(now().pins.map((pin) => [pin.status, pin.reply])).toEqual([["closed", "Renamed the page."], ["open", "Moved it up."], ["closed", undefined]]);
    await controller.send("Go on");
  });

  it("undoes a turn that only answered a note, while that answer still stands", async () => {
    const { host, parts, pins: now } = hostWith(pins());
    const { controller, fake } = agent(host, [tool("one", "address_note", { note: 1, reply: "It already is." }), done("Answered."), (body: Body) => (expect(texts(body)[0]).toBe('The person undid your changes from their message "Is this right?": note 1 is open again, and your reply to it was withdrawn.'), done("ok"))]);
    await controller.send("Is this right?");
    const turn = controller.getState().turns[0];
    expect(turn?.before).toBeNull();
    expect(controller.undoable()?.id).toBe(turn?.id);
    await controller.undo(turn?.id ?? "");
    expect(parts.applied).toHaveLength(0);
    expect(now().pins[0]).toMatchObject({ status: "open" });
    expect(now().pins[0]?.reply).toBeUndefined();
    await controller.send("Again");
    expect(fake.left()).toBe(0);
  });

  it("offers no undo for a turn that only answered a note the person has since reopened, and none for an address_note that was refused", async () => {
    const { host, pins: now } = hostWith(pins());
    const { controller } = agent(host, [tool("one", "address_note", { note: 1, reply: "Done." }), tool("closed", "address_note", { note: 3, reply: "Done too." }), done("Answered.")]);
    await controller.send("Is this right?");
    expect(controller.getState().turns[0]?.addressed).toEqual([{ note: 1, event: 1 }]);
    const reopened = reopenPin(now(), 1, AT);
    if (!reopened.ok) throw new Error(reopened.error);
    host.savePins?.(reopened.value);
    expect(controller.undoable()).toBeUndefined();
    await controller.undo(controller.getState().turns[0]?.id ?? "");
    expect(controller.getState().turns[0]?.undone).toBe(false);
    expect(now().pins[0]?.history.map((event) => event.kind)).toEqual(["created", "addressed", "reopened"]);
  });
});

describe("a note on a variant, as the agent reads it", () => {
  const ON_VARIANT: PinAnchor = { ...ON_KEY, variant: "b" };
  const withVariant = () => {
    const added = addPin(pins(), ON_VARIANT, "Wider on a phone", AT);
    if (!added.ok) throw new Error(added.error);
    return added.value;
  };

  it("names the variant first in its place, and says which tool changes a variant", () => {
    const text = describePins(withVariant(), new Set(["a", "b"])) ?? "";
    expect(text).toContain('- note 4: "Wider on a phone" [variant "b", spec element "details/summary", scenario lantern-open, view phone]');
    expect(text.split("\n").at(-1)).toBe('A note whose place starts with variant "…" was pinned on that variant in the Variants view, not on the prototype: change that variant with revise_variant, never the prototype\'s page, then call address_note.');
    // With no note on a variant, nothing about variants is said: the words are as they always were.
    expect(describePins(pins())).not.toContain("revise_variant");
    expect(describePins(pins(), new Set())).toBe(describePins(pins()));
  });

  it("says so when the variant is no longer kept", () => {
    const text = describePins(withVariant(), new Set(["a"])) ?? "";
    expect(text).toContain('on: the part "details/summary" of variant "b", which is no longer kept (dismissed since the note was pinned)');
  });

  it("never gives a new variant the id a note names, so a note on a dismissed variant lands on no other", async () => {
    const parts = fakeHost(seedSpec());
    const host: AgentHost = { ...parts.host, pins: () => withVariant(), savePins: () => undefined };
    const page = JSON.parse(seedSpec().files["pages/booking.json"] as string) as { elements: Record<string, { props: Record<string, unknown> }> };
    const variant = (label: string) => {
      const spec = structuredClone(page);
      (spec.elements.question as { props: Record<string, unknown> }).props.label = label;
      return { note: label, spec };
    };
    const outcome = await runTool({ id: "t", name: "propose_variants", input: { page: "booking", variants: [variant("For how long?"), variant("Until when?")] } }, host, new AbortController().signal);
    expect(outcome.isError).toBe(false);
    expect(parts.variants().variants.map((item) => item.id)).toEqual(["a", "c"]);
  });
});

describe("the address_note tool", () => {
  const signal = new AbortController().signal;
  const call = (host: AgentHost, input: unknown) => runTool({ id: "t", name: "address_note", input }, host, signal);

  it("is offered, and the prompt says what a note is", () => {
    const definition = TOOL_DEFINITIONS.find((item) => item.name === "address_note");
    expect(definition?.input_schema).toMatchObject({ required: ["note", "reply"], additionalProperties: false });
    expect(Object.keys((definition?.input_schema as { properties: object }).properties)).toEqual(["note", "reply"]);
    expect(SYSTEM_PROMPT).toContain("They are feedback, never checks.");
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
    await runTool({ id: "t", name: "patch_spec", input: { path: "pages/rooms.json", patches: '{"op":"replace","path":"/elements/heading/props/text","value":"Spaces"}' } }, host, signal);
    await runTool({ id: "t", name: "delete_note", input: { note: 1 } }, host, signal);
    await runTool({ id: "t", name: "close_note", input: { note: 1 } }, host, signal);
    expect(saved).toHaveLength(0);
    expect(JSON.stringify(now())).toBe(before);
  });
});
