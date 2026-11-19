/**
 * How a row of scaled frames is sized where a card shows a page's views
 * side by side: the Variants tab. Plain arithmetic on what the row measures
 * of itself, so the stylesheet's tokens stay the one place sizes are set.
 */

/** A frame is never drawn larger than half its size here, nor smaller than a twelfth. */
export const MAX_SCALE = 0.5;
export const MIN_SCALE = 0.08;
/** Side by side, the views are never drawn smaller than a fifth of their size: below it they stack, each as wide as the row. */
export const ROW_MIN_SCALE = 0.2;

/** What a row of frames measures of itself: the width its frames share, the gap between two, and the least width an artboard takes for its label. */
export type RowBox = { readonly width: number; readonly gap: number; readonly least: number };

/**
 * The scale at which the views sit side by side in a row, as the board lays
 * a scenario's views out: each view its width at the scale, except one whose
 * label needs more, which keeps the label's width and leaves the rest to the
 * others. Below `ROW_MIN_SCALE` the views stack instead, at the scale the
 * widest fits the row.
 */
export function rowScale(widths: readonly number[], box: RowBox): number {
  if (widths.length === 0) return MAX_SCALE;
  const clamp = (scale: number) => Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale));
  const alone = clamp(box.width / Math.max(...widths));
  if (widths.length === 1) return alone;
  const room = box.width - box.gap * (widths.length - 1);
  let scaled = [...widths];
  let scale = room / scaled.reduce((sum, width) => sum + width, 0);
  // A view narrower than its label keeps the label's width; what is left is shared by the others.
  for (let pass = 0; pass < widths.length; pass += 1) {
    const next = widths.filter((width) => width * scale >= box.least);
    if (next.length === scaled.length || next.length === 0) break;
    scaled = next;
    scale = (room - box.least * (widths.length - scaled.length)) / scaled.reduce((sum, width) => sum + width, 0);
  }
  return scale >= ROW_MIN_SCALE ? clamp(scale) : alone;
}
