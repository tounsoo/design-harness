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
 */
export class RenderSlots {
  private readonly held = new Set<symbol>();
  private readonly waiting: { readonly token: symbol; readonly start: () => boolean }[] = [];

  constructor(readonly limit: number) {}

  /**
   * Calls `start` now, or when a slot frees, in the order asked. `start`
   * returns false when the request has gone stale by then (a newer revision,
   * a removed frame): it then holds no slot. `token` names the request for
   * `release`.
   */
  request(token: symbol, start: () => boolean): void {
    this.waiting.push({ token, start });
    this.fill();
  }

  /** Frees the slot `token` holds, or drops its request if it is still waiting. A token it does not know is ignored. */
  release(token: symbol): void {
    const at = this.waiting.findIndex((item) => item.token === token);
    if (at >= 0) this.waiting.splice(at, 1);
    if (this.held.delete(token)) this.fill();
  }

  private fill(): void {
    while (this.held.size < this.limit) {
      const next = this.waiting.shift();
      if (!next) return;
      this.held.add(next.token);
      if (!next.start()) this.held.delete(next.token);
    }
  }
}

/** A dozen at a time, across every session in the app: the board, a proposal's examples and the variants share the one thread. */
export const RENDER_SLOTS = new RenderSlots(12);
