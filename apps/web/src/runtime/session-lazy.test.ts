import { describe, expect, it, vi } from "vitest";
import type { RenderedSnapshot } from "@design-harness/core";
import { nook } from "../../../../packages/core/examples/nook/project";
import { legalSnapshots } from "../../../../packages/core/examples/nook/snapshots";
import { seedLegal } from "../../test/nook";
import { FrameBudget } from "./live-frames";
import type { PackageSource } from "./package-source";
import { PROTOCOL } from "./protocol";
import { RenderSlots } from "./render-slots";
import { Session, frameKey, type FramePresence } from "./session";

/**
 * A session driven as the board drives it: each frame is drawn somewhere
 * (`present`), near the screen or not, and an iframe is in the DOM only
 * while the session keeps the frame live, as `FrameViewport` does. `sync`
 * stands for React rendering after a change.
 */
function board(options: { readonly slots?: number; readonly budget?: number } = {}) {
  let listener: ((event: MessageEvent) => void) | null = null;
  const win = { addEventListener: (_type: string, fn: (event: MessageEvent) => void) => (listener = fn), removeEventListener: () => (listener = null) } as unknown as Window;
  const source: PackageSource = { name: "fake", origins: [], module: (specifier) => Promise.resolve({ code: `/* ${specifier} */` }), stylesheet: () => Promise.resolve({ css: "" }) };
  let next = 0;
  const budget = new FrameBudget(options.budget ?? 24);
  const session = new Session({ source, kit: "/* kit */", boot: "/* boot */", parentOrigin: "https://app.example", window: win, channel: () => `ch-${(next += 1)}`, timeoutMs: 1000, slots: new RenderSlots(options.slots ?? 12), budget });
  const presences = new Map<string, FramePresence>();
  const mounted = new Map<string, { epoch: number; generation: number; channel: string; window: { postMessage: ReturnType<typeof vi.fn> } }>();
  /** Every document a frame was given, in order. */
  const documents: string[] = [];
  const sync = () => {
    for (const spec of session.getState().frames) {
      const epoch = session.liveOf(spec.key);
      const now = mounted.get(spec.key);
      if (now && (epoch !== now.epoch || now.generation !== session.getState().revision)) {
        mounted.delete(spec.key);
        session.attach(spec.key, null, now.generation, now.channel);
      }
      if (epoch !== null && !mounted.has(spec.key)) {
        const doc = session.documentFor(spec.key);
        if (!doc) continue;
        const contentWindow = { postMessage: vi.fn() };
        mounted.set(spec.key, { epoch, generation: doc.generation, channel: doc.channel, window: contentWindow });
        documents.push(spec.key);
        session.attach(spec.key, { contentWindow } as unknown as HTMLIFrameElement, doc.generation, doc.channel);
      }
    }
  };
  const draw = (visible: (key: string) => boolean) => {
    for (const spec of session.getState().frames) {
      let presence = presences.get(spec.key);
      if (!presence) {
        presence = session.present(spec.key);
        presences.set(spec.key, presence);
      }
      presence.visible(visible(spec.key));
    }
    sync();
  };
  const send = (key: string, data: object) => {
    const frame = mounted.get(key);
    if (!frame) throw new Error(`${key} is not live`);
    listener?.({ data: { protocol: PROTOCOL, channel: frame.channel, ...data }, source: frame.window } as MessageEvent);
    sync();
  };
  /** Each live frame says it listens; each asked to render answers with its snapshot (or `snapshotFor`'s). */
  const answerAll = (snapshotFor: (scenario: string, view: string) => RenderedSnapshot | undefined = snapshotOf) => {
    for (let round = 0; round < 100; round += 1) {
      const asked = [...mounted].filter(([, frame]) => frame.window.postMessage.mock.calls.length === 0);
      const rendering = [...mounted].filter(([, frame]) => frame.window.postMessage.mock.calls.some(([message]) => (message as { type?: string }).type === "render") && !frame.window.postMessage.mock.calls.some(([message]) => (message as { answered?: boolean }).answered));
      if (asked.length === 0 && rendering.length === 0) return;
      for (const [key] of asked) send(key, { type: "ready" });
      for (const [key, frame] of rendering) {
        const spec = session.getState().frames.find((item) => item.key === key);
        frame.window.postMessage({ answered: true });
        if (spec) send(key, { type: "snapshot", generation: frame.generation, snapshot: snapshotFor(spec.scenario.id, spec.view.name), tags: [] });
      }
    }
  };
  return { session, budget, draw, sync, send, mounted, documents, answerAll };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const snapshotOf = (scenario: string, view: string): RenderedSnapshot | undefined => legalSnapshots().find((item) => item.scenario === scenario && item.view === view);
const legal = seedLegal();
const ON_SCREEN = new Set([frameKey("lantern-held", "desktop"), frameKey("lantern-held", "phone")]);

describe("a session measured lazily", () => {
  it("measures the frames near the screen first, then every other frame drawn anywhere, and is measured only once all have answered", async () => {
    const { session, draw, mounted, documents, answerAll, sync } = board({ slots: 2 });
    session.update(nook, legal);
    draw((key) => ON_SCREEN.has(key));
    await flush();
    sync();
    // Two slots: the two frames on screen go live first, though they are the last scenario on the board.
    expect([...mounted.keys()].sort()).toEqual([...ON_SCREEN].sort());
    expect(session.getState().frameStates[frameKey("rooms-list", "desktop")]).toEqual({ state: "waiting" });
    answerAll();
    await flush();
    const state = session.getState();
    expect(state.frames.every((frame) => state.frameStates[frame.key]?.state === "measured")).toBe(true);
    expect(state.measured).toBe(true);
    expect(state.report?.status).toBe("pass");
    // Each frame was rendered once, for its measurement; the two on screen first.
    expect(documents.slice(0, 2).sort()).toEqual([...ON_SCREEN].sort());
    expect([...documents].sort()).toEqual(state.frames.map((frame) => frame.key).sort());
    // What is measured off screen is parked: only the frames on screen stay live.
    expect([...mounted.keys()].sort()).toEqual([...ON_SCREEN].sort());
    expect(session.liveCount()).toBe(2);
  });

  it("gives the same report as a session whose every frame is live, snapshot for snapshot", async () => {
    const lazy = board({ slots: 3 });
    lazy.session.update(nook, legal);
    lazy.draw((key) => key.endsWith("@phone"));
    await flush();
    lazy.sync();
    lazy.answerAll();
    const eager = board({ slots: 16 });
    eager.session.update(nook, legal);
    eager.draw(() => true);
    await flush();
    eager.sync();
    eager.answerAll();
    await flush();
    expect(lazy.session.getState().measured && eager.session.getState().measured).toBe(true);
    expect(JSON.stringify(lazy.session.getState().report)).toBe(JSON.stringify(eager.session.getState().report));
    expect(lazy.session.getState().frameStates).toEqual(eager.session.getState().frameStates);
  });

  it("draws a parked frame again when it comes near the screen, in a fresh document, without measuring it into the report, and outlines what it was asked to", async () => {
    const { session, draw, mounted, send, answerAll, sync } = board();
    session.update(nook, legal);
    draw(() => false);
    await flush();
    sync();
    answerAll();
    await flush();
    expect(session.getState().measured).toBe(true);
    expect(mounted.size).toBe(0);
    const report = session.getState().report;
    const states = session.getState().frameStates;
    const key = frameKey("lantern-open", "desktop");
    session.outline(key, ["pages/booking.tsx:40:9"]);
    draw((item) => item === key);
    const frame = mounted.get(key);
    expect(frame).toBeDefined();
    send(key, { type: "ready" });
    expect(frame?.window.postMessage.mock.calls[0]?.[0]).toMatchObject({ type: "render", channel: frame?.channel });
    // The picture answers with what it measures; the report and the frame's state keep the first measurement.
    send(key, { type: "snapshot", generation: 1, snapshot: snapshotOf("lantern-open", "desktop"), tags: [] });
    expect(session.getState().report).toBe(report);
    expect(session.getState().frameStates).toBe(states);
    expect(session.reshownCount()).toEqual({ count: 1, same: 1 });
    // Drawn again, it outlines the finding that was selected while it was parked.
    expect(frame?.window.postMessage.mock.calls.at(-1)?.[0]).toEqual({ protocol: PROTOCOL, type: "highlight", channel: frame?.channel, generation: 1, tags: ["pages/booking.tsx:40:9"] });
    // Away from the screen again, it is parked.
    draw(() => false);
    expect(mounted.size).toBe(0);
    expect(session.liveOf(key)).toBeNull();
  });

  it("holds no more live frames than its budget, parking the oldest shown frame for one that must be measured, and still measures every frame", async () => {
    const { session, budget, draw, mounted, answerAll, sync } = board({ slots: 2, budget: 4 });
    session.update(nook, legal);
    // Every frame is on screen: more than the budget allows live at once.
    draw(() => true);
    await flush();
    sync();
    let most = 0;
    for (let round = 0; round < 40 && !session.getState().measured; round += 1) {
      answerAll();
      most = Math.max(most, mounted.size, budget.live);
      await flush();
      sync();
    }
    expect(session.getState().measured).toBe(true);
    expect(most).toBeLessThanOrEqual(4);
    expect(session.getState().frames.every((frame) => session.getState().frameStates[frame.key]?.state === "measured")).toBe(true);
    expect(session.liveCount()).toBeLessThanOrEqual(4);
  });

  it("puts a frame whose viewport leaves mid-measurement back to waiting, so it is measured when it is drawn again", async () => {
    const { session, draw, mounted, send, sync } = board({ slots: 1 });
    const only = { ...legal, scenarios: legal.scenarios.slice(0, 1) };
    session.update({ ...nook, views: nook.views.slice(0, 1) }, only);
    draw(() => true);
    await flush();
    sync();
    const [key] = [...mounted.keys()];
    send(key as string, { type: "ready" });
    expect(session.getState().frameStates[key as string]).toEqual({ state: "rendering" });
    // The board leaves before the frame answers.
    const frame = mounted.get(key as string);
    session.attach(key as string, null, frame?.generation ?? 0, frame?.channel ?? "");
    expect(session.getState().frameStates[key as string]).toEqual({ state: "waiting" });
    expect(session.getState().measured).toBe(false);
  });

  it("fails a frame given its turn whose document never says it listens, so the revision still finishes", async () => {
    vi.useFakeTimers();
    try {
      const { session, draw, sync } = board({ slots: 16 });
      session.update(nook, legal);
      draw(() => true);
      await vi.advanceTimersByTimeAsync(0);
      sync();
      await vi.advanceTimersByTimeAsync(1001);
      expect(session.getState().frameStates[frameKey("rooms-list", "phone")]).toEqual({ state: "failed", stage: "timeout", message: "The frame did not load within 1 s." });
      expect(session.getState().measured).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
