import { describe, expect, it } from "vitest";
import { PRIORITY, RenderSlots } from "./render-slots";

describe("render slots", () => {
  it("starts requests in the order asked, at most the limit at a time, and the next when one is released", () => {
    const slots = new RenderSlots(2);
    const started: string[] = [];
    const tokens = ["a", "b", "c", "d"].map((name) => ({ name, token: Symbol(name) }));
    for (const { name, token } of tokens) slots.request(token, () => started.push(name) > 0);
    expect(started).toEqual(["a", "b"]);
    slots.release(tokens[0]?.token as symbol);
    expect(started).toEqual(["a", "b", "c"]);
    slots.release(tokens[1]?.token as symbol);
    expect(started).toEqual(["a", "b", "c", "d"]);
  });

  it("gives a stale request no slot: the one after it starts at once", () => {
    const slots = new RenderSlots(1);
    const started: string[] = [];
    const first = Symbol("first");
    slots.request(first, () => started.push("first") > 0);
    slots.request(Symbol("stale"), () => false);
    slots.request(Symbol("next"), () => started.push("next") > 0);
    slots.release(first);
    expect(started).toEqual(["first", "next"]);
  });

  it("drops a request released while it waits, and ignores a token it does not know or has already freed", () => {
    const slots = new RenderSlots(1);
    const started: string[] = [];
    const first = Symbol("first");
    const waiting = Symbol("waiting");
    slots.request(first, () => started.push("first") > 0);
    slots.request(waiting, () => started.push("waiting") > 0);
    slots.release(waiting);
    slots.release(Symbol("unknown"));
    slots.release(first);
    slots.release(first);
    slots.request(Symbol("later"), () => started.push("later") > 0);
    expect(started).toEqual(["first", "later"]);
  });
});

describe("render slots by priority", () => {
  it("starts a lower priority number first, the same priority in the order asked, and a request moved keeps its place in time", () => {
    const slots = new RenderSlots(1);
    const started: string[] = [];
    const first = Symbol("first");
    slots.request(first, () => started.push("first") > 0, PRIORITY.offScreen);
    const tokens = Object.fromEntries(["off-a", "on-b", "off-c", "on-d"].map((name) => [name, Symbol(name)]));
    for (const [name, token] of Object.entries(tokens)) slots.request(token, () => started.push(name) > 0, name.startsWith("on") ? PRIORITY.onScreen : PRIORITY.offScreen);
    expect(slots.usage).toEqual({ held: 1, waiting: 4 });
    // "off-c" comes on screen while it waits: it goes ahead of "off-a", behind the two asked on screen before it was moved.
    slots.reprioritize(tokens["off-c"] as symbol, PRIORITY.onScreen);
    for (const token of [first, tokens["on-b"], tokens["off-c"], tokens["on-d"], tokens["off-a"]]) slots.release(token as symbol);
    expect(started).toEqual(["first", "on-b", "off-c", "on-d", "off-a"]);
    expect(slots.usage).toEqual({ held: 0, waiting: 0 });
  });
});
