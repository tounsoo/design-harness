import { propose, type ProjectConfig, type Prototype, type ProposalDraft, type RuleSpec } from "@design-harness/core";
import { nook } from "../../../packages/core/examples/nook/project";
import { legalSnapshots } from "../../../packages/core/examples/nook/snapshots";
import { seedLegal } from "./nook";

/** Proposals over the legal Nook prototype, for the review's unit tests. */

/** The legal prototype with `count` toasts in the booking page's facts slot. */
export function withToasts(count: number, base: Prototype = seedLegal()): Prototype {
  const file = (base.files["pages/booking.tsx"] ?? "").replace('import { Button, Text } from "@tounsoo/todae";', 'import { Button, Text, Toast } from "@tounsoo/todae";').replace('<Slot name="facts">', `<Slot name="facts">${"<Toast.Root>Booked</Toast.Root>".repeat(count)}`);
  return { ...base, files: { ...base.files, "pages/booking.tsx": file } };
}

export const toastRule: RuleSpec = { type: "count", id: "one-toast-per-page", scope: "page", select: { component: "Toast.Root" }, max: 1 };

export function toastDraft(failCount = 2): ProposalDraft {
  return {
    id: "booking-toast",
    title: "A toast that confirms a booking",
    reason: "Booking needs a confirmation that does not move the page.",
    states: [{ state: "booked", note: "the toast says the room is booked" }],
    inventory: [{ op: "add-component", name: "Toast" }],
    rules: { add: [toastRule], remove: [] },
    examples: { pass: [{ name: "one-toast", prototype: withToasts(1) }], fail: [{ name: "toasts", prototype: withToasts(failCount), flaggedBy: { rule: "one-toast-per-page" } }] },
  };
}

export const harborRule: RuleSpec = { type: "rendered", id: "harbor-in-first-view", check: "first-view", action: "Open Harbor" };

export function harborDraft(): ProposalDraft {
  return {
    id: "harbor",
    title: "Keep Harbor in the first view",
    reason: "Harbor is the big room; it must not need a scroll.",
    states: [],
    inventory: [],
    rules: { add: [harborRule], remove: [] },
    examples: { pass: [{ name: "as-is", prototype: seedLegal() }], fail: [{ name: "long-intro", prototype: seedLegal(), flaggedBy: { rule: "harbor-in-first-view" } }] },
  };
}

/** Snapshots of the legal prototype with Harbor's open button below the phone's first view. */
export function harborBelowFold() {
  return legalSnapshots().map((snapshot) =>
    snapshot.scenario === "rooms-list" && snapshot.view === "phone" ? { ...snapshot, elements: snapshot.elements.map((element) => (element.name === "Open Harbor" ? { ...element, rect: { ...element.rect, y: 1200 } } : element)) } : snapshot,
  );
}

export { legalSnapshots };

/** Nook with a proposal drafted by the agent. */
export function drafted(draft: ProposalDraft = toastDraft(), config: ProjectConfig = nook): ProjectConfig {
  const result = propose(config, draft, { at: "2026-11-18T09:00:00.000Z", by: "agent" });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
