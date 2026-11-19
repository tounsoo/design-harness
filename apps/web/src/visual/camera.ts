import type { Rect } from "@design-harness/core";

/**
 * Where "Show me" moves the canvas. An element whose longer side would be
 * under `MIN_VISIBLE_PX` on screen at the board's zoom, or whose shorter
 * side would be a sliver under `MIN_SLIVER_PX`, cannot be seen in its
 * outline, so its artboard opens at full size; anything else only scrolls
 * into view.
 */
export const MIN_VISIBLE_PX = 16;
export const MIN_SLIVER_PX = 4;

export type CameraMove = "scroll" | "open";

/** `rect` is the element's measured box in the page's CSS px, when the finding has one; `scale` is the board's zoom. */
export function cameraMove(rect: Rect | undefined, scale: number): CameraMove {
  if (!rect || scale >= 1) return "scroll";
  // A box with no size is not drawn: there is nothing to make larger.
  if (rect.width <= 0 && rect.height <= 0) return "scroll";
  const long = Math.max(rect.width, rect.height) * scale;
  const short = Math.max(1, Math.min(rect.width, rect.height)) * scale;
  return long < MIN_VISIBLE_PX || short < MIN_SLIVER_PX ? "open" : "scroll";
}
