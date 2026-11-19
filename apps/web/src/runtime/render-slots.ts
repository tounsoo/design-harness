/**
 * How many frames render at once. Every frame of a page shares the app's
 * main thread, and a frame gives its page a fixed time to stop changing
 * before it measures. Asked to render all at once, eighty frames (a review
 * page, or the Variants view of a project with four views) starve each
 * other past that time and fail to measure. So a frame is asked to render
 * only when a slot is free, and gives its slot back when it has answered.
 *
 * This changes when a frame renders, never what it measures: a frame still
 * renders once, in a fresh document, and its snapshot is the same.
 *
 * A request has a priority: a lower number starts first, and requests of
 * the same priority start in the order asked. A frame on screen asks with
 * `PRIORITY.onScreen`, one measured out of sight with `PRIORITY.offScreen`,
 * so what a person is looking at measures first and the rest follows.
 */
/** Where a request stands: on screen first, then frames measured out of sight. */
export const PRIORITY = { onScreen: 0, offScreen: 1 } as const;

export class RenderSlots {
  private readonly held = new Set<symbol>();
  private readonly waiting: { readonly token: symbol; readonly start: () => boolean; priority: number; readonly order: number }[] = [];
  private asked = 0;

  constructor(readonly limit: number) {}

  /**
   * Calls `start` now, or when a slot frees, in the order asked. `start`
   * returns false when the request has gone stale by then (a newer revision,
   * a removed frame): it then holds no slot. `token` names the request for
   * `release`. `priority` orders it among the requests still waiting.
   */
  request(token: symbol, start: () => boolean, priority: number = PRIORITY.onScreen): void {
    this.waiting.push({ token, start, priority, order: (this.asked += 1) });
    this.fill();
  }

  /** Moves a waiting request to another priority, keeping when it was asked; a request already started, or not known, is left alone. */
  reprioritize(token: symbol, priority: number): void {
    const item = this.waiting.find((entry) => entry.token === token);
    if (!item || item.priority === priority) return;
    item.priority = priority;
    this.fill();
  }

  /** How many slots are held, and how many requests wait: for the app's own measurements. */
  get usage(): { readonly held: number; readonly waiting: number } {
    return { held: this.held.size, waiting: this.waiting.length };
  }

  /** Frees the slot `token` holds, or drops its request if it is still waiting. A token it does not know is ignored. */
  release(token: symbol): void {
    const at = this.waiting.findIndex((item) => item.token === token);
    if (at >= 0) this.waiting.splice(at, 1);
    if (this.held.delete(token)) this.fill();
  }

  private fill(): void {
    while (this.held.size < this.limit) {
      let at = -1;
      for (let index = 0; index < this.waiting.length; index += 1) {
        const item = this.waiting[index];
        const best = this.waiting[at];
        if (item && (!best || item.priority < best.priority || (item.priority === best.priority && item.order < best.order))) at = index;
      }
      if (at < 0) return;
      const [next] = this.waiting.splice(at, 1);
      if (!next) return;
      this.held.add(next.token);
      if (!next.start()) this.held.delete(next.token);
    }
  }
}

/** A dozen at a time, across every session in the app: the board, a proposal's examples and the variants share the one thread. */
export const RENDER_SLOTS = new RenderSlots(12);
