import { describe, expect, it, vi } from "vitest";
import type { RenderedSnapshot } from "@design-harness/core";
import { nook } from "../../../../packages/core/examples/nook/project";
import { legalSnapshots } from "../../../../packages/core/examples/nook/snapshots";
import { seedLegal, seedSpec } from "../../test/nook";
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
function harness(source = fakeSource(), options: { readonly tags?: boolean } = {}) {
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
  const session = new Session({ source, kit: "/* kit */", boot: "/* boot */", parentOrigin: "https://app.example", window: win, channel: () => `ch-${(next += 1)}`, timeoutMs: 1000, ...options });
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
    for (const spec of session.getState().frames) send(spec.key, { type: "snapshot", generation: 1, snapshot: snapshotOf(spec.scenario.id, spec.view.name), tags: [] });
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
    const stale = { type: "snapshot", generation: 1, snapshot: snapshotOf("rooms-list", "desktop"), tags: [] };
    send(key, stale, old?.window);
    send(key, stale);
    send(key, { type: "ready" });
    send(key, { ...stale, generation: 2 }, { postMessage: vi.fn() });
    expect(session.getState().frameStates[key]).toEqual({ state: "rendering" });
    send(key, { ...stale, generation: 2 });
    expect(session.getState().frameStates[key]).toMatchObject({ state: "measured" });
    expect(session.getState().revision).toBe(2);
  });

  it("takes a frame's first answer only: a later message on its channel cannot replace its snapshot", async () => {
    const { session, frames, mount, send } = harness();
    session.update(nook, legal);
    mount();
    await flush();
    const key = frameKey("rooms-list", "desktop");
    send(key, { type: "error", generation: 1, stage: "render", message: "early" });
    expect(session.getState().frameStates[key]).toEqual({ state: "waiting" });
    send(key, { type: "ready" });
    send(key, { type: "snapshot", generation: 1, snapshot: snapshotOf("rooms-list", "desktop"), tags: [] });
    send(key, { type: "error", generation: 1, stage: "render", message: "late" });
    expect(session.getState().frameStates[key]).toMatchObject({ state: "measured" });
    expect(frames.size).toBe(8);
  });

  it("keeps where a measured frame is scrolled to, tells its listeners, and changes no state, snapshot or report by it", async () => {
    const { session, mount, send } = harness();
    session.update(nook, legal);
    mount();
    await flush();
    const key = frameKey("rooms-list", "desktop");
    send(key, { type: "ready" });
    // Before its snapshot a frame has nowhere to be scrolled to.
    send(key, { type: "scroll", generation: 1, x: 0, y: 40 });
    expect(session.scrollOf(key)).toEqual({ x: 0, y: 0 });
    send(key, { type: "snapshot", generation: 1, snapshot: snapshotOf("rooms-list", "desktop"), tags: [] });
    const before = session.getState();
    const heard = vi.fn();
    const stateHeard = vi.fn();
    session.subscribeScroll(heard);
    session.subscribe(stateHeard);
    send(key, { type: "scroll", generation: 1, x: 0, y: 240 });
    send(key, { type: "scroll", generation: 1, x: 0, y: 240 });
    send(key, { type: "scroll", generation: 2, x: 0, y: 900 });
    send(key, { type: "scroll", generation: 1, x: 0, y: 300 }, { postMessage: vi.fn() });
    expect(session.scrollOf(key)).toEqual({ x: 0, y: 240 });
    expect(heard).toHaveBeenCalledTimes(1);
    expect(stateHeard).not.toHaveBeenCalled();
    expect(session.getState()).toBe(before);
    // A new revision starts every frame at the top again.
    session.update(nook, { ...legal });
    expect(session.scrollOf(key)).toEqual({ x: 0, y: 0 });
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

describe("a session of a spec prototype", () => {
  it("compiles nothing, sends each frame its page's spec for its scenario, and imports json-render and the spec renderer, never prototype code", async () => {
    let next = 0;
    const win = { addEventListener: () => undefined, removeEventListener: () => undefined } as unknown as Window;
    const asked: string[] = [];
    const source: PackageSource = { name: "fake", origins: [], module: (specifier) => (asked.push(specifier), Promise.resolve({ code: `/* ${specifier} */` })), stylesheet: () => Promise.resolve({ css: "" }) };
    const session = new Session({ source, kit: "/* kit */", spec: "/* spec renderer */", boot: "/* boot */", parentOrigin: "https://app.example", window: win, channel: () => `ch-${(next += 1)}`, timeoutMs: 1000 });
    session.update(nook, seedSpec());
    expect(session.getState().compileProblems).toEqual([]);
    const held = session.getState().frames.find((frame) => frame.key === frameKey("lantern-held", "phone"));
    expect(held?.page && "spec" in held.page ? held.page.spec.spec.state.scenario : null).toEqual({ id: "lantern-held", state: "held" });
    expect(held?.page && "spec" in held.page ? held.page.spec.library : null).toBe("@tounsoo/todae");
    expect(held?.page && "spec" in held.page ? Object.keys(held.page.spec.parts) : []).toContain("Button.Root");
    await flush();
    expect(asked).toContain("@json-render/react");
    const doc = session.documentFor(frameKey("lantern-held", "phone"));
    const contentWindow = { postMessage: vi.fn() };
    session.attach(frameKey("lantern-held", "phone"), { contentWindow } as unknown as HTMLIFrameElement, doc?.generation ?? 0, doc?.channel ?? "");
    (session as unknown as { onMessage: (event: MessageEvent) => void }).onMessage({ data: { protocol: PROTOCOL, type: "ready", channel: doc?.channel }, source: contentWindow } as unknown as MessageEvent);
    const request = contentWindow.postMessage.mock.calls[0]?.[0] as RenderRequest;
    expect(Object.keys(request.modules).sort()).toEqual(["@design-harness/page", "@design-harness/spec", "@json-render/react", "@tounsoo/todae", "react", "react-dom", "react-dom/client", "react/jsx-runtime"]);
    expect(request.modules["@design-harness/spec"]).toEqual({ code: "/* spec renderer */" });
    session.dispose();
  });

  it("draws a draft in place in frames that have rendered, without a new revision, and puts the revision's spec back", async () => {
    const { session, frames, mount, send } = harness();
    const spec = seedSpec();
    session.update(nook, spec);
    const draft = { ...spec, files: { ...spec.files, "pages/rooms.json": (spec.files["pages/rooms.json"] ?? "").replace('"text": "Rooms"', '"text": "Spaces"') } };
    // Before the frames have rendered there is nothing to draw in: the caller starts a revision instead.
    expect(session.redraw(nook, draft)).toBe(false);
    mount();
    await flush();
    for (const key of frames.keys()) send(key, { type: "ready" });
    for (const frame of session.getState().frames) send(frame.key, { type: "snapshot", generation: 1, snapshot: snapshotOf(frame.scenario.id, frame.view.name), tags: [] });
    const report = session.getState().report;
    expect(session.redraw(nook, draft)).toBe(true);
    expect(session.getState().revision).toBe(1);
    expect(session.getState().report).toBe(report);
    const rooms = frames.get(frameKey("rooms-list", "desktop"))?.window.postMessage.mock.calls.at(-1)?.[0] as { type: string; generation: number; spec: { spec: { elements: Record<string, { props: { text?: string } }> } } };
    expect(rooms).toMatchObject({ type: "redraw", generation: 1 });
    expect(rooms.spec.spec.elements.heading?.props.text).toBe("Spaces");
    session.restore();
    const back = frames.get(frameKey("rooms-list", "desktop"))?.window.postMessage.mock.calls.at(-1)?.[0] as typeof rooms;
    expect(back.spec.spec.elements.heading?.props.text).toBe("Rooms");
    // A TSX prototype has no in-place redraw.
    session.update(nook, legal);
    expect(session.redraw(nook, draft)).toBe(false);
  });

  it("tags a TSX revision's elements where core found them, keeps each frame's drawn tags, and outlines by tag", async () => {
    const { session, frames, mount, send } = harness();
    session.update(nook, legal);
    mount();
    await flush();
    for (const key of frames.keys()) send(key, { type: "ready" });
    const key = frameKey("lantern-open", "desktop");
    const request = frames.get(key)?.window.postMessage.mock.calls[0]?.[0] as RenderRequest;
    expect(request.tags).toBe(true);
    const booking = request.modules["@prototype/pages/booking.tsx"];
    expect(booking && "code" in booking ? booking.code : "").toMatch(/'data-dh-source': "pages\/booking\.tsx:\d+:\d+"/);
    send(key, { type: "snapshot", generation: 1, snapshot: snapshotOf("lantern-open", "desktop"), tags: ["pages/booking.tsx:40:9", "pages/booking.tsx:20:9", "pages/booking.tsx:20:9"] });
    expect(session.getState().frameStates[key]).toMatchObject({ state: "measured", tags: ["pages/booking.tsx:20:9", "pages/booking.tsx:40:9"] });
    session.outline(key, ["pages/booking.tsx:40:9"]);
    expect(frames.get(key)?.window.postMessage.mock.calls.at(-1)?.[0]).toEqual({ protocol: PROTOCOL, type: "highlight", channel: frames.get(key)?.channel, generation: 1, tags: ["pages/booking.tsx:40:9"] });
    session.dispose();
  });

  it("with tags off, sends untagged modules and asks frames for no tags", async () => {
    const { session, frames, mount, send } = harness(fakeSource(), { tags: false });
    session.update(nook, legal);
    mount();
    await flush();
    for (const key of frames.keys()) send(key, { type: "ready" });
    const request = frames.get(frameKey("lantern-open", "desktop"))?.window.postMessage.mock.calls[0]?.[0] as RenderRequest;
    expect(request.tags).toBe(false);
    for (const source of Object.values(request.modules)) expect("code" in source ? source.code : "").not.toContain("data-dh-source");
    session.dispose();
  });
});

describe("the library's root part", () => {
  it("goes to each frame with its props and the view's scheme, and is absent for a library without one", async () => {
    const { tally } = await import("../../../../packages/core/examples/tally/project");
    const { rootRef } = await import("./session");
    expect(rootRef(tally.library, "dark")).toEqual({ module: "@mantine/core", component: "MantineProvider", props: { forceColorScheme: "dark" } });
    expect(rootRef({ ...tally.library, root: { component: "MantineProvider", props: { withGlobalClasses: true } } }, "light")).toEqual({ module: "@mantine/core", component: "MantineProvider", props: { withGlobalClasses: true } });
    expect(rootRef(nook.library, "light")).toBeUndefined();
  });
});
