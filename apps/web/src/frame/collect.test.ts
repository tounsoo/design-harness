import { describe, expect, it } from "vitest";
import { collapse, fade, parseRgb, round } from "./collect";

// The collector itself reads layout, which only a browser has: the end-to-end tests run it on real pages.
describe("the snapshot collector's arithmetic", () => {
  it("reads rgb() and rgba() as Chrome computes them, in either syntax", () => {
    expect(parseRgb("rgb(17, 20, 23)")).toEqual([17, 20, 23, 1]);
    expect(parseRgb("rgba(255, 255, 255, 0.5)")).toEqual([255, 255, 255, 0.5]);
    expect(parseRgb("rgb(10 20 30 / 25%)")).toEqual([10, 20, 30, 0.25]);
    expect(parseRgb("oklch(0.5 0.1 200)")).toBeNull();
  });

  it("fades a colour by an opacity, and rounds away float noise", () => {
    expect(fade([0, 0, 0, 0.5], 0.5)).toEqual([0, 0, 0, 0.25]);
    expect(round(12.345678)).toBe(12.35);
    expect(collapse("  Book\n   room ")).toBe("Book room");
  });
});
