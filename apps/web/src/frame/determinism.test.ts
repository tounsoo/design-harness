import { describe, expect, it } from "vitest";
import { FIXED_NOW, installDeterminism, seededRandom } from "./determinism";

describe("a frame's clock and randomness", () => {
  it("read one fixed instant and one seeded sequence, whatever the real time", () => {
    const scope = { Date, Math: Object.create(Math) as Math } as unknown as typeof globalThis;
    installDeterminism(scope);
    expect(scope.Date.now()).toBe(FIXED_NOW);
    expect(new scope.Date().toISOString()).toBe("2026-01-05T09:30:00.000Z");
    expect(new scope.Date(0).toISOString()).toBe("1970-01-01T00:00:00.000Z");
    const first = [scope.Math.random(), scope.Math.random()];
    installDeterminism(scope);
    expect([scope.Math.random(), scope.Math.random()]).toEqual(first);
    expect(first.every((value) => value >= 0 && value < 1)).toBe(true);
    expect(seededRandom(1)()).not.toBe(seededRandom(2)());
  });
});
