import { describe, expect, it } from "vitest";
import { CHECK_MS, QUIET_CHECKS, settle, type SettleClock, type SettlePage } from "./settle";

/**
 * A clock whose checks take `late(ms)` instead of `ms`: a frame on a starved
 * thread wakes from each wait late. `changes(at)` says whether the page
 * changed during the wait that ended at `at`.
 */
function run(options: { readonly late?: (ms: number) => number; readonly changes?: (at: number) => boolean; readonly fonts?: "loaded" | "never"; readonly maxMs?: number }) {
  let time = 0;
  let pending = false;
  let checks = 0;
  const clock: SettleClock = {
    now: () => time,
    wait: (ms) => {
      if (ms !== CHECK_MS) {
        // The limit's timer beside the fonts and the images: it wins only when they never load.
        if (options.fonts !== "never") return new Promise(() => undefined);
        time += ms;
        return Promise.resolve();
      }
      checks += 1;
      time += (options.late ?? ((value) => value))(ms);
      if (options.changes?.(time)) pending = true;
      return Promise.resolve();
    },
  };
  const page: SettlePage = {
    fonts: options.fonts === "never" ? new Promise(() => undefined) : Promise.resolve(),
    fontsLoaded: () => options.fonts !== "never",
    images: () => [],
    imagesLoaded: () => true,
    watch: () => ({
      changed: () => {
        const was = pending;
        pending = false;
        return was;
      },
      stop: () => undefined,
    }),
  };
  return settle(page, options.maxMs ?? 3000, clock).then((result) => ({ result, time, checks }));
}

describe("a frame waiting for its page to settle", () => {
  it("settles a quiet page after its quiet checks, at the same check as it always has", async () => {
    const { result, time, checks } = await run({});
    expect(result).toEqual({ settled: true });
    expect(checks).toBe(QUIET_CHECKS);
    expect(time).toBe(QUIET_CHECKS * CHECK_MS);
  });

  it("settles a quiet page on a starved thread, whose every check wakes two seconds late", async () => {
    // What failed in CI: no DOM change at all, but two late checks outlast 3000 ms, and the page was said to be still changing.
    const { result, time } = await run({ late: () => 2000 });
    expect(result).toEqual({ settled: true });
    expect(time).toBeGreaterThan(3000);
  });

  it("waits out changes inside the limit, then needs the same quiet checks", async () => {
    const { result, time } = await run({ changes: (at) => at <= 1000 });
    expect(result).toEqual({ settled: true });
    expect(time).toBe(1000 + QUIET_CHECKS * CHECK_MS);
  });

  it("fails a page that keeps changing, at its first change after the limit", async () => {
    const { result, time } = await run({ changes: () => true });
    expect(result).toEqual({ settled: false, reason: "the page was still changing after 3000 ms, so it cannot be measured the same way twice" });
    expect(time).toBe(3000);
  });

  it("fails a page that keeps changing on a starved thread too", async () => {
    const { result } = await run({ late: () => 2000, changes: () => true });
    expect(result).toEqual({ settled: false, reason: "the page was still changing after 3000 ms, so it cannot be measured the same way twice" });
  });

  it("fails a page whose fonts are still loading at the limit, and says so", async () => {
    const { result } = await run({ fonts: "never" });
    expect(result).toEqual({ settled: false, reason: "the page's fonts were still loading after 3000 ms, so it cannot be measured the same way twice" });
  });
});
