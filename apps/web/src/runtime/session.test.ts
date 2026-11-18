import { describe, expect, it, vi } from "vitest";
import type { RenderedSnapshot } from "@design-harness/core";
import { nook } from "../../../../packages/core/examples/nook/project";
import { legalSnapshots } from "../../../../packages/core/examples/nook/snapshots";
import { seedLegal } from "../../test/nook";
import type { PackageSource } from "./package-source";
import { PROTOCOL, type RenderRequest } from "./protocol";
import { Session, frameKey } from "./session";

const legal = seedLegal();

function fakeSource(fail = false): PackageSource {
  return {
    name: "fake",
    origins: [],
    module: (specifier) => (fail ? Promise.reject(new Error("offline")) : Promise.resolve({ code: `/* ${specifier} */` })),
    stylesheet: () => Promise.resolve({ css: "" }),
  };
}

/** A window that records listeners, and iframes whose posted messages are recorded. */
function harness(source = fakeSource()) {
  let listener: ((event: MessageEvent) => void) | null = null;
  const win = {
    addEventListener: (_type: string, fn: (event: MessageEvent) => void) => {
      listener = fn;
    },
    removeEventListener: () => {
      listener = null;
    },
  } as unknown as Window;
  let next = 0;
  const session = new Session({ source, kit: "/* kit */", boot: "/* boot */", parentOrigin: "https://app.example", window: win, channel: () => `ch-${(next += 1)}`, timeoutMs: 1000 });
  const frames = new Map<string, { channel: string; generation: number; window: { postMessage: ReturnType<typeof vi.fn> } }>();
  const mount = () => {
    for (const spec of session.getState().frames) {
      const doc = session.documentFor(spec.key);
      if (!doc) continue;
      const contentWindow = { postMessage: vi.fn() };
      session.attach(spec.key, { contentWindow } as unknown as HTMLIFrameElement, doc.generation, doc.channel);
      frames.set(spec.key, { channel: doc.channel, generation: doc.generation, window: contentWindow });
    }
  };
  const send = (key: string, data: object, from?: unknown) => {
    const frame = frames.get(key);
    listener?.({ data: { protocol: PROTOCOL, channel: frame?.channel, ...data }, source: from ?? frame?.window } as MessageEvent);
  };
  return { session, frames, mount, send };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const snapshotOf = (scenario: string, view: string): RenderedSnapshot | undefined => legalSnapshots().find((item) => item.scenario === scenario && item.view === view);

describe("a session", () => {
  it("checks the source at once, renders every frame for the revision, and checks again with every snapshot", async () => {
    const { session, frames, mount, send } = harness();
    session.update(nook, legal);
    expect(session.getState().report?.status).toBe("incomplete");
    expect(session.getState().measured).toBe(false);
    mount();
    await flush();
    for (const [key, frame] of frames) {
      send(key, { type: "ready" });
      const request = frame.window.postMessage.mock.calls[0]?.[0] as RenderRequest;
      expect(request).toMatchObject({ type: "render", generation: 1, page: { export: expect.any(String) } });
      expect(Object.keys(request.modules)).toEqual(expect.arrayContaining(["react", "@tounsoo/todae", "@design-harness/page", "@prototype/pages/booking.tsx"]));
    }
    for (const spec of session.getState().frames) send(spec.key, { type: "snapshot", generation: 1, snapshot: snapshotOf(spec.scenario.id, spec.view.name) });
    const state = session.getState();
    expect(state.measured).toBe(true);
    expect(state.report?.status).toBe("pass");
    expect(state.report?.rules.every((rule) => rule.status === "pass")).toBe(true);
  });

  it("never counts a snapshot from an earlier revision, another channel or another window", async () => {
    const { session, frames, mount, send } = harness();
    session.update(nook, legal);
    mount();
    await flush();
    const key = frameKey("rooms-list", "desktop");
    send(key, { type: "ready" });
    const old = frames.get(key);
    // An edit lands before the frame answers: revision 2, with fresh documents on fresh channels.
    session.update(nook, { ...legal });
    mount();
    await flush();
    const stale = { type: "snapshot", generation: 1, snapshot: snapshotOf("rooms-list", "desktop") };
    send(key, stale, old?.window);
    send(key, stale);
    send(key, { type: "ready" });
    send(key, { ...stale, generation: 2 }, { postMessage: vi.fn() });
    expect(session.getState().frameStates[key]).toEqual({ state: "rendering" });
    send(key, { ...stale, generation: 2 });
    expect(session.getState().frameStates[key]).toMatchObject({ state: "measured" });
    expect(session.getState().revision).toBe(2);
  });

  it("fails every frame when packages cannot load, and core then reports each scenario and view unmeasured", async () => {
    const { session } = harness(fakeSource(true));
    session.update(nook, legal);
    await flush();
    const state = session.getState();
    expect(state.packages).toMatchObject({ state: "failed", message: "Packages could not load from the fake source: offline" });
    expect(state.measured).toBe(true);
    expect(state.report?.status).toBe("fail");
    expect(state.report?.findings.filter((finding) => finding.rule === "target-size").map((finding) => finding.message)).toContain('No snapshot of scenario "rooms-list" at view "desktop", so it was not measured.');
  });

  it("does not render a scenario whose page is missing, and says why", () => {
    const { session } = harness();
    session.update(nook, { ...legal, scenarios: [{ id: "lost", state: "rooms", page: "nowhere" }] });
    expect(session.getState().frameStates[frameKey("lost", "desktop")]).toEqual({ state: "failed", stage: "setup", message: 'Scenario "lost" names page "nowhere", which is not in the prototype\'s manifest.' });
  });

  it("marks a frame that never answers, so the revision still finishes", async () => {
    vi.useFakeTimers();
    try {
      const { session, frames, mount, send } = harness();
      session.update(nook, legal);
      mount();
      await vi.advanceTimersByTimeAsync(0);
      for (const key of frames.keys()) send(key, { type: "ready" });
      await vi.advanceTimersByTimeAsync(1001);
      expect(session.getState().frameStates[frameKey("rooms-list", "phone")]).toMatchObject({ state: "failed", stage: "timeout" });
      expect(session.getState().measured).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for a frame to say it listens before asking it to render, however fast packages resolve", async () => {
    const { session, frames, mount, send } = harness();
    session.update(nook, legal);
    mount();
    await flush();
    const key = frameKey("rooms-list", "desktop");
    expect(frames.get(key)?.window.postMessage).not.toHaveBeenCalled();
    expect(session.getState().frameStates[key]).toEqual({ state: "waiting" });
    send(key, { type: "ready" });
    expect(frames.get(key)?.window.postMessage).toHaveBeenCalledTimes(1);
  });
});
