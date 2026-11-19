import { describe, expect, it } from "vitest";
import { panesAt, widthOf } from "./shell-width";

describe("the shell's width", () => {
  it("is the widest layout the window is at least as wide as", () => {
    expect(widthOf([false, false, false])).toBe("phone");
    expect(widthOf([true, false, false])).toBe("tablet");
    expect(widthOf([true, true, false])).toBe("laptop");
    expect(widthOf([true, true, true])).toBe("desktop");
  });

  it("gives a phone one pane, a tablet two and the rest three", () => {
    expect([panesAt("phone"), panesAt("tablet"), panesAt("laptop"), panesAt("desktop")]).toEqual([1, 2, 3, 3]);
  });
});
