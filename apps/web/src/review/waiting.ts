import type { Measurement } from "../app/sessions";
import { exampleLabel } from "../app/words";

/**
 * What a review page still waits for before core can judge a proposal, in
 * plain words: each example and each of the project's prototypes that has
 * not been drawn in every view, and each that could not be. The page shows
 * it when drawing failed or has made no progress for a while, beside "Check
 * again"; it decides nothing.
 */

/** One thing the page measures: one of the proposal's examples, the open prototype the board draws, or another of the project's prototypes. */
export type MeasuredThing = { readonly kind: "example" | "board" | "prototype"; readonly name: string; readonly measurement: Measurement };

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

export type Waiting = {
  /** Still being drawn: "The example “Two toasts”: 3 of 8 views drawn." */
  readonly waiting: readonly string[];
  /** Drawn, but not in every view: "The example “Two toasts” couldn't be drawn in 2 of its views: …" */
  readonly failed: readonly string[];
};

export function waitingWords(things: readonly MeasuredThing[]): Waiting {
  const waiting: string[] = [];
  const failed: string[] = [];
  for (const thing of things) {
    const { measurement } = thing;
    if (measurement.state === "measuring") waiting.push(measurement.total === 0 ? `${label(thing)}: not started yet.` : `${label(thing)}: ${measurement.answered} of ${measurement.total} views drawn.`);
    else if (measurement.state === "failed") {
      const first = measurement.problems[0];
      const count = measurement.problems.length;
      failed.push(`${label(thing)} couldn't be drawn in ${count === 1 ? "one of its views" : `${count} of its views`}${first ? `: ${first.message}` : "."}${first && !/[.!?]$/.test(first.message) ? "." : ""}`);
    }
  }
  return { waiting, failed };
}
