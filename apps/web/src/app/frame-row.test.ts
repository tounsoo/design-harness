import { describe, expect, it } from "vitest";
import { MAX_SCALE, MIN_SCALE, rowScale } from "./frame-row";

/** A desktop and a phone view, as Nook's and Tally's configs have them. */
const VIEWS = [1280, 390];

describe("the scale of a row of frames", () => {
  it("fits every view side by side in the row, gaps included", () => {
    const scale = rowScale(VIEWS, { width: 700, gap: 16, least: 0 });
    expect(scale).toBeCloseTo((700 - 16) / 1670);
    expect(1280 * scale + 390 * scale + 16).toBeLessThanOrEqual(700.001);
  });

  it("leaves a view narrower than its label the label's width, and shares the rest", () => {
    const box = { width: 500, gap: 16, least: 168 };
    const scale = rowScale(VIEWS, box);
    expect(scale).toBeCloseTo((500 - 16 - 168) / 1280);
    expect(1280 * scale + Math.max(390 * scale, box.least) + box.gap).toBeLessThanOrEqual(box.width + 0.001);
  });

  it("stacks the views when side by side would draw them under a fifth of their size: the widest then fits the row", () => {
    const scale = rowScale(VIEWS, { width: 300, gap: 16, least: 168 });
    expect(scale).toBeCloseTo(300 / 1280);
    expect(1280 * scale + 168 + 16).toBeGreaterThan(300);
  });

  it("scales one view to the row, and never past half size or under the least", () => {
    expect(rowScale([390], { width: 300, gap: 16, least: 168 })).toBe(MAX_SCALE);
    expect(rowScale([1280], { width: 320, gap: 16, least: 168 })).toBeCloseTo(0.25);
    expect(rowScale(VIEWS, { width: 4000, gap: 16, least: 168 })).toBe(MAX_SCALE);
    expect(rowScale([1280], { width: 10, gap: 0, least: 0 })).toBe(MIN_SCALE);
    expect(rowScale([], { width: 300, gap: 16, least: 168 })).toBe(MAX_SCALE);
  });
});
