import type { PageType } from "@design-harness/core";

/** Where one slot goes in the default shell: its order, whether it is in the trail, and whether the page type has it. */
export type SlotPlace = { readonly order: number; readonly trail: boolean; readonly known: boolean };

/**
 * Where each slot of a page type goes. Slots keep the page type's order. The
 * trail is every slot after the last body slot (a body slot is neither chrome
 * nor the primary slot, as core counts them), where an action page's primary
 * action and its alternates sit side by side on a wide view.
 */
export function slotPlaces(type: PageType): Map<string, SlotPlace> {
  const isBody = (slot: string) => !type.chrome.includes(slot) && !(type.kind === "action" && slot === type.primarySlot);
  const body = type.slots.map((slot, index) => (isBody(slot) ? index : -1)).filter((index) => index >= 0);
  const last = body.length > 0 ? Math.max(...body) : type.slots.length - 1;
  return new Map(type.slots.map((slot, index) => [slot, { order: index, trail: index > last, known: true }]));
}
