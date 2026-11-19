import { describe, expect, it } from "vitest";
import { FrameBudget } from "./live-frames";

describe("the live-frame budget", () => {
  it("shows frames while there is room, then queues them in the order asked, and lets the next in as one is released", () => {
    const budget = new FrameBudget(2);
    const shown: string[] = [];
    const [a, b, c, d] = ["a", "b", "c", "d"].map((name) => Symbol(name)) as [symbol, symbol, symbol, symbol];
    for (const [token, name] of [[a, "a"], [b, "b"], [c, "c"], [d, "d"]] as const) budget.show(token, () => shown.push(name), () => undefined);
    expect(shown).toEqual(["a", "b"]);
    expect(budget.live).toBe(2);
    budget.release(a);
    expect(shown).toEqual(["a", "b", "c"]);
    // A frame that stops waiting is dropped from the queue.
    budget.release(d);
    budget.release(b);
    expect(shown).toEqual(["a", "b", "c"]);
    expect(budget.live).toBe(1);
  });

  it("always takes a frame that must be measured, parking the frame shown longest to stay within the limit", () => {
    const budget = new FrameBudget(2);
    const parked: string[] = [];
    const [a, b, m] = ["a", "b", "m"].map((name) => Symbol(name)) as [symbol, symbol, symbol];
    budget.show(a, () => undefined, () => parked.push("a"));
    budget.show(b, () => undefined, () => parked.push("b"));
    budget.measure(m);
    expect(parked).toEqual(["a"]);
    expect(budget.live).toBe(2);
    // Measured and still on screen: its hold becomes a show hold, the newest, so b is parked first next time.
    budget.keep(m, () => parked.push("m"));
    budget.measure(Symbol("n"));
    expect(parked).toEqual(["a", "b"]);
    expect(budget.live).toBe(2);
  });

  it("never holds more than its limit while fewer frames measure at once than it allows, whatever the order of shows, measures and releases", () => {
    const budget = new FrameBudget(3);
    const tokens = Array.from({ length: 24 }, (_, index) => Symbol(String(index)));
    let most = 0;
    tokens.forEach((token, index) => {
      // At most two measure at once, as the render slots allow fewer than the budget.
      if (index % 3 === 0) {
        if (index >= 6) budget.release(tokens[index - 6] as symbol);
        budget.measure(token);
      } else budget.show(token, () => undefined, () => undefined);
      most = Math.max(most, budget.live);
      if (index % 4 === 3) budget.release(tokens[index - 2] as symbol);
      most = Math.max(most, budget.live);
    });
    expect(most).toBe(3);
  });
});
