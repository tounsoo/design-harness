import type { ProjectConfig, SupersededExample } from "@design-harness/core";
import { exampleLabel } from "../app/words";

/**
 * Earlier examples a change replaces, as a designer reads them. Core retires
 * an example kept from an earlier accepted change when this change moves the
 * very rule, cap or step budget the example was about (`supersededExamples`);
 * the review page says so in plain words, and core's detail stays in the
 * details for engineers.
 */

/** One replaced example: “2 primaries” (from “One primary action”). */
function one(config: ProjectConfig, entry: Pick<SupersededExample, "proposal" | "example">): string {
  const from = config.proposals.find((item) => item.id === entry.proposal)?.title ?? entry.proposal;
  return `“${exampleLabel(entry.example)}” (from “${from}”)`;
}

/**
 * "This replaces 1 example from an earlier change: “2 primaries” (from “One
 * primary action”)." `done` says it after acceptance, in the past. Empty when
 * there is none.
 */
export function replacedWords(config: ProjectConfig, entries: readonly Pick<SupersededExample, "proposal" | "example">[], done = false): string {
  if (entries.length === 0) return "";
  const proposals = new Set(entries.map((entry) => entry.proposal)).size;
  const count = entries.length === 1 ? "1 example" : `${entries.length} examples`;
  const from = proposals === 1 ? "an earlier change" : "earlier changes";
  const lead = done ? `This replaced ${count} from ${from}` : `This replaces ${count} from ${from}`;
  const why = entries.length === 1 ? (done ? "It showed the rule as it was, so it was retired." : "It shows the rule as it was, so accepting this retires it.") : done ? "They showed the rule as it was, so they were retired." : "They show the rule as it was, so accepting this retires them.";
  return `${lead}: ${entries.map((entry) => one(config, entry)).join(", ")}. ${why}`;
}
