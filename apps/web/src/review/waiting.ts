import type { Measurement } from "../app/sessions";
import { exampleLabel } from "../app/words";

/**
 * What a review page still waits for before core can judge a proposal, in
 * plain words: each example and each of the project's prototypes that has
 * not been drawn on every screen, and each that could not be. A screen is
 * one scenario in one view, which is what a frame draws and what is counted
 * here. The page shows it when drawing failed or has made no progress for a
 * while, beside "Check again"; it decides nothing.
 */

/**
 * One thing the page measures: one of the proposal's examples, the open
 * prototype the board draws, or another of the project's prototypes.
 * `screens` is how many screens it has in all, one for each scenario in
 * each view, when the page knows.
 */
export type MeasuredThing = { readonly kind: "example" | "board" | "prototype"; readonly name: string; readonly measurement: Measurement; readonly screens?: number };

function label(thing: MeasuredThing): string {
  switch (thing.kind) {
    case "example":
      return `The example “${exampleLabel(thing.name)}”`;
    case "board":
      return `Your open prototype “${thing.name}”`;
    case "prototype":
      return `Your prototype “${thing.name}”`;
  }
}

/** One line of what is waiting, in two parts so a page can set the thing's name apart: `subject` then `rest` read as the one sentence. */
export type WaitingRow = { readonly subject: string; readonly rest: string };

export type Waiting = {
  /** Still being drawn: "The example “Two toasts”: 3 of 8 screens drawn." */
  readonly waiting: readonly string[];
  /** Drawn, but not every screen: "The example “Two toasts” couldn't be drawn in 2 of its 8 screens: …" */
  readonly failed: readonly string[];
  /** The same lines, failed first, each split into the thing and what is said of it. */
  readonly rows: readonly (WaitingRow & { readonly state: "failed" | "waiting" })[];
};

/** How many of a thing's screens, counted as what they are: a screen is one scenario in one view, so a count of them is never a count of views. */
function screensOf(count: number, all: number | undefined): string {
  if (all === undefined) return count === 1 ? "one of its screens" : `${count} of its screens`;
  return `${count === 1 ? "one" : count} of its ${all} ${all === 1 ? "screen" : "screens"}`;
}

export function waitingWords(things: readonly MeasuredThing[]): Waiting {
  const waiting: WaitingRow[] = [];
  const failed: WaitingRow[] = [];
  for (const thing of things) {
    const { measurement } = thing;
    if (measurement.state === "measuring") waiting.push({ subject: label(thing), rest: measurement.total === 0 ? ": not started yet." : `: ${measurement.answered} of ${measurement.total} ${measurement.total === 1 ? "screen" : "screens"} drawn.` });
    else if (measurement.state === "failed") {
      const first = measurement.problems[0];
      failed.push({ subject: label(thing), rest: ` couldn't be drawn in ${screensOf(measurement.problems.length, thing.screens)}${first ? `: ${first.message}` : "."}${first && !/[.!?]$/.test(first.message) ? "." : ""}` });
    }
  }
  const text = (row: WaitingRow) => `${row.subject}${row.rest}`;
  return { waiting: waiting.map(text), failed: failed.map(text), rows: [...failed.map((row) => ({ ...row, state: "failed" as const })), ...waiting.map((row) => ({ ...row, state: "waiting" as const }))] };
}
