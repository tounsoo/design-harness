import {
  adopt,
  approve,
  decline,
  sendBack,
  withExampleSnapshots,
  type Adoption,
  type ExistingPrototype,
  type ProjectConfig,
  type Proposal,
  type Refusal,
  type RenderedSnapshot,
  type Result,
} from "@design-harness/core";
import { REVIEWER, ownProposal } from "./timeline";

/**
 * What the person can do to a proposal, each one deliberate click in the
 * review page and each a step of core's lifecycle, stamped with the time and
 * the reviewer. Core enforces which status may follow which; these add only
 * what the review needs on top: a decline must say why. Nothing here is
 * reachable from the agent's tools.
 */

const refuse = <T>(code: Refusal["code"], message: string): Result<T, Refusal> => ({ ok: false, error: { code, message } });

export function approveProposal(config: ProjectConfig, id: string, at: string): Result<ProjectConfig, Refusal> {
  return approve(config, id, { at, by: REVIEWER });
}

/** Declines with a note, which is required: a declined proposal is final, and its history says why. */
export function declineProposal(config: ProjectConfig, id: string, note: string, at: string): Result<ProjectConfig, Refusal> {
  const said = note.trim();
  if (said === "") return refuse("missing-note", "Say why you decline it: a declined proposal cannot change any more, and the note is what its history keeps.");
  return decline(config, id, { at, by: REVIEWER, note: said });
}

/**
 * The chat message a send-back becomes: it names the proposal and carries the
 * note, word for word. A proposal the person drafted was never the agent's to
 * get back, so there the message says whose it is and asks for the revision.
 */
export function sendBackMessage(proposal: Proposal, note: string): string {
  if (ownProposal(proposal)) return `I started proposal "${proposal.id}" (${proposal.title}) myself, and I am asking you to revise it from its review page. Revise it with revise_proposal, keeping its id. My note:\n\n${note.trim()}`;
  return `I sent proposal "${proposal.id}" (${proposal.title}) back to you from its review page. Revise it with revise_proposal, keeping its id. My note:\n\n${note.trim()}`;
}

/** Records the send-back in the proposal's history and returns the message for the agent. The status stays open. */
export function sendBackProposal(config: ProjectConfig, id: string, note: string, at: string): Result<{ readonly config: ProjectConfig; readonly message: string }, Refusal> {
  const sent = sendBack(config, id, { at, by: REVIEWER, note });
  if (!sent.ok) return sent;
  const proposal = sent.value.proposals.find((item) => item.id === id) as Proposal;
  return { ok: true, value: { config: sent.value, message: sendBackMessage(proposal, note) } };
}

/** Every example's snapshots, by example name, from frames that all answered. */
export type ExampleMeasurement = Readonly<Record<string, readonly RenderedSnapshot[]>>;

/**
 * Adopts an approved proposal on its measured examples: the snapshots are
 * stored with the examples first (core refuses a partial measurement), then
 * core's `adopt` runs on that config, so the adopted proposal keeps the
 * snapshots it was adopted on. Pure: nothing is saved unless the caller saves
 * the result.
 */
export function adoptProposal(config: ProjectConfig, id: string, measurement: ExampleMeasurement, existing: readonly ExistingPrototype[], at: string): Result<Adoption, Refusal> {
  const measured = withExampleSnapshots(config, id, measurement);
  if (!measured.ok) return measured;
  return adopt(measured.value, id, { at, by: REVIEWER }, existing);
}
