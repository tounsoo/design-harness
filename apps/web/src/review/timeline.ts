import type { Proposal, ProposalContent, ProposalStatus } from "@design-harness/core";

/**
 * Who a status change or note is by when the person using the app makes it.
 * There is one user for now; the field is kept so accounts can fill it later.
 */
export const REVIEWER = "you";

/** One line of a proposal's history: a status change, a revision with the version it replaced, or a send-back with its note. */
export type TimelineEntry =
  | { readonly kind: "status"; readonly status: ProposalStatus; readonly at: string; readonly by?: string; readonly note?: string; readonly first: boolean }
  | { readonly kind: "revised"; readonly at: string; readonly by?: string; readonly note?: string; readonly previous: ProposalContent }
  | { readonly kind: "sent-back"; readonly at: string; readonly by?: string; readonly note: string };

/**
 * A proposal's whole history, oldest first: every status change from core's
 * `history` and every revision and send-back from its `events`, merged by
 * time. Entries at the same time keep their order, status changes first.
 */
export function proposalTimeline(proposal: Proposal): TimelineEntry[] {
  const entries: { entry: TimelineEntry; order: number }[] = [
    ...proposal.history.map((change, index) => ({ entry: { kind: "status" as const, ...change, first: index === 0 }, order: index })),
    ...(proposal.events ?? []).map((event, index) => ({ entry: event as TimelineEntry, order: proposal.history.length + index })),
  ];
  return entries.sort((a, b) => (a.entry.at < b.entry.at ? -1 : a.entry.at > b.entry.at ? 1 : a.order - b.order)).map((item) => item.entry);
}

const VERB: Readonly<Record<ProposalStatus, string>> = { open: "Drafted", approved: "Approved", adopted: "Adopted", declined: "Declined" };

/** The line a history entry reads as: "Drafted by agent", "Sent back by you", "Revised by agent". */
export function timelineTitle(entry: TimelineEntry): string {
  const by = entry.by ? ` by ${entry.by}` : "";
  switch (entry.kind) {
    case "status":
      return `${entry.status === "open" && !entry.first ? "Reopened" : VERB[entry.status]}${by}`;
    case "revised":
      return `Revised${by}`;
    case "sent-back":
      return `Sent back${by}`;
  }
}

/** Who drafted a proposal and when: its first history entry. */
export function draftedBy(proposal: Proposal): { readonly by: string; readonly at: string } {
  const first = proposal.history[0];
  return { by: first?.by ?? "unknown", at: first?.at ?? "" };
}

/** A time for people: the date and time in the browser's locale, from an ISO 8601 string; the string itself when it is not one. */
export function formatTime(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}
