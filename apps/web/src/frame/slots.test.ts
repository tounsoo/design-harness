import { describe, expect, it } from "vitest";
import { nook } from "../../../../packages/core/examples/nook/project";
import { slotPlaces } from "./slots";

describe("the default shell's slot places", () => {
  it("keeps the page type's order, and trails the slots after the last body slot", () => {
    const [booking, rooms] = nook.inventories.pageTypes;
    if (!booking || !rooms) throw new Error("Nook has two page types");
    expect([...slotPlaces(booking)].map(([slot, place]) => [slot, place.order, place.trail])).toEqual([
      ["title", 0, false],
      ["facts", 1, false],
      ["body", 2, false],
      ["alternate", 3, true],
      ["action", 4, true],
    ]);
    expect([...slotPlaces(rooms).values()].some((place) => place.trail)).toBe(false);
  });
});
