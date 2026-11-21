import { describe, expect, it } from "vitest";
import type { Prototype } from "@design-harness/core";
import { seedSpec } from "../../test/nook";
import { withSpecToasts } from "../../test/proposals";
import { examplePlace } from "./example-place";

const seed = seedSpec();
const rooms = seed.files["pages/rooms.json"] ?? "";

describe("where an example screen is drawn when nothing in it is flagged", () => {
  it("is not the first scenario by default: the seed opens on the rooms list", () => {
    expect(seed.scenarios[0]).toMatchObject({ id: "rooms-list", page: "rooms" });
  });

  it("is a scenario on the page whose file the example changes, the one showing a state the proposal names", () => {
    const example = withSpecToasts(1);
    expect(examplePlace(example, [seed.files], ["booked"])).toEqual({ scenario: "lantern-booked", page: "booking" });
    // With no state named, the first scenario on that page.
    expect(examplePlace(example, [seed.files], [])).toEqual({ scenario: "lantern-open", page: "booking" });
    // A state named that the changed page never shows does not pull the screen off the page.
    expect(examplePlace(example, [seed.files], ["rooms"])).toEqual({ scenario: "lantern-open", page: "booking" });
  });

  it("reads a file as changed only when no prototype of the project has it as it is", () => {
    const other: Prototype = { ...seed, files: { ...seed.files, "pages/rooms.json": `${rooms}\n` } };
    const example: Prototype = { ...withSpecToasts(1), files: { ...withSpecToasts(1).files, "pages/rooms.json": `${rooms}\n` } };
    expect(examplePlace(example, [seed.files, other.files], [])).toEqual({ scenario: "lantern-open", page: "booking" });
    expect(examplePlace(example, [seed.files], [])).toEqual({ scenario: "rooms-list", page: "rooms" });
  });

  it("is a scenario showing a state the proposal names when no page's file changed", () => {
    expect(examplePlace(seed, [seed.files], ["held"])).toEqual({ scenario: "lantern-held", page: "booking" });
    // With no prototype to compare with, nothing is known to have changed.
    expect(examplePlace(withSpecToasts(1), [], ["held"])).toEqual({ scenario: "lantern-held", page: "booking" });
  });

  it("is nothing when nothing matches, so the caller falls back to the first scenario", () => {
    expect(examplePlace(seed, [seed.files], [])).toBeUndefined();
    expect(examplePlace(seed, [seed.files], ["no-such-state"])).toBeUndefined();
  });
});
