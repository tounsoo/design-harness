/**
 * Waits until a frame's page stops changing, so it is measured the same way
 * on every load: web fonts loaded, images decoded, and no DOM mutation for
 * `QUIET_CHECKS` checks in a row, `CHECK_MS` apart. Timers, not animation
 * frames, since a browser may throttle frames in an iframe that is off
 * screen.
 *
 * `maxMs` bounds a page that keeps changing, never a page that has stopped.
 * The verdict is read from the page, not from the clock: a frame starved of
 * its thread (many frames rendering at once in one process, a loaded
 * machine) wakes from each check late, and a page that changed nothing in
 * those checks is quiet however long they took. So the time limit fails a
 * page only when it saw a change after `maxMs`, or fonts or images still
 * loading at `maxMs`. A page that settles within `maxMs` settles at the same
 * check as it always did, so what is measured is the same.
 */

/** Checks in a row with no change that make a page quiet. */
export const QUIET_CHECKS = 3;
/** How far apart the checks are, in ms. */
export const CHECK_MS = 50;

/** What `settle` reads of the page. The boot script gives it the frame's document. */
export type SettlePage = {
  /** Resolves when the fonts the page uses have loaded. */
  readonly fonts: Promise<unknown>;
  /** Whether the page's fonts are loaded now. */
  readonly fontsLoaded: () => boolean;
  /** One promise for each image still loading, each settling when it has decoded or failed. */
  readonly images: () => readonly Promise<unknown>[];
  /** Whether every image has loaded now. */
  readonly imagesLoaded: () => boolean;
  /** Starts watching for changes: `changed` says whether any happened since it was last asked, `stop` stops watching. */
  readonly watch: () => { readonly changed: () => boolean; readonly stop: () => void };
};

/** The real time the boot script waits by, taken before the page's clock is fixed. */
export type SettleClock = {
  readonly now: () => number;
  readonly wait: (ms: number) => Promise<void>;
};

export type Settled = { readonly settled: true } | { readonly settled: false; readonly reason: string };

export async function settle(page: SettlePage, maxMs: number, clock: SettleClock): Promise<Settled> {
  const deadline = clock.now() + maxMs;
  const left = () => Math.max(0, deadline - clock.now());
  let fontsDone = false;
  await Promise.race([page.fonts.then(() => (fontsDone = true)), clock.wait(left())]);
  if (!fontsDone && !page.fontsLoaded()) return { settled: false, reason: `the page's fonts were still loading after ${maxMs} ms, so it cannot be measured the same way twice` };
  let imagesDone = false;
  await Promise.race([Promise.all(page.images()).then(() => (imagesDone = true)), clock.wait(left())]);
  if (!imagesDone && !page.imagesLoaded()) return { settled: false, reason: `the page's images were still loading after ${maxMs} ms, so it cannot be measured the same way twice` };
  const watch = page.watch();
  try {
    let quiet = 0;
    while (quiet < QUIET_CHECKS) {
      watch.changed();
      await clock.wait(CHECK_MS);
      if (!watch.changed()) {
        quiet += 1;
        continue;
      }
      quiet = 0;
      if (clock.now() >= deadline) return { settled: false, reason: `the page was still changing after ${maxMs} ms, so it cannot be measured the same way twice` };
    }
    return { settled: true };
  } finally {
    watch.stop();
  }
}
