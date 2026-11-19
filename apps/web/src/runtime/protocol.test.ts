import { describe, expect, it } from "vitest";
import { legalSnapshots } from "../../../../packages/core/examples/nook/snapshots";
import { MAX_ERROR_LENGTH, MAX_SCROLL, PROTOCOL, clip, readFrameMessage, readParentMessage, type RenderRequest } from "./protocol";
import { MAX_FRAME_TAGS, MAX_OUTLINE_TAGS, MAX_TAG_LENGTH } from "./tags";

const channel = "c-1";
const request: RenderRequest = {
  protocol: PROTOCOL,
  type: "render",
  channel,
  generation: 3,
  modules: { react: { url: "https://esm.sh/react@19.3.1" }, "@prototype/pages/home.tsx": { code: "export default 1" } },
  styles: [{ css: "body{}" }],
  page: { module: "@prototype/pages/home.tsx", export: "Home" },
  scenario: { id: "rooms-list", state: "rooms", page: "home" },
  pageType: { id: "rooms", kind: "collection", slots: ["title", "body"], chrome: ["title"] },
  view: { name: "phone", width: 390, height: 844, scheme: "light" },
  settleMs: 3000,
  tags: true,
};

describe("the frame's reader of its parent's messages", () => {
  it("accepts a render or highlight request on its own channel", () => {
    expect(readParentMessage(request, channel)).toEqual(request);
    expect(readParentMessage({ protocol: PROTOCOL, type: "highlight", channel, generation: 3, element: 2 }, channel)).not.toBeNull();
    expect(readParentMessage({ protocol: PROTOCOL, type: "highlight", channel, generation: 3, element: null }, channel)).not.toBeNull();
  });

  it("accepts an outline of a finding's elements by their tags, and drops one that is empty, too long, mixed with an index, or not strings", () => {
    const outline = { protocol: PROTOCOL, type: "highlight", channel, generation: 3 };
    expect(readParentMessage({ ...outline, tags: ["pages/booking.tsx:34:9", "details/summary"] }, channel)).toEqual({ ...outline, tags: ["pages/booking.tsx:34:9", "details/summary"] });
    expect(readParentMessage({ ...outline, tags: [] }, channel)).toBeNull();
    expect(readParentMessage({ ...outline, tags: Array.from({ length: MAX_OUTLINE_TAGS + 1 }, (_, index) => `t${index}`) }, channel)).toBeNull();
    expect(readParentMessage({ ...outline, tags: ["x".repeat(MAX_TAG_LENGTH + 1)] }, channel)).toBeNull();
    expect(readParentMessage({ ...outline, tags: [""] }, channel)).toBeNull();
    expect(readParentMessage({ ...outline, tags: [1] }, channel)).toBeNull();
    expect(readParentMessage({ ...outline, tags: "book" }, channel)).toBeNull();
    expect(readParentMessage({ ...outline, tags: ["book"], element: 1 }, channel)).toBeNull();
    expect(readParentMessage({ ...outline, tags: ["book"] }, "c-2")).toBeNull();
  });

  it("accepts a spec page, whose spec and parts are data, and drops one of the wrong shape", () => {
    const spec = { library: "@tounsoo/todae", spec: { root: "page", elements: { page: { type: "Page", props: {}, children: [] } }, state: {} }, parts: { Page: { kind: "page", content: "none", props: [], binds: {}, events: [] } } };
    expect(readParentMessage({ ...request, page: { spec } }, channel)).not.toBeNull();
    expect(readParentMessage({ ...request, page: { spec: { ...spec, code: "alert(1)" } } }, channel)).toBeNull();
    expect(readParentMessage({ ...request, page: { spec, module: "@prototype/pages/home.tsx" } }, channel)).toBeNull();
    expect(readParentMessage({ ...request, page: { spec: { ...spec, parts: { Page: { kind: "page", content: "html", props: [], binds: {}, events: [] } } } } }, channel)).toBeNull();
    expect(readParentMessage({ ...request, page: { spec: { ...spec, spec: { ...spec.spec, elements: { page: { props: {} } } } } } }, channel)).toBeNull();
  });

  it("accepts the library's root part by its module, export and literal props, and drops one from elsewhere", () => {
    const withLibrary = { ...request, modules: { ...request.modules, "@mantine/core": { url: "https://esm.sh/@mantine/core@9.7.4" } } };
    const root = { module: "@mantine/core", component: "MantineProvider", props: { forceColorScheme: "dark" } };
    expect(readParentMessage({ ...withLibrary, root }, channel)).not.toBeNull();
    expect(readParentMessage({ ...request, root }, channel)).toBeNull();
    expect(readParentMessage({ ...withLibrary, root: { ...root, component: "default" } }, channel)).toBeNull();
    expect(readParentMessage({ ...withLibrary, root: { ...root, props: { theme: { primaryColor: "violet" } } } }, channel)).toBeNull();
    expect(readParentMessage({ ...withLibrary, root: { ...root, code: "x" } }, channel)).toBeNull();
  });

  it("accepts a redraw of a spec in place, and drops one that carries anything but a spec", () => {
    const spec = { library: "@tounsoo/todae", spec: { root: "page", elements: { page: { type: "Page", props: {}, children: [] } }, state: {} }, parts: { Page: { kind: "page", content: "none", props: [], binds: {}, events: [] } } };
    expect(readParentMessage({ protocol: PROTOCOL, type: "redraw", channel, generation: 3, spec }, channel)).not.toBeNull();
    expect(readParentMessage({ protocol: PROTOCOL, type: "redraw", channel, generation: 3, spec, modules: {} }, channel)).toBeNull();
    expect(readParentMessage({ protocol: PROTOCOL, type: "redraw", channel, generation: 3, spec: { ...spec, code: "x" } }, channel)).toBeNull();
    expect(readParentMessage({ protocol: PROTOCOL, type: "redraw", channel: "c-2", generation: 3, spec }, channel)).toBeNull();
  });

  it("drops another channel, another protocol, an unknown field, a bad shape, and a page that is not one of the modules", () => {
    expect(readParentMessage(request, "c-2")).toBeNull();
    expect(readParentMessage({ ...request, protocol: "other" }, channel)).toBeNull();
    expect(readParentMessage({ ...request, extra: true }, channel)).toBeNull();
    expect(readParentMessage({ ...request, modules: { react: { url: 1 } } }, channel)).toBeNull();
    expect(readParentMessage({ ...request, modules: { react: { url: "x", code: "y" } } }, channel)).toBeNull();
    expect(readParentMessage({ ...request, page: { module: "@prototype/elsewhere.tsx", export: "Home" } }, channel)).toBeNull();
    expect(readParentMessage({ ...request, view: { ...request.view, width: -1 } }, channel)).toBeNull();
    expect(readParentMessage({ ...request, pageType: { ...request.pageType, kind: "action" } }, channel)).toBeNull();
    expect(readParentMessage({ ...request, settleMs: Number.NaN }, channel)).toBeNull();
    expect(readParentMessage({ ...request, tags: "yes" }, channel)).toBeNull();
    const { tags: _tags, ...untagged } = request;
    expect(readParentMessage(untagged, channel)).toBeNull();
    expect(readParentMessage({ protocol: PROTOCOL, type: "highlight", channel, generation: 3, element: -1 }, channel)).toBeNull();
    expect(readParentMessage(null, channel)).toBeNull();
    expect(readParentMessage("render", channel)).toBeNull();
  });
});

describe("the app's reader of a frame's messages", () => {
  const snapshot = legalSnapshots().find((item) => item.scenario === "rooms-list" && item.view === "phone");
  const expectFrame = { scenario: "rooms-list", view: "phone" };

  it("accepts ready, errors and a valid snapshot of the frame's own scenario and view", () => {
    expect(readFrameMessage({ protocol: PROTOCOL, type: "ready", channel }, channel, expectFrame)).not.toBeNull();
    expect(readFrameMessage({ protocol: PROTOCOL, type: "error", channel, generation: 1, stage: "render", message: "boom" }, channel, expectFrame)).not.toBeNull();
    expect(readFrameMessage({ protocol: PROTOCOL, type: "snapshot", channel, generation: 1, snapshot, tags: [] }, channel, expectFrame)).toMatchObject({ type: "snapshot", snapshot, tags: [] });
  });

  it("drops a snapshot core's schema rejects, or one of another scenario or view", () => {
    const base = { protocol: PROTOCOL, type: "snapshot", channel, generation: 1, tags: [] };
    expect(readFrameMessage({ ...base, snapshot: { ...snapshot, elements: [{ role: "button" }] } }, channel, expectFrame)).toBeNull();
    expect(readFrameMessage({ ...base, snapshot: { ...snapshot, canvas: [300, 0, 0, 1] } }, channel, expectFrame)).toBeNull();
    expect(readFrameMessage({ ...base, snapshot }, channel, { scenario: "rooms-list", view: "desktop" })).toBeNull();
    expect(readFrameMessage({ ...base, snapshot }, "c-2", expectFrame)).toBeNull();
  });

  it("takes a snapshot's drawn tags sorted and once each, and drops tags that are missing, not strings, too many or too long", () => {
    const base = { protocol: PROTOCOL, type: "snapshot", channel, generation: 1, snapshot };
    expect(readFrameMessage({ ...base, tags: ["b", "a", "b"] }, channel, expectFrame)).toMatchObject({ tags: ["a", "b"] });
    expect(readFrameMessage(base, channel, expectFrame)).toBeNull();
    expect(readFrameMessage({ ...base, tags: [3] }, channel, expectFrame)).toBeNull();
    expect(readFrameMessage({ ...base, tags: "a" }, channel, expectFrame)).toBeNull();
    expect(readFrameMessage({ ...base, tags: Array.from({ length: MAX_FRAME_TAGS + 1 }, (_, index) => `t${index}`) }, channel, expectFrame)).toBeNull();
    expect(readFrameMessage({ ...base, tags: ["x".repeat(MAX_TAG_LENGTH + 1)] }, channel, expectFrame)).toBeNull();
  });

  it("drops an error of an unknown stage or an overlong message", () => {
    const base = { protocol: PROTOCOL, type: "error", channel, generation: 1 };
    expect(readFrameMessage({ ...base, stage: "parent", message: "x" }, channel, expectFrame)).toBeNull();
    expect(readFrameMessage({ ...base, stage: "load", message: "x".repeat(MAX_ERROR_LENGTH + 1) }, channel, expectFrame)).toBeNull();
    expect(clip("x".repeat(MAX_ERROR_LENGTH + 10))).toHaveLength(MAX_ERROR_LENGTH);
  });

  it("takes where a frame is scrolled to as whole CSS px, and drops an offset that is not a number, negative, too far or with an extra field", () => {
    const base = { protocol: PROTOCOL, type: "scroll", channel, generation: 1 };
    expect(readFrameMessage({ ...base, x: 0, y: 120.4 }, channel, expectFrame)).toEqual({ protocol: PROTOCOL, type: "scroll", channel, generation: 1, x: 0, y: 120 });
    expect(readFrameMessage({ ...base, x: 0 }, channel, expectFrame)).toBeNull();
    expect(readFrameMessage({ ...base, x: 0, y: "12" }, channel, expectFrame)).toBeNull();
    expect(readFrameMessage({ ...base, x: -1, y: 0 }, channel, expectFrame)).toBeNull();
    expect(readFrameMessage({ ...base, x: 0, y: Number.NaN }, channel, expectFrame)).toBeNull();
    expect(readFrameMessage({ ...base, x: 0, y: MAX_SCROLL + 1 }, channel, expectFrame)).toBeNull();
    expect(readFrameMessage({ ...base, x: 0, y: 0, snapshot }, channel, expectFrame)).toBeNull();
    expect(readFrameMessage({ ...base, x: 0, y: 0, generation: -1 }, channel, expectFrame)).toBeNull();
  });

  it("takes where each tag drew, beside the snapshot and never in it, and drops a message whose places are malformed", () => {
    const base = { protocol: PROTOCOL, type: "snapshot", channel, generation: 1, snapshot, tags: ["a"] };
    const place = { tag: "a", rect: { x: 1, y: 2.5, width: 30, height: 40 } };
    const read = readFrameMessage({ ...base, places: [place] }, channel, expectFrame);
    expect(read).toMatchObject({ type: "snapshot", places: [place] });
    // The snapshot is the same with places and without: nothing a rule reads changes.
    const without = readFrameMessage(base, channel, expectFrame);
    expect(without).toMatchObject({ places: [] });
    expect(JSON.stringify((read as { snapshot: unknown }).snapshot)).toBe(JSON.stringify((without as { snapshot: unknown }).snapshot));
    for (const places of ["a", [null], [{ tag: "a" }], [{ ...place, extra: 1 }], [{ tag: "", rect: place.rect }], [{ tag: "a".repeat(1025), rect: place.rect }], [{ tag: "a", rect: { ...place.rect, width: -1 } }], [{ tag: "a", rect: { ...place.rect, x: Number.NaN } }], [{ tag: "a", rect: { ...place.rect, y: 1e9 } }], [{ tag: "a", rect: { ...place.rect, depth: 1 } }], Array.from({ length: 20001 }, () => place)]) {
      expect(readFrameMessage({ ...base, places }, channel, expectFrame)).toBeNull();
    }
  });

  it("carries a snapshot's page height through, and drops a negative one", () => {
    const base = { protocol: PROTOCOL, type: "snapshot", channel, generation: 1, tags: [] };
    expect(readFrameMessage({ ...base, snapshot: { ...snapshot, scrollHeight: 1200 } }, channel, expectFrame)).toMatchObject({ snapshot: { scrollHeight: 1200 } });
    expect(readFrameMessage({ ...base, snapshot: { ...snapshot, scrollHeight: -1 } }, channel, expectFrame)).toBeNull();
  });
});
