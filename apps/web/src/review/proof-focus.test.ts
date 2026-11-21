import { describe, expect, it } from "vitest";
import { seedSpec } from "../../test/nook";
import { withSpecToasts } from "../../test/proposals";
import { bandOf, changedElements, joinBands, stageScroll, tagWithin } from "./proof-focus";

const seed = seedSpec();

describe("the part of the page an example screen is about", () => {
  it("is the band that holds every box painted", () => {
    expect(bandOf([{ x: 0, y: 40, width: 100, height: 20 }, { x: 0, y: 300, width: 100, height: 44 }, { x: 0, y: 900, width: 0, height: 0 }])).toEqual({ top: 40, bottom: 344 });
    expect(bandOf([])).toBeUndefined();
    expect(bandOf([{ x: 0, y: 10, width: 0, height: 0 }])).toBeUndefined();
  });

  it("joins the two screens' bands, and keeps the one there is", () => {
    expect(joinBands({ top: 10, bottom: 20 }, { top: 15, bottom: 60 })).toEqual({ top: 10, bottom: 60 });
    expect(joinBands(undefined, { top: 15, bottom: 60 })).toEqual({ top: 15, bottom: 60 });
    expect(joinBands(undefined, undefined)).toBeUndefined();
  });

  it("names the elements an example adds, and not the page root whose slots they joined", () => {
    expect(changedElements(withSpecToasts(2), [seed.files], "booking")).toEqual(["toast-1", "toast-2"]);
    expect(changedElements(withSpecToasts(1), [seed.files, withSpecToasts(1).files], "booking")).toEqual([]);
  });

  it("knows of no change on a page the example left alone, with nothing to compare with, or in a file that is not a spec", () => {
    expect(changedElements(withSpecToasts(2), [seed.files], "rooms")).toEqual([]);
    expect(changedElements(withSpecToasts(2), [], "booking")).toEqual([]);
    expect(changedElements({ ...seed, files: { ...seed.files, "pages/booking.json": "not json" } }, [seed.files], "booking")).toEqual([]);
    expect(changedElements(seed, [seed.files], "no-such-page")).toEqual([]);
  });

  it("reads a tag as an element's own, or a part inside it", () => {
    expect(tagWithin("details", "details")).toBe(true);
    expect(tagWithin("details/summary", "details")).toBe(true);
    expect(tagWithin("details-more", "details")).toBe(false);
  });
});

describe("how far a stage scrolls to show that part", () => {
  const stage = { height: 320, padding: 12 };

  it("stays at the top of the page when the part is in view from there", () => {
    expect(stageScroll({ top: 100, bottom: 144 }, 0.8, stage)).toBe(0);
    expect(stageScroll(undefined, 0.8, stage)).toBe(0);
  });

  it("centres a part that is below what the stage shows", () => {
    // The part is at 572 to 620 px of the stage's content, so its middle, 596, sits at the stage's middle, 160.
    expect(stageScroll({ top: 700, bottom: 760 }, 0.8, stage)).toBe(436);
  });

  it("shows the top of a part taller than the stage", () => {
    expect(stageScroll({ top: 100, bottom: 700 }, 0.8, stage)).toBe(80);
  });

  it("gives both screens of a pair the same place for the same band", () => {
    const band = { top: 640, bottom: 700 };
    expect(stageScroll(band, 0.85, stage)).toBe(stageScroll(band, 0.85, stage));
  });

  it("does nothing before the stage has a size", () => {
    expect(stageScroll({ top: 700, bottom: 760 }, 0.8, { height: 0, padding: 12 })).toBe(0);
  });
});
