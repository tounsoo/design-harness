import { describe, expect, it } from "vitest";
import { legalSnapshots } from "../../../../packages/core/examples/nook/snapshots";
import { MAX_ERROR_LENGTH, PROTOCOL, clip, readFrameMessage, readParentMessage, type RenderRequest } from "./protocol";

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
};

describe("the frame's reader of its parent's messages", () => {
  it("accepts a render or highlight request on its own channel", () => {
    expect(readParentMessage(request, channel)).toEqual(request);
    expect(readParentMessage({ protocol: PROTOCOL, type: "highlight", channel, generation: 3, element: 2 }, channel)).not.toBeNull();
    expect(readParentMessage({ protocol: PROTOCOL, type: "highlight", channel, generation: 3, element: null }, channel)).not.toBeNull();
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
    expect(readFrameMessage({ protocol: PROTOCOL, type: "snapshot", channel, generation: 1, snapshot }, channel, expectFrame)).toMatchObject({ type: "snapshot", snapshot });
  });

  it("drops a snapshot core's schema rejects, or one of another scenario or view", () => {
    const base = { protocol: PROTOCOL, type: "snapshot", channel, generation: 1 };
    expect(readFrameMessage({ ...base, snapshot: { ...snapshot, elements: [{ role: "button" }] } }, channel, expectFrame)).toBeNull();
    expect(readFrameMessage({ ...base, snapshot: { ...snapshot, canvas: [300, 0, 0, 1] } }, channel, expectFrame)).toBeNull();
    expect(readFrameMessage({ ...base, snapshot }, channel, { scenario: "rooms-list", view: "desktop" })).toBeNull();
    expect(readFrameMessage({ ...base, snapshot }, "c-2", expectFrame)).toBeNull();
  });

  it("drops an error of an unknown stage or an overlong message", () => {
    const base = { protocol: PROTOCOL, type: "error", channel, generation: 1 };
    expect(readFrameMessage({ ...base, stage: "parent", message: "x" }, channel, expectFrame)).toBeNull();
    expect(readFrameMessage({ ...base, stage: "load", message: "x".repeat(MAX_ERROR_LENGTH + 1) }, channel, expectFrame)).toBeNull();
    expect(clip("x".repeat(MAX_ERROR_LENGTH + 10))).toHaveLength(MAX_ERROR_LENGTH);
  });
});
