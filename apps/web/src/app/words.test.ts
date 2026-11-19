import { describe, expect, it } from "vitest";
import { nook } from "../../../../packages/core/examples/nook/project";
import { seedLegal } from "../../test/nook";
import { frameSpecs } from "../runtime/session";
import { describeOutline, exampleLabel, frameName, frameNameOf, scenarioName, scenarioNameOf } from "./words";

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
