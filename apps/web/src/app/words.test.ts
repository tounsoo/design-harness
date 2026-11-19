import { describe, expect, it } from "vitest";
import { nook } from "../../../../packages/core/examples/nook/project";
import { seedLegal } from "../../test/nook";
import { frameSpecs } from "../runtime/session";
import { describeOutline, exampleLabel, frameName, frameNameOf, pendingWords, scenarioName, scenarioNameOf } from "./words";

/** Scenarios are named for a designer by their page and state, with their own name; an id is never the label. */
describe("a scenario's name outside the board", () => {
  const held = { id: "lantern-held", page: "booking", state: "held" };
  const rooms = { id: "rooms", page: "rooms", state: "rooms" };

  it("is its screen and its own name, once when both say the same", () => {
    expect(scenarioName(held)).toBe("Booking, held (Lantern held)");
    expect(scenarioName({ id: "rooms-list", page: "rooms", state: "rooms" })).toBe("Rooms (Rooms list)");
    expect(scenarioName(rooms)).toBe("Rooms");
  });

  it("names a frame as its artboard's Open button does", () => {
    expect(frameName(held, "phone")).toBe("Booking, held — phone (Lantern held)");
  });

  it("names a scenario or a frame known by id from the ones in hand, and falls back to the id in words or the key", () => {
    const frames = frameSpecs(nook, seedLegal());
    expect(scenarioNameOf("lantern-held", [held])).toBe("Booking, held (Lantern held)");
    expect(scenarioNameOf("harbor-open", [held])).toBe("Harbor open");
    expect(frameNameOf("lantern-open@phone", frames)).toBe("Booking, room open — phone (Lantern open)");
    expect(frameNameOf("gone@phone", frames)).toBe("gone@phone");
  });

  it("names a proposal's example in words", () => {
    expect(exampleLabel("two-toasts")).toBe("Two toasts");
  });

  it("says where an outline is not measured by frame name", () => {
    const frames = frameSpecs(nook, seedLegal());
    expect(describeOutline({ frames: [], missing: [], unmeasured: ["lantern-open@desktop"] }, frames)).toBe("Not measured in Booking, room open — desktop (Lantern open).");
    expect(describeOutline({ frames: [], missing: [], unmeasured: [] }, frames)).toBe("Not drawn in any scenario.");
  });
});

describe("what is still pending", () => {
  const frames = frameSpecs(nook, seedLegal());
  const state = (states: readonly ("waiting" | "rendering" | "measured")[]) => ({
    revision: 1,
    frames,
    frameStates: Object.fromEntries(frames.map((frame, index) => [frame.key, states[index] === "measured" ? { state: "measured" as const, snapshot: { scenario: frame.scenario.id, view: frame.view.name, scrollWidth: 0, canvas: [255, 255, 255, 1] as const, elements: [] }, tags: [] } : { state: states[index] ?? ("waiting" as const) }])),
    packages: { state: "ready" as const, source: "local" },
    compileProblems: [],
    report: null,
    measured: false,
  });

  it("says how many frames have answered, are measuring now and wait their turn, and when every frame has answered that core is checking them", () => {
    expect(pendingWords(state(["measured", "measured", "rendering"]))).toBe(`Measuring the frames: 2 of ${frames.length} answered, 1 measuring now, ${frames.length - 3} waiting their turn. Rules about the rendered page wait for every frame.`);
    expect(pendingWords(state(frames.map(() => "measured")))).toBe(`Every frame has answered; core is checking the ${frames.length} snapshots.`);
  });
});
