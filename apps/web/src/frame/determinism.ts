/**
 * Makes a frame's page independent of when and where it runs, so the same
 * prototype gives the same snapshot on every load: `Date` with no arguments
 * and `Date.now()` read one fixed instant, and `Math.random` is a seeded
 * generator. Installed before any prototype or library module loads. Timers
 * and `performance.now()` keep real time, since React's scheduler needs them.
 */

/** The instant every frame's clock reads: 2026-01-05 09:30 UTC, a Monday morning. */
export const FIXED_NOW = Date.UTC(2026, 0, 5, 9, 30, 0);

/** mulberry32: a small, well-mixed 32-bit generator; the same seed gives the same sequence. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function installDeterminism(scope: typeof globalThis): void {
  const RealDate = scope.Date;
  class FixedDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(FIXED_NOW);
      else super(...(args as [string | number | Date]));
    }
    static override now(): number {
      return FIXED_NOW;
    }
  }
  scope.Date = FixedDate as DateConstructor;
  scope.Math.random = seededRandom(0x5eed);
}
