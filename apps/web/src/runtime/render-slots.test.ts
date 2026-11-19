import { describe, expect, it } from "vitest";
import { RenderSlots } from "./render-slots";

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
