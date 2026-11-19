/**
 * How many frames hold a live document at once, across every session in the
 * app. A live frame is an iframe in the DOM with its page loaded: a whole
 * document, with React, the library and the page in memory. A board of
 * eighty frames (the Variants view of a project with four views) holding
 * eighty of them is what made boards heavy, so a frame is live only while it
 * is being measured, or while it is near the screen and there is room.
 *
 * Two kinds of hold:
 *
 * - `measure`: a frame rendering to be measured. It always gets a hold, so a
 *   revision's report always finishes: measuring frames are bounded by the
 *   render slots (`render-slots.ts`), which are fewer than this limit, and
 *   when the budget is full the frame shown longest is parked to make room.
 * - `show`: a measured frame drawn again because it is near the screen. It
 *   gets a hold when there is room, in the order asked, and otherwise waits;
 *   a parked frame shows what its snapshot measured instead.
 *
 * A hold changes when a frame is live, never what it measures: a snapshot is
 * only ever taken by a `measure` hold's render, and a parked frame keeps it.
 */
export class FrameBudget {
  private readonly measuring = new Set<symbol>();
  /** Frames shown, oldest first, each with what to call when it is parked to make room. */
  private readonly shown = new Map<symbol, () => void>();
  private readonly waiting = new Map<symbol, () => void>();

  constructor(readonly limit: number) {}

  /** How many frames are live now. */
  get live(): number {
    return this.measuring.size + this.shown.size;
  }

  /** Takes a hold for a frame about to render to be measured: at once, parking the frame shown longest when the budget is full. */
  measure(token: symbol): void {
    this.waiting.delete(token);
    this.shown.delete(token);
    this.measuring.add(token);
    while (this.live > this.limit) {
      const oldest = this.shown.keys().next();
      if (oldest.done) break;
      const evicted = this.shown.get(oldest.value);
      this.shown.delete(oldest.value);
      evicted?.();
    }
  }

  /**
   * Asks to show a measured frame: `granted` is called now or when room
   * frees, in the order asked; `parked` if the hold is later taken back to
   * make room for a frame that must be measured.
   */
  show(token: symbol, granted: () => void, parked: () => void): void {
    if (this.measuring.has(token) || this.shown.has(token) || this.waiting.has(token)) return;
    if (this.live < this.limit) {
      this.shown.set(token, parked);
      granted();
      return;
    }
    this.waiting.set(token, () => {
      this.shown.set(token, parked);
      granted();
    });
  }

  /** A frame that has been measured and stays on screen keeps its document: its `measure` hold becomes a `show` hold, at the back of the queue to be parked. */
  keep(token: symbol, parked: () => void): void {
    if (!this.measuring.delete(token)) return;
    this.shown.set(token, parked);
  }

  /** Gives back a frame's hold, or drops its wait. A token it does not know is ignored. */
  release(token: symbol): void {
    this.waiting.delete(token);
    const freed = this.measuring.delete(token) || this.shown.delete(token);
    if (freed) this.fill();
  }

  private fill(): void {
    while (this.live < this.limit) {
      const next = this.waiting.entries().next();
      if (next.done) return;
      const [token, grant] = next.value;
      this.waiting.delete(token);
      grant();
    }
  }
}

/**
 * Two dozen live frames at once: the twelve render slots measuring, and as
 * many again drawn near the screen. A board at its fit zoom shows a few rows
 * at a time, so this is more than one screen of frames.
 */
export const FRAME_BUDGET = new FrameBudget(24);
